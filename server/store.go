package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"time"

	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"gorm.io/gorm/logger"
)

var (
	ErrNotFound       = errors.New("not found")
	ErrAlreadyWaiting = errors.New("already waiting")
	ErrSlotTaken      = errors.New("slot taken")
)

type Store struct{ db *gorm.DB }

func openStore(dsn string) (*Store, error) {
	var (
		db  *gorm.DB
		err error
	)
	// コンテナ起動直後は MySQL がまだ立ち上がっていないことがあるので待つ
	for i := 0; i < 30; i++ {
		db, err = gorm.Open(mysql.Open(dsn), &gorm.Config{
			NowFunc:        func() time.Time { return time.Now().UTC() },
			TranslateError: true, // 重複キーを gorm.ErrDuplicatedKey にする
			Logger:         logger.Default.LogMode(logger.Warn),
		})
		if err == nil {
			break
		}
		log.Printf("DB 接続待ち: %v", err)
		time.Sleep(2 * time.Second)
	}
	if err != nil {
		return nil, err
	}
	if err := migrateMemosToLessons(db); err != nil {
		return nil, fmt.Errorf("メモの移行: %w", err)
	}
	if err := db.AutoMigrate(allModels...); err != nil {
		return nil, err
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)
	return &Store{db: db}, nil
}

// 以前は呼び出しごとにメモを作っていたので、授業日の列を足し、同じ授業日のメモを1枚にまとめる。
// AutoMigrate が一意インデックスを作る前に済ませておく必要がある(重複があると作れない)
func migrateMemosToLessons(db *gorm.DB) error {
	m := db.Migrator()
	if !m.HasTable(&Memo{}) || m.HasColumn(&Memo{}, "LessonDate") {
		return nil
	}
	log.Println("メモを授業ごとの1枚にまとめています")
	return db.Transaction(func(tx *gorm.DB) error {
		for _, q := range []string{
			`ALTER TABLE memos ADD COLUMN lesson_date CHAR(10) NOT NULL DEFAULT ''`,
			`ALTER TABLE memos ADD COLUMN updated_at DATETIME(3) NULL`,
			`UPDATE memos SET lesson_date = DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m-%d'), updated_at = created_at`,
			`SET SESSION group_concat_max_len = 1048576`,
			// 同じ授業日のメモは、本文を時刻順に改行でつないで、いちばん新しい1枚に残す
			`UPDATE memos m JOIN (
				SELECT MAX(id) AS id, GROUP_CONCAT(body ORDER BY created_at SEPARATOR '\n') AS body, MAX(created_at) AS updated
				FROM memos GROUP BY room_id, student_id, lesson_date HAVING COUNT(*) > 1
			) g ON m.id = g.id SET m.body = g.body, m.updated_at = g.updated`,
			`DELETE m FROM memos m JOIN (
				SELECT room_id, student_id, lesson_date, MAX(id) AS keep_id
				FROM memos GROUP BY room_id, student_id, lesson_date HAVING COUNT(*) > 1
			) g ON m.room_id = g.room_id AND m.student_id = g.student_id AND m.lesson_date = g.lesson_date AND m.id <> g.keep_id`,
		} {
			if err := tx.Exec(q).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

func now() time.Time { return time.Now().UTC() }

func newID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func notFound(err error) error {
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return ErrNotFound
	}
	return err
}

// ---------- users ----------

func (s *Store) UpsertUser(ctx context.Context, u *User) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		DoUpdates: clause.AssignmentColumns([]string{"email", "name", "role"}),
	}).Create(u).Error
}

func (s *Store) GetUser(ctx context.Context, id string) (*User, error) {
	var u User
	if err := s.db.WithContext(ctx).First(&u, "id = ?", id).Error; err != nil {
		return nil, notFound(err)
	}
	return &u, nil
}

// ---------- rooms ----------

func fillOwner(rooms []Room) []*Room {
	out := make([]*Room, len(rooms))
	for i := range rooms {
		rooms[i].OwnerName = rooms[i].Owner.Name
		out[i] = &rooms[i]
	}
	return out
}

// 同じ先生・同じ曜日で、時限の範囲が重なるルームを探す(exceptID は自分自身を除くため)
func overlappingRoom(tx *gorm.DB, r *Room, exceptID string) (*Room, error) {
	var rooms []Room
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("owner_id = ? AND day_of_week = ? AND id <> ?", r.OwnerID, r.DayOfWeek, exceptID).
		Find(&rooms).Error; err != nil {
		return nil, err
	}
	for i := range rooms {
		o := &rooms[i]
		if r.Period <= o.LastPeriod() && o.Period <= r.LastPeriod() {
			return o, nil
		}
	}
	return nil, nil
}

// 時限が重なるルームがあるときのエラー
type SlotTakenError struct{ Room *Room }

func (e *SlotTakenError) Error() string        { return "slot taken" }
func (e *SlotTakenError) Is(target error) bool { return target == ErrSlotTaken }

func (s *Store) CreateRoom(ctx context.Context, r *Room) error {
	r.ID = newID()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if o, err := overlappingRoom(tx, r, ""); err != nil {
			return err
		} else if o != nil {
			return &SlotTakenError{Room: o}
		}
		err := tx.Omit("Owner").Create(r).Error
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return ErrSlotTaken
		}
		return err
	})
}

// 科目名・クラス名・曜日・時限を変更する(メモや受講登録はそのまま)
func (s *Store) UpdateRoom(ctx context.Context, r *Room) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if o, err := overlappingRoom(tx, r, r.ID); err != nil {
			return err
		} else if o != nil {
			return &SlotTakenError{Room: o}
		}
		err := tx.Model(&Room{}).Where("id = ?", r.ID).Updates(map[string]any{
			"subject": r.Subject, "class_name": r.ClassName,
			"day_of_week": r.DayOfWeek, "period": r.Period, "period_end": r.PeriodEnd,
		}).Error
		if errors.Is(err, gorm.ErrDuplicatedKey) {
			return ErrSlotTaken
		}
		return err
	})
}

func (s *Store) GetRoom(ctx context.Context, id string) (*Room, error) {
	var r Room
	if err := s.db.WithContext(ctx).Preload("Owner").First(&r, "id = ?", id).Error; err != nil {
		return nil, notFound(err)
	}
	r.OwnerName = r.Owner.Name
	return &r, nil
}

func (s *Store) ListRoomsByOwner(ctx context.Context, ownerID string) ([]*Room, error) {
	var rooms []Room
	err := s.db.WithContext(ctx).Preload("Owner").
		Where("owner_id = ?", ownerID).Order("day_of_week, period").Find(&rooms).Error
	return fillOwner(rooms), err
}

func (s *Store) ListEnrolledRooms(ctx context.Context, userID string) ([]*Room, error) {
	var rooms []Room
	err := s.db.WithContext(ctx).Preload("Owner").
		Joins("JOIN enrollments e ON e.room_id = rooms.id").
		Where("e.user_id = ?", userID).Order("rooms.day_of_week, rooms.period").Find(&rooms).Error
	return fillOwner(rooms), err
}

// 手動の開始・終了を保存する(nil は解除)
func (s *Store) SetManualState(ctx context.Context, id string, openUntil, closedUntil *time.Time) error {
	return s.db.WithContext(ctx).Model(&Room{}).Where("id = ?", id).
		Updates(map[string]any{"open_until": openUntil, "closed_until": closedUntil}).Error
}

func (s *Store) DeleteRoom(ctx context.Context, id string) error {
	return s.db.WithContext(ctx).Delete(&Room{}, "id = ?", id).Error
}

func (s *Store) Enroll(ctx context.Context, roomID, userID string) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{DoNothing: true}).
		Omit("User").Create(&Enrollment{RoomID: roomID, UserID: userID}).Error
}

func (s *Store) IsEnrolled(ctx context.Context, roomID, userID string) (bool, error) {
	var n int64
	err := s.db.WithContext(ctx).Model(&Enrollment{}).
		Where("room_id = ? AND user_id = ?", roomID, userID).Count(&n).Error
	return n > 0, err
}

// ---------- calls ----------

// 待機中の呼び出しを順番(id 昇順)で返す
func (s *Store) WaitingCalls(ctx context.Context, roomID string) ([]CallView, error) {
	var calls []Call
	if err := s.db.WithContext(ctx).Preload("Student").
		Where("room_id = ? AND status = ?", roomID, "WAITING").Order("id").Find(&calls).Error; err != nil {
		return nil, err
	}
	views := make([]CallView, len(calls))
	for i, c := range calls {
		views[i] = CallView{ID: c.ID, StudentID: c.StudentID, StudentName: c.Student.Name, Type: c.Type, CreatedAt: c.CreatedAt}
	}
	return views, nil
}

func (s *Store) CreateCall(ctx context.Context, roomID, studentID, typ string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var n int64
		// 同じ学生の二重呼び出しを防ぐ(行ロック)
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Model(&Call{}).
			Where("room_id = ? AND student_id = ? AND status = ?", roomID, studentID, "WAITING").
			Count(&n).Error; err != nil {
			return err
		}
		if n > 0 {
			return ErrAlreadyWaiting
		}
		return tx.Omit("Student").Create(&Call{RoomID: roomID, StudentID: studentID, Type: typ, Status: "WAITING"}).Error
	})
}

func (s *Store) CancelMyCall(ctx context.Context, roomID, studentID string) (bool, error) {
	res := s.db.WithContext(ctx).Model(&Call{}).
		Where("room_id = ? AND student_id = ? AND status = ?", roomID, studentID, "WAITING").
		Updates(map[string]any{"status": "CANCELLED", "resolved_at": now()})
	return res.RowsAffected > 0, res.Error
}

// 対応済にする。メモはこの授業(lessonDate)の1枚に上書き保存し、空にしたら削除する
func (s *Store) FinishCall(ctx context.Context, roomID string, callID int64, memo, lessonDate string) error {
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var c Call
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			First(&c, "id = ? AND room_id = ? AND status = ?", callID, roomID, "WAITING").Error; err != nil {
			return notFound(err)
		}
		t := now()
		if err := tx.Model(&c).Updates(map[string]any{"status": "DONE", "resolved_at": t}).Error; err != nil {
			return err
		}
		if memo == "" {
			return tx.Where("room_id = ? AND student_id = ? AND lesson_date = ?", roomID, c.StudentID, lessonDate).
				Delete(&Memo{}).Error
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "room_id"}, {Name: "student_id"}, {Name: "lesson_date"}},
			DoUpdates: clause.AssignmentColumns([]string{"body", "call_id", "updated_at"}),
		}).Omit("Student", "Call").Create(&Memo{
			RoomID: roomID, StudentID: c.StudentID, LessonDate: lessonDate, CallID: &c.ID, Body: memo, CreatedAt: t, UpdatedAt: t,
		}).Error
	})
}

// 先頭の学生について、この授業のメモと呼び出し回数を埋める(先生の画面用)
func (s *Store) FillLessonInfo(ctx context.Context, roomID, lessonDate string, lessonStart time.Time, calls []CallView) error {
	if len(calls) == 0 {
		return nil
	}
	ids := make([]string, len(calls))
	for i, c := range calls {
		ids[i] = c.StudentID
	}
	var memos []Memo
	if err := s.db.WithContext(ctx).Where("room_id = ? AND lesson_date = ? AND student_id IN ?", roomID, lessonDate, ids).
		Find(&memos).Error; err != nil {
		return err
	}
	var counts []struct {
		StudentID string
		N         int
	}
	if err := s.db.WithContext(ctx).Model(&Call{}).Select("student_id, COUNT(*) AS n").
		Where("room_id = ? AND student_id IN ? AND created_at >= ? AND status <> ?", roomID, ids, lessonStart, "CANCELLED").
		Group("student_id").Scan(&counts).Error; err != nil {
		return err
	}
	memoBy := map[string]string{}
	for _, m := range memos {
		memoBy[m.StudentID] = m.Body
	}
	countBy := map[string]int{}
	for _, c := range counts {
		countBy[c.StudentID] = c.N
	}
	for i := range calls {
		calls[i].Memo = memoBy[calls[i].StudentID]
		calls[i].CallsToday = countBy[calls[i].StudentID]
	}
	return nil
}

func (s *Store) RoomsWithWaitingCalls(ctx context.Context) ([]string, error) {
	var ids []string
	err := s.db.WithContext(ctx).Model(&Call{}).Where("status = ?", "WAITING").Distinct().Pluck("room_id", &ids).Error
	return ids, err
}

func (s *Store) CancelAllWaiting(ctx context.Context, roomID string) error {
	return s.db.WithContext(ctx).Model(&Call{}).
		Where("room_id = ? AND status = ?", roomID, "WAITING").
		Updates(map[string]any{"status": "CANCELLED", "resolved_at": now()}).Error
}

// ---------- memos ----------

// date は授業日(JST "YYYY-MM-DD")。空なら全件
func (s *Store) ListMemos(ctx context.Context, roomID, date string) ([]MemoView, error) {
	q := s.db.WithContext(ctx).Joins("Student").Preload("Call").Where("memos.room_id = ?", roomID)
	if date != "" {
		q = q.Where("memos.lesson_date = ?", date)
	}
	var memos []Memo
	if err := q.Order("memos.lesson_date DESC, Student.email").Find(&memos).Error; err != nil {
		return nil, err
	}
	views := make([]MemoView, len(memos))
	for i, m := range memos {
		v := MemoView{ID: m.ID, StudentID: m.StudentID, StudentName: m.Student.Name, StudentEmail: m.Student.Email,
			Body: m.Body, LessonDate: m.LessonDate, CreatedAt: m.CreatedAt, UpdatedAt: m.UpdatedAt}
		if m.Call != nil {
			t := m.Call.Type
			v.CallType = &t
		}
		views[i] = v
	}
	return views, nil
}

func (s *Store) MemoDates(ctx context.Context, roomID string) ([]string, error) {
	dates := []string{}
	err := s.db.WithContext(ctx).Model(&Memo{}).Where("room_id = ?", roomID).
		Distinct().Order("lesson_date DESC").Pluck("lesson_date", &dates).Error
	return dates, err
}

// ---------- push subscriptions ----------

func (s *Store) SavePushSub(ctx context.Context, userID string, in *PushSubInput) error {
	return s.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "endpoint"}},
		DoUpdates: clause.AssignmentColumns([]string{"user_id", "p256dh", "auth"}),
	}).Omit("User").Create(&PushSubscription{UserID: userID, Endpoint: in.Endpoint, P256dh: in.Keys.P256dh, Auth: in.Keys.Auth}).Error
}

func (s *Store) PushSubs(ctx context.Context, userID string) ([]PushSubscription, error) {
	var subs []PushSubscription
	err := s.db.WithContext(ctx).Where("user_id = ?", userID).Find(&subs).Error
	return subs, err
}

func (s *Store) DeletePushSub(ctx context.Context, endpoint string) error {
	return s.db.WithContext(ctx).Where("endpoint = ?", endpoint).Delete(&PushSubscription{}).Error
}
