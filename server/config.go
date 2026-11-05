package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata" // コンテナに tzdata が無くても Asia/Tokyo を使えるように
)

type Period struct {
	No    int    `json:"no"`
	Start string `json:"start"` // "09:10"
	End   string `json:"end"`   // "10:40"
}

type Config struct {
	Addr             string
	DSN              string
	BaseURL          string // 例: https://call.example.ac.jp (OIDC のリダイレクト先に使う)
	SessionSecret    string
	AuthMode         string // "dev" or "microsoft"
	TenantID         string
	ClientID         string
	ClientSecret     string
	VapidPublic      string
	VapidPrivate     string
	VapidSubject     string
	ForceOpen        bool // true なら時間割に関係なく全ルームを開いている扱いにする(開発用)
	RenotifyInterval time.Duration
	Periods          []Period
	Loc              *time.Location
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadConfig() (*Config, error) {
	loc, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		return nil, err
	}
	c := &Config{
		Addr:          env("ADDR", ":8080"),
		DSN:           env("DATABASE_DSN", "callsys:callsys@tcp(127.0.0.1:3306)/callsys"),
		BaseURL:       strings.TrimRight(env("BASE_URL", "http://localhost:8080"), "/"),
		SessionSecret: env("SESSION_SECRET", "dev-secret-change-me"),
		AuthMode:      env("AUTH_MODE", "dev"),
		TenantID:      os.Getenv("AZURE_TENANT_ID"),
		ClientID:      os.Getenv("AZURE_CLIENT_ID"),
		ClientSecret:  os.Getenv("AZURE_CLIENT_SECRET"),
		VapidPublic:   os.Getenv("VAPID_PUBLIC_KEY"),
		VapidPrivate:  os.Getenv("VAPID_PRIVATE_KEY"),
		// webpush-go が自動で "mailto:" を付けるので、ここでは外しておく(二重になると Apple に拒否される)
		VapidSubject: strings.TrimPrefix(env("VAPID_SUBJECT", "admin@example.com"), "mailto:"),
		ForceOpen:    env("FORCE_OPEN", "false") == "true",
		Loc:          loc,
	}
	sec, err := strconv.Atoi(env("RENOTIFY_SECONDS", "180"))
	if err != nil || sec <= 0 {
		return nil, fmt.Errorf("RENOTIFY_SECONDS が不正です")
	}
	c.RenotifyInterval = time.Duration(sec) * time.Second
	// UTC 保存・UTC 読み出しを強制する
	if !strings.Contains(c.DSN, "?") {
		c.DSN += "?"
	} else {
		c.DSN += "&"
	}
	c.DSN += "parseTime=true&loc=UTC&time_zone=%27%2B00%3A00%27&charset=utf8mb4"

	periods, err := parsePeriods(env("PERIODS", "1=09:10-10:40,2=10:50-12:20,3=13:10-14:40,4=14:50-16:20,5=16:30-18:00"))
	if err != nil {
		return nil, err
	}
	c.Periods = periods
	if c.AuthMode == "microsoft" && (c.TenantID == "" || c.ClientID == "" || c.ClientSecret == "") {
		return nil, fmt.Errorf("AUTH_MODE=microsoft には AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET が必要です")
	}
	return c, nil
}

// "1=09:10-10:40,2=10:50-12:20"
func parsePeriods(s string) ([]Period, error) {
	var ps []Period
	for _, item := range strings.Split(s, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		noStr, rng, ok := strings.Cut(item, "=")
		start, end, ok2 := strings.Cut(rng, "-")
		no, err := strconv.Atoi(noStr)
		if !ok || !ok2 || err != nil {
			return nil, fmt.Errorf("PERIODS の形式が不正です: %q", item)
		}
		ps = append(ps, Period{No: no, Start: start, End: end})
	}
	return ps, nil
}

func hm(s string) int {
	h, m, _ := strings.Cut(s, ":")
	hi, _ := strconv.Atoi(h)
	mi, _ := strconv.Atoi(m)
	return hi*60 + mi
}

func (c *Config) period(no int) (Period, bool) {
	for _, p := range c.Periods {
		if p.No == no {
			return p, true
		}
	}
	return Period{}, false
}

// 開始時限〜終了時限の、その日の開始・終了時刻(JST の分)。間の休み時間も含む
func (c *Config) slotMinutes(first, last int) (start, end int, ok bool) {
	pf, ok1 := c.period(first)
	pl, ok2 := c.period(last)
	if !ok1 || !ok2 {
		return 0, 0, false
	}
	return hm(pf.Start), hm(pl.End), true
}

// 時間割どおりなら授業中か(複数コマのときは、間の休み時間も授業中とみなす)
func (c *Config) scheduledOpen(dow, first, last int, now time.Time) bool {
	if c.ForceOpen {
		return true
	}
	start, end, ok := c.slotMinutes(first, last)
	if !ok {
		return false
	}
	lt := now.In(c.Loc)
	min := lt.Hour()*60 + lt.Minute()
	return int(lt.Weekday()) == dow && min >= start && min < end
}

// 今が時間割上の授業中なら、最後の時限の終了時刻を返す
func (c *Config) scheduledEnd(dow, first, last int, now time.Time) (time.Time, bool) {
	if !c.scheduledOpen(dow, first, last, now) {
		return time.Time{}, false
	}
	_, endMin, ok := c.slotMinutes(first, last)
	if !ok {
		return time.Time{}, false
	}
	lt := now.In(c.Loc)
	end := time.Date(lt.Year(), lt.Month(), lt.Day(), endMin/60, endMin%60, 0, 0, c.Loc)
	if !end.After(now) {
		return time.Time{}, false
	}
	return end.UTC(), true
}

// ルームが今開いているか。先生の手動操作(開始・終了)が時間割より優先される
func (c *Config) roomOpen(r *Room, now time.Time) bool {
	if r.ClosedUntil != nil && now.Before(*r.ClosedUntil) {
		return false
	}
	if r.OpenUntil != nil && now.Before(*r.OpenUntil) {
		return true
	}
	return c.scheduledOpen(r.DayOfWeek, r.Period, r.LastPeriod(), now)
}
