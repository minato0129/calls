package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/labstack/echo/v4"
	"golang.org/x/oauth2"
)

const (
	sessionCookie = "sid"
	stateCookie   = "oauth_state"
	nextCookie    = "login_next"
	sessionTTL    = 180 * 24 * time.Hour // 半期くらいはログインしたままにする
	ctxUserKey    = "user"
)

var studentLocalPart = regexp.MustCompile(`^\d{7}$`)

// メールのローカル部が7桁の数字なら学生、それ以外は先生
func roleFromEmail(email string) string {
	local, _, _ := strings.Cut(email, "@")
	if studentLocalPart.MatchString(local) {
		return "STUDENT"
	}
	return "TEACHER"
}

type Auth struct {
	cfg      *Config
	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

func newAuth(ctx context.Context, cfg *Config) (*Auth, error) {
	a := &Auth{cfg: cfg}
	if cfg.AuthMode != "microsoft" {
		return a, nil
	}
	issuer := "https://login.microsoftonline.com/" + cfg.TenantID + "/v2.0"
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return nil, fmt.Errorf("OIDC provider: %w", err)
	}
	a.oauth = &oauth2.Config{
		ClientID:     cfg.ClientID,
		ClientSecret: cfg.ClientSecret,
		Endpoint:     provider.Endpoint(),
		RedirectURL:  cfg.BaseURL + "/auth/callback",
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
	a.verifier = provider.Verifier(&oidc.Config{ClientID: cfg.ClientID})
	return a, nil
}

// ---------- session cookie (userID.expiry.hmac) ----------

func (a *Auth) sign(payload string) string {
	m := hmac.New(sha256.New, []byte(a.cfg.SessionSecret))
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func (a *Auth) setSession(c echo.Context, userID string) {
	exp := time.Now().Add(sessionTTL).Unix()
	payload := base64.RawURLEncoding.EncodeToString([]byte(userID)) + "." + strconv.FormatInt(exp, 10)
	c.SetCookie(&http.Cookie{
		Name: sessionCookie, Value: payload + "." + a.sign(payload), Path: "/",
		HttpOnly: true, Secure: strings.HasPrefix(a.cfg.BaseURL, "https://"), SameSite: http.SameSiteLaxMode,
		Expires: time.Unix(exp, 0),
	})
}

func (a *Auth) sessionUserID(c echo.Context) (string, error) {
	ck, err := c.Cookie(sessionCookie)
	if err != nil {
		return "", err
	}
	parts := strings.Split(ck.Value, ".")
	if len(parts) != 3 {
		return "", errors.New("bad session")
	}
	payload := parts[0] + "." + parts[1]
	if !hmac.Equal([]byte(a.sign(payload)), []byte(parts[2])) {
		return "", errors.New("bad signature")
	}
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", errors.New("expired")
	}
	id, err := base64.RawURLEncoding.DecodeString(parts[0])
	return string(id), err
}

func shortCookie(name, value string) *http.Cookie {
	return &http.Cookie{Name: name, Value: value, Path: "/", HttpOnly: true, MaxAge: 600, SameSite: http.SameSiteLaxMode}
}

func clearCookie(c echo.Context, name string) {
	c.SetCookie(&http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1})
}

// ログイン後の戻り先。同じサイト内のパスだけ許可する
func safeNext(s string) string {
	if strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") {
		return s
	}
	return "/"
}

// ---------- middleware ----------

// ログイン必須。ユーザーを c.Get("user") に入れる
func (app *App) requireLogin(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		id, err := app.auth.sessionUserID(c)
		if err != nil {
			return echo.NewHTTPError(http.StatusUnauthorized, "ログインしてください")
		}
		u, err := app.store.GetUser(c.Request().Context(), id)
		if err != nil {
			return echo.NewHTTPError(http.StatusUnauthorized, "ログインしてください")
		}
		c.Set(ctxUserKey, u)
		return next(c)
	}
}

func requireRole(role, msg string) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if currentUser(c).Role != role {
				return echo.NewHTTPError(http.StatusForbidden, msg)
			}
			return next(c)
		}
	}
}

func currentUser(c echo.Context) *User { return c.Get(ctxUserKey).(*User) }

// ---------- handlers ----------

// GET /auth/login
func (app *App) handleLogin(c echo.Context) error {
	next := safeNext(c.QueryParam("next"))
	a := app.auth
	if a.oauth == nil {
		return c.Redirect(http.StatusFound, "/login?next="+next)
	}
	state := newID()
	c.SetCookie(shortCookie(stateCookie, state))
	c.SetCookie(shortCookie(nextCookie, next))
	return c.Redirect(http.StatusFound, a.oauth.AuthCodeURL(state, oauth2.SetAuthURLParam("prompt", "select_account")))
}

// GET /auth/callback(Microsoft からのリダイレクト先)
func (app *App) handleCallback(c echo.Context) error {
	a := app.auth
	if a.oauth == nil {
		return echo.ErrNotFound
	}
	st, err := c.Cookie(stateCookie)
	if err != nil || st.Value != c.QueryParam("state") {
		return echo.NewHTTPError(http.StatusBadRequest, "state が一致しません。もう一度ログインしてください")
	}
	clearCookie(c, stateCookie)
	ctx := c.Request().Context()
	tok, err := a.oauth.Exchange(ctx, c.QueryParam("code"))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadGateway, "トークン取得に失敗しました")
	}
	raw, _ := tok.Extra("id_token").(string)
	idt, err := a.verifier.Verify(ctx, raw)
	if err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "ID トークンの検証に失敗しました")
	}
	var claims struct {
		Oid               string `json:"oid"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"`
		Name              string `json:"name"`
	}
	if err := idt.Claims(&claims); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "クレームを読み取れません")
	}
	email := strings.ToLower(claims.Email)
	if email == "" {
		email = strings.ToLower(claims.PreferredUsername)
	}
	u := &User{ID: claims.Oid, Email: email, Name: claims.Name, Role: roleFromEmail(email)}
	if u.Name == "" {
		u.Name = email
	}
	if err := app.store.UpsertUser(ctx, u); err != nil {
		return err
	}
	a.setSession(c, u.ID)
	next := "/"
	if ck, err := c.Cookie(nextCookie); err == nil {
		next = safeNext(ck.Value)
	}
	clearCookie(c, nextCookie)
	return c.Redirect(http.StatusFound, next)
}

// POST /auth/dev-login(AUTH_MODE=dev のときだけ有効)
func (app *App) handleDevLogin(c echo.Context) error {
	if app.cfg.AuthMode != "dev" {
		return echo.ErrNotFound
	}
	var in struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := c.Bind(&in); err != nil || !strings.Contains(in.Email, "@") {
		return echo.NewHTTPError(http.StatusBadRequest, "メールアドレスを入力してください")
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = email
	}
	u := &User{ID: "dev:" + email, Email: email, Name: name, Role: roleFromEmail(email)}
	if err := app.store.UpsertUser(c.Request().Context(), u); err != nil {
		return err
	}
	app.auth.setSession(c, u.ID)
	return c.JSON(http.StatusOK, u)
}

// POST /auth/logout
func (app *App) handleLogout(c echo.Context) error {
	clearCookie(c, sessionCookie)
	return c.JSON(http.StatusOK, map[string]bool{"ok": true})
}
