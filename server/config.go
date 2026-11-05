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
		VapidSubject:  env("VAPID_SUBJECT", "mailto:admin@example.com"),
		ForceOpen:     env("FORCE_OPEN", "false") == "true",
		Loc:           loc,
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

// 現在の曜日と時限(JST)。授業時間外なら ok=false
func (c *Config) currentSlot(t time.Time) (dow, period int, ok bool) {
	lt := t.In(c.Loc)
	min := lt.Hour()*60 + lt.Minute()
	for _, p := range c.Periods {
		if min >= hm(p.Start) && min < hm(p.End) {
			return int(lt.Weekday()), p.No, true
		}
	}
	return int(lt.Weekday()), 0, false
}

func (c *Config) isOpen(dow, period int, now time.Time) bool {
	if c.ForceOpen {
		return true
	}
	d, p, ok := c.currentSlot(now)
	return ok && d == dow && p == period
}
