package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
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
	if err := db.AutoMigrate(allModels...); err != nil {
		return nil, err
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetConnMaxLifetime(5 * time.Minute)
	return &Store{db: db}, nil
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

func (s *Store) CreateRoom(ctx context.Context, r *Room) error {
	r.ID = newID()
	err := s.db.WithContext(ctx).Omit("Owner").Create(r).Error
	if errors.Is(err, gorm.ErrDuplicatedKey) {
		return ErrSlotTaken
	}
	return err
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

// 対応済にする。メモが空でなければ保存する
func (s *Store) FinishCall(ctx context.Context, roomID string, callID int64, memo string) error {
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
			return nil
		}
		return tx.Omit("Student", "Call").Create(&Memo{RoomID: roomID, StudentID: c.StudentID, CallID: &c.ID, Body: memo, CreatedAt: t}).Error
	})
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

// date は JST の "YYYY-MM-DD"。空なら全件
func (s *Store) ListMemos(ctx context.Context, roomID, date string) ([]MemoView, error) {
	q := s.db.WithContext(ctx).Joins("Student").Preload("Call").Where("memos.room_id = ?", roomID)
	if date != "" {
		q = q.Where("DATE(CONVERT_TZ(memos.created_at, '+00:00', '+09:00')) = ?", date)
	}
	var memos []Memo
	if err := q.Order("Student.email, memos.created_at").Find(&memos).Error; err != nil {
		return nil, err
	}
	views := make([]MemoView, len(memos))
	for i, m := range memos {
		v := MemoView{ID: m.ID, StudentID: m.StudentID, StudentName: m.Student.Name, StudentEmail: m.Student.Email, Body: m.Body, CreatedAt: m.CreatedAt}
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
	err := s.db.WithContext(ctx).Raw(`
		SELECT DISTINCT DATE_FORMAT(CONVERT_TZ(created_at, '+00:00', '+09:00'), '%Y-%m-%d') AS d
		FROM memos WHERE room_id = ? ORDER BY d DESC`, roomID).Scan(&dates).Error
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
