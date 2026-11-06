package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
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
	// テナント専用の issuer を使うので、学校のテナント以外のアカウントは ID トークンの検証で弾かれる
	issuer := "https://login.microsoftonline.com/" + cfg.TenantID + "/v2.0"
	if cfg.OIDCIssuer != "" {
		issuer = cfg.OIDCIssuer // テスト用
	}
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

// ログインに失敗したときは、ログイン画面に理由を出す(ブラウザに JSON を見せない)
func loginError(c echo.Context, msg string) error {
	return c.Redirect(http.StatusFound, "/login?error="+url.QueryEscape(msg))
}

// GET /auth/callback(Microsoft からのリダイレクト先)
func (app *App) handleCallback(c echo.Context) error {
	a := app.auth
	if a.oauth == nil {
		return echo.ErrNotFound
	}
	// Microsoft 側でキャンセルされた、同意が必要、など
	if e := c.QueryParam("error"); e != "" {
		desc := c.QueryParam("error_description")
		c.Logger().Warnf("login error from Microsoft: %s %s", e, desc)
		if e == "access_denied" {
			return loginError(c, "ログインがキャンセルされました")
		}
		if strings.Contains(desc, "AADSTS65001") || strings.Contains(desc, "AADSTS90094") || e == "consent_required" {
			return loginError(c, "このアプリの利用には学校の管理者の承認が必要です。情報システム担当に連絡してください")
		}
		return loginError(c, "Microsoft でのログインに失敗しました("+e+")")
	}
	st, err := c.Cookie(stateCookie)
	if err != nil || st.Value != c.QueryParam("state") {
		return loginError(c, "ログインの有効期限が切れました。もう一度ログインしてください")
	}
	clearCookie(c, stateCookie)
	ctx := c.Request().Context()
	tok, err := a.oauth.Exchange(ctx, c.QueryParam("code"))
	if err != nil {
		c.Logger().Errorf("token exchange: %v", err)
		return loginError(c, "Microsoft からの応答を処理できませんでした。もう一度ログインしてください")
	}
	raw, _ := tok.Extra("id_token").(string)
	idt, err := a.verifier.Verify(ctx, raw)
	if err != nil {
		c.Logger().Errorf("id token verify: %v", err)
		return loginError(c, "学校の Microsoft アカウントでログインしてください")
	}
	var claims struct {
		Oid               string `json:"oid"`
		Tid               string `json:"tid"`
		Email             string `json:"email"`
		PreferredUsername string `json:"preferred_username"` // サインインに使うアカウント名(UPN)
		Name              string `json:"name"`               // 表示名(例: 山田 太郎)
	}
	if err := idt.Claims(&claims); err != nil || claims.Oid == "" {
		return loginError(c, "アカウント情報を読み取れませんでした")
	}
	if !strings.EqualFold(claims.Tid, app.cfg.TenantID) {
		return loginError(c, "学校の Microsoft アカウントでログインしてください")
	}
	// 学籍番号の判定にはサインイン名(UPN)を使う。無ければメール
	account := strings.ToLower(strings.TrimSpace(claims.PreferredUsername))
	if account == "" {
		account = strings.ToLower(strings.TrimSpace(claims.Email))
	}
	// 学校のテナントに招待された外部アカウント(ゲスト)は UPN に #EXT# が入る
	if account == "" || strings.Contains(account, "#ext#") {
		return loginError(c, "学校の Microsoft アカウントでログインしてください(ゲストアカウントは使えません)")
	}
	if !app.cfg.emailAllowed(account) {
		return loginError(c, "このアカウント("+account+")では利用できません。学校のアカウントでログインしてください")
	}
	name := strings.TrimSpace(claims.Name)
	if name == "" {
		name = account
	}
	// 名前はログインのたびに Microsoft の表示名で更新する
	u := &User{ID: claims.Oid, Email: account, Name: name, Role: roleFromEmail(account)}
	if err := app.store.UpsertUser(ctx, u); err != nil {
		c.Logger().Errorf("save user: %v", err)
		return loginError(c, "ログイン情報を保存できませんでした。もう一度ログインしてください")
	}
	log.Printf("login: %s %s(%s)", u.Role, u.Email, u.Name)
	a.setSession(c, u.ID)
	next := "/"
	if ck, err := c.Cookie(nextCookie); err == nil {
		next = safeNext(ck.Value)
	}
	clearCookie(c, nextCookie)
	return c.Redirect(http.StatusFound, next)
}

// POST /auth/dev-login
// AUTH_MODE=dev のとき、または DEV_LOGIN_PASSWORD を設定したとき(Microsoft ログインと併用・要パスワード)だけ有効
func (app *App) handleDevLogin(c echo.Context) error {
	if !app.cfg.devLoginEnabled() {
		return echo.ErrNotFound
	}
	var in struct {
		Email    string `json:"email"`
		Name     string `json:"name"`
		Password string `json:"password"`
	}
	if err := c.Bind(&in); err != nil || !strings.Contains(in.Email, "@") {
		return echo.NewHTTPError(http.StatusBadRequest, "メールアドレスを入力してください")
	}
	if app.cfg.DevLoginPassword != "" &&
		subtle.ConstantTimeCompare([]byte(in.Password), []byte(app.cfg.DevLoginPassword)) != 1 {
		time.Sleep(500 * time.Millisecond) // 総当たりを遅くする
		return echo.NewHTTPError(http.StatusUnauthorized, "開発用ログインのパスワードが違います")
	}
	email := strings.ToLower(strings.TrimSpace(in.Email))
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = email
	}
	ctx := c.Request().Context()
	// Microsoft で登録済みのメールアドレスは使わせない(本物のアカウントを乗っ取れないように。
	// また、同じメールの開発用ユーザーを作ると、Microsoft のユーザーのデータが引き継がれてしまう)
	if existing, err := app.store.GetUserByEmail(ctx, email); err == nil && !strings.HasPrefix(existing.ID, "dev:") {
		return echo.NewHTTPError(http.StatusConflict, "このメールアドレスは Microsoft アカウントで使われています。開発用ログインでは別のメールアドレス(例: sensei@example.ac.jp)を使ってください")
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	u := &User{ID: "dev:" + email, Email: email, Name: name, Role: roleFromEmail(email)}
	if err := app.store.UpsertUser(ctx, u); err != nil {
		return err
	}
	log.Printf("dev login: %s %s(%s)", u.Role, u.Email, u.Name)
	app.auth.setSession(c, u.ID)
	return c.JSON(http.StatusOK, u)
}

// POST /auth/logout
func (app *App) handleLogout(c echo.Context) error {
	clearCookie(c, sessionCookie)
	return c.JSON(http.StatusOK, map[string]bool{"ok": true})
}
