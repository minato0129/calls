package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

type App struct {
	cfg      *Config
	store    *Store
	auth     *Auth
	hub      *Hub
	push     *Pusher
	notifier *Notifier
}

func main() {
	genVapid := flag.Bool("genvapid", false, "VAPID 鍵を生成して表示する")
	flag.Parse()
	if *genVapid {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("VAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\n", pub, priv)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	store, err := openStore(cfg.DSN)
	if err != nil {
		log.Fatalf("DB に接続できません: %v", err)
	}
	auth, err := newAuth(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}
	app := &App{cfg: cfg, store: store, auth: auth, hub: newHub(), push: &Pusher{cfg: cfg, store: store}}
	app.notifier = newNotifier(app)
	app.notifier.Restore(ctx)
	go app.notifier.RunCloser(ctx)

	if !app.push.enabled() {
		log.Println("VAPID 鍵が未設定のため Web Push は無効です(-genvapid で生成できます)")
	}
	if cfg.AuthMode == "dev" {
		log.Println("AUTH_MODE=dev: 開発用ログインが有効です。本番では使わないでください")
	} else {
		log.Printf("Microsoft ログイン: tenant=%s redirect=%s/auth/callback allowed_domains=%v", cfg.TenantID, cfg.BaseURL, cfg.AllowedDomains)
		if cfg.DevLoginPassword != "" {
			log.Println("DEV_LOGIN_PASSWORD が設定されているため、開発用ログインも使えます(テスト用。本番では外してください)")
			if len(cfg.DevLoginPassword) < 12 {
				log.Println("注意: DEV_LOGIN_PASSWORD が短すぎます。公開している URL では12文字以上にしてください")
			}
		}
	}

	e := echo.New()
	e.HideBanner = true
	e.HTTPErrorHandler = errorHandler
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit("1M"))
	e.Use(middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		LogMethod: true, LogURI: true, LogStatus: true, LogLatency: true,
		LogValuesFunc: func(c echo.Context, v middleware.RequestLoggerValues) error {
			log.Printf("%s %s %d %s", v.Method, v.URI, v.Status, v.Latency.Round(time.Millisecond))
			return nil
		},
	}))
	app.routes(e)

	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = e.Shutdown(shutdown)
	}()
	log.Printf("listening on %s", cfg.Addr)
	if err := e.Start(cfg.Addr); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
