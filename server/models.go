package main

import "time"

// テーブル定義は GORM の AutoMigrate で作る(起動時に自動)。
// 時刻はすべて UTC で保存し、表示時に JST へ変換する。

type User struct {
	ID        string    `gorm:"primaryKey;size:64" json:"id"` // Entra ID の oid(開発ログインでは "dev:メール")
	Email     string    `gorm:"size:255;not null;uniqueIndex" json:"email"`
	Name      string    `gorm:"size:255;not null" json:"name"`
	Role      string    `gorm:"type:enum('STUDENT','TEACHER');not null" json:"role"`
	CreatedAt time.Time `gorm:"type:datetime(3)" json:"-"`
}

type Room struct {
	ID        string `gorm:"primaryKey;size:32" json:"id"`
	OwnerID   string `gorm:"size:64;not null;uniqueIndex:uq_owner_slot,priority:1" json:"ownerId"`
	Owner     User   `gorm:"foreignKey:OwnerID" json:"-"`
	Subject   string `gorm:"size:255;not null" json:"subject"`
	ClassName string `gorm:"size:255;not null" json:"className"`
	DayOfWeek int    `gorm:"type:tinyint;not null;uniqueIndex:uq_owner_slot,priority:2" json:"dayOfWeek"` // 0=日 … 6=土
	Period    int    `gorm:"type:tinyint;not null;uniqueIndex:uq_owner_slot,priority:3" json:"period"`    // 開始時限
	// 終了時限(連続した複数コマのとき)。0 や Period より小さい値は 1 コマ(= Period)として扱う
	PeriodEnd int       `gorm:"type:tinyint;not null;default:0" json:"periodEnd"`
	CreatedAt time.Time `gorm:"type:datetime(3)" json:"createdAt"`

	// 先生の手動操作。時間割より優先される
	OpenUntil   *time.Time `gorm:"type:datetime(3)" json:"openUntil"`   // 「授業を開始」で、この時刻まで開く
	ClosedUntil *time.Time `gorm:"type:datetime(3)" json:"closedUntil"` // 「授業を終了」で、時間割の残りの時間も閉じる

	// ルーム削除で受講登録・呼び出し・メモも消す
	Enrollments []Enrollment `gorm:"constraint:OnDelete:CASCADE" json:"-"`
	Calls       []Call       `gorm:"constraint:OnDelete:CASCADE" json:"-"`
	Memos       []Memo       `gorm:"constraint:OnDelete:CASCADE" json:"-"`

	// DB には保存しない、レスポンス用の項目
	OwnerName string `gorm:"-" json:"ownerName"`
	IsOpen    bool   `gorm:"-" json:"isOpen"`
}

// QR を読み取った学生
type Enrollment struct {
	RoomID    string    `gorm:"primaryKey;size:32"`
	UserID    string    `gorm:"primaryKey;size:64;index"`
	User      User      `gorm:"foreignKey:UserID"`
	CreatedAt time.Time `gorm:"type:datetime(3)"`
}

type Call struct {
	ID         int64      `gorm:"primaryKey;autoIncrement"` // キューの順番は id 順
	RoomID     string     `gorm:"size:32;not null;index:idx_calls_room_status,priority:1"`
	StudentID  string     `gorm:"size:64;not null"`
	Student    User       `gorm:"foreignKey:StudentID"`
	Type       string     `gorm:"type:enum('QUESTION','CHECK');not null"`
	Status     string     `gorm:"type:enum('WAITING','DONE','CANCELLED');not null;default:WAITING;index:idx_calls_room_status,priority:2"`
	CreatedAt  time.Time  `gorm:"type:datetime(3)"`
	ResolvedAt *time.Time `gorm:"type:datetime(3)"`
}

// メモは「ルーム × 学生 × 授業日」で1枚。同じ授業で何度呼び出しても、同じメモを上書きする
type Memo struct {
	ID         int64     `gorm:"primaryKey;autoIncrement"`
	RoomID     string    `gorm:"size:32;not null;index;uniqueIndex:uq_memo_lesson,priority:1"`
	StudentID  string    `gorm:"size:64;not null;uniqueIndex:uq_memo_lesson,priority:2"`
	LessonDate string    `gorm:"type:char(10);not null;default:'';uniqueIndex:uq_memo_lesson,priority:3"` // 授業日(JST "YYYY-MM-DD")
	Student    User      `gorm:"foreignKey:StudentID"`
	CallID     *int64    `gorm:"index"` // 最後に書いたときの呼び出し
	Call       *Call     `gorm:"foreignKey:CallID;constraint:OnDelete:SET NULL"`
	Body       string    `gorm:"type:text;not null"`
	CreatedAt  time.Time `gorm:"type:datetime(3);index"`
	UpdatedAt  time.Time `gorm:"type:datetime(3)"`
}

type PushSubscription struct {
	ID        int64     `gorm:"primaryKey;autoIncrement"`
	UserID    string    `gorm:"size:64;not null;index"`
	User      User      `gorm:"foreignKey:UserID;constraint:OnDelete:CASCADE"`
	Endpoint  string    `gorm:"size:700;not null;uniqueIndex"`
	P256dh    string    `gorm:"size:255;not null"`
	Auth      string    `gorm:"size:255;not null"`
	CreatedAt time.Time `gorm:"type:datetime(3)"`
}

// 終了時限。古いルーム(period_end = 0)は 1 コマ
func (r *Room) LastPeriod() int {
	if r.PeriodEnd < r.Period {
		return r.Period
	}
	return r.PeriodEnd
}

var allModels = []any{&User{}, &Room{}, &Enrollment{}, &Call{}, &Memo{}, &PushSubscription{}}

// ---------- レスポンス用 ----------

type CallView struct {
	ID          int64     `json:"id"`
	StudentID   string    `json:"studentId"`
	StudentName string    `json:"studentName"`
	Type        string    `json:"type"` // QUESTION / CHECK
	CreatedAt   time.Time `json:"createdAt"`

	// 先生の画面用(学生には返さない)
	Memo       string `json:"memo,omitempty"`       // この授業で書いたメモ(上書きされる)
	CallsToday int    `json:"callsToday,omitempty"` // この授業での呼び出し回数(今回を含む)
}

type MemoView struct {
	ID           int64     `json:"id"`
	StudentID    string    `json:"studentId"`
	StudentName  string    `json:"studentName"`
	StudentEmail string    `json:"studentEmail"`
	CallType     *string   `json:"callType"`
	Body         string    `json:"body"`
	LessonDate   string    `json:"lessonDate"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// フロントから受け取る Push 購読情報(PushSubscription.toJSON() の形)
type PushSubInput struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}
