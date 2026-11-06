package main

import (
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/labstack/echo/v4"
)

// ---------- routes ----------

func (app *App) routes(e *echo.Echo) {
	login := app.requireLogin
	teacher := requireRole("TEACHER", "先生のみ利用できます")
	student := requireRole("STUDENT", "学生のみ利用できます")

	e.GET("/auth/login", app.handleLogin)
	e.GET("/auth/callback", app.handleCallback)
	e.POST("/auth/dev-login", app.handleDevLogin)
	e.POST("/auth/logout", app.handleLogout)

	api := e.Group("/api")
	api.GET("/config", app.handleConfig)
	api.GET("/me", func(c echo.Context) error { return c.JSON(http.StatusOK, currentUser(c)) }, login)

	// 先生
	api.GET("/rooms", app.handleListRooms, login, teacher)
	api.POST("/rooms", app.handleCreateRoom, login, teacher)
	api.PATCH("/rooms/:id", app.handleUpdateRoom, login, teacher)
	api.DELETE("/rooms/:id", app.handleDeleteRoom, login, teacher)
	api.POST("/rooms/:id/calls/:callId/done", app.handleFinishCall, login, teacher)
	api.POST("/rooms/:id/ack", app.handleAck, login, teacher)
	api.POST("/rooms/:id/open", app.handleOpenRoom, login, teacher)
	api.POST("/rooms/:id/close", app.handleCloseRoom, login, teacher)
	api.GET("/rooms/:id/memos", app.handleListMemos, login, teacher)
	api.GET("/rooms/:id/memo-dates", app.handleMemoDates, login, teacher)
	api.GET("/rooms/:id/memos.csv", app.handleMemosCSV, login, teacher)

	// 先生・学生共通
	api.GET("/rooms/:id", app.handleGetRoom, login)
	api.GET("/rooms/:id/queue", app.handleQueue, login)
	api.GET("/rooms/:id/events", app.handleEvents, login)

	// 学生
	api.POST("/join", app.handleJoin, login, student)
	api.GET("/my/rooms", app.handleMyRooms, login, student)
	api.POST("/rooms/:id/calls", app.handleCreateCall, login, student)
	api.DELETE("/rooms/:id/calls/mine", app.handleCancelCall, login, student)

	// Push
	api.POST("/push/subscribe", app.handlePushSubscribe, login)
	api.POST("/push/test", app.handlePushTest, login)
}

// エラーはすべて {"error": "..."} で返す(フロントがこの形を前提にしている)
func errorHandler(err error, c echo.Context) {
	if c.Response().Committed {
		return
	}
	code, msg := http.StatusInternalServerError, "サーバーエラーが発生しました"
	var he *echo.HTTPError
	if errors.As(err, &he) {
		code = he.Code
		if s, ok := he.Message.(string); ok {
			msg = s
		} else {
			msg = http.StatusText(code)
		}
	} else {
		c.Logger().Error(err)
	}
	_ = c.JSON(code, map[string]string{"error": msg})
}

// ---------- helpers ----------

func (app *App) withOpen(r *Room) *Room {
	r.PeriodEnd = r.LastPeriod() // 古いルーム(0)も、レスポンスでは終了時限を入れて返す
	r.IsOpen = app.cfg.roomOpen(r, time.Now())
	return r
}

func (app *App) loadRoom(c echo.Context) (*Room, error) {
	room, err := app.store.GetRoom(c.Request().Context(), c.Param("id"))
	if errors.Is(err, ErrNotFound) {
		return nil, echo.NewHTTPError(http.StatusNotFound, "ルームが見つかりません")
	}
	if err != nil {
		return nil, err
	}
	return app.withOpen(room), nil
}

// ルームのオーナー(先生)のみ
func (app *App) ownerRoom(c echo.Context) (*Room, error) {
	room, err := app.loadRoom(c)
	if err != nil {
		return nil, err
	}
	if room.OwnerID != currentUser(c).ID {
		return nil, echo.NewHTTPError(http.StatusForbidden, "このルームの先生ではありません")
	}
	return room, nil
}

// オーナーか受講登録済みの学生
func (app *App) memberRoom(c echo.Context) (*Room, error) {
	room, err := app.loadRoom(c)
	if err != nil {
		return nil, err
	}
	u := currentUser(c)
	if room.OwnerID == u.ID {
		return room, nil
	}
	ok, err := app.store.IsEnrolled(c.Request().Context(), room.ID, u.ID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, echo.NewHTTPError(http.StatusForbidden, "このルームに参加していません。QRコードを読み取ってください")
	}
	return room, nil
}

func (app *App) handleConfig(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]any{
		"authMode":              app.cfg.AuthMode,
		"devLogin":              app.cfg.devLoginEnabled(), // 開発用ログインを出すか
		"devLoginNeedsPassword": app.cfg.DevLoginPassword != "",
		"vapidPublicKey":        app.cfg.VapidPublic,
		"periods":               app.cfg.Periods,
	})
}

// ---------- teacher ----------

func (app *App) handleListRooms(c echo.Context) error {
	rooms, err := app.store.ListRoomsByOwner(c.Request().Context(), currentUser(c).ID)
	if err != nil {
		return err
	}
	for _, r := range rooms {
		app.withOpen(r)
	}
	sortRooms(rooms)
	return c.JSON(http.StatusOK, rooms)
}

// 授業中のルームを一番上に、それ以外は月曜1限から順に並べる(日曜は最後)
func sortRooms(rooms []*Room) {
	weekday := func(dow int) int {
		if dow == 0 {
			return 7 // 日曜は土曜のあと
		}
		return dow
	}
	sort.SliceStable(rooms, func(i, j int) bool {
		a, b := rooms[i], rooms[j]
		if a.IsOpen != b.IsOpen {
			return a.IsOpen
		}
		if weekday(a.DayOfWeek) != weekday(b.DayOfWeek) {
			return weekday(a.DayOfWeek) < weekday(b.DayOfWeek)
		}
		if a.Period != b.Period {
			return a.Period < b.Period
		}
		return a.Subject < b.Subject
	})
}

type roomInput struct {
	Subject   string `json:"subject"`
	ClassName string `json:"className"`
	DayOfWeek int    `json:"dayOfWeek"`
	Period    int    `json:"period"`    // 開始時限
	PeriodEnd int    `json:"periodEnd"` // 終了時限。省略(0)なら開始時限と同じ
}

// 入力を検証して Room の項目に反映する
func (app *App) applyRoomInput(c echo.Context, r *Room) error {
	var in roomInput
	if err := c.Bind(&in); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "入力が不正です")
	}
	in.Subject, in.ClassName = strings.TrimSpace(in.Subject), strings.TrimSpace(in.ClassName)
	if in.PeriodEnd == 0 {
		in.PeriodEnd = in.Period
	}
	_, okStart := app.cfg.period(in.Period)
	_, okEnd := app.cfg.period(in.PeriodEnd)
	if in.Subject == "" || in.ClassName == "" || in.DayOfWeek < 0 || in.DayOfWeek > 6 || !okStart || !okEnd {
		return echo.NewHTTPError(http.StatusBadRequest, "科目名・クラス名・曜日・時限を正しく入力してください")
	}
	if in.PeriodEnd < in.Period {
		return echo.NewHTTPError(http.StatusBadRequest, "終了の時限は開始の時限以降にしてください")
	}
	r.Subject, r.ClassName, r.DayOfWeek, r.Period, r.PeriodEnd = in.Subject, in.ClassName, in.DayOfWeek, in.Period, in.PeriodEnd
	return nil
}

func slotTakenError(err error) error {
	var st *SlotTakenError
	if errors.As(err, &st) {
		o := st.Room
		return echo.NewHTTPError(http.StatusConflict,
			fmt.Sprintf("時間が重なるルームがあります(%s: %s)", slotLabel(o.DayOfWeek, o.Period, o.LastPeriod()), o.Subject))
	}
	return echo.NewHTTPError(http.StatusConflict, "時間が重なるルームがあります")
}

func slotLabel(dow, first, last int) string {
	days := []string{"日", "月", "火", "水", "木", "金", "土"}
	if first == last {
		return fmt.Sprintf("%s曜 %d限", days[dow], first)
	}
	return fmt.Sprintf("%s曜 %d〜%d限", days[dow], first, last)
}

func (app *App) handleCreateRoom(c echo.Context) error {
	u := currentUser(c)
	room := &Room{OwnerID: u.ID, OwnerName: u.Name}
	if err := app.applyRoomInput(c, room); err != nil {
		return err
	}
	if err := app.store.CreateRoom(c.Request().Context(), room); errors.Is(err, ErrSlotTaken) {
		return slotTakenError(err)
	} else if err != nil {
		return err
	}
	return c.JSON(http.StatusCreated, app.withOpen(room))
}

// PATCH /api/rooms/:id 科目名・クラス名・曜日・時限の変更。メモ・受講登録・QR はそのまま
func (app *App) handleUpdateRoom(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	if err := app.applyRoomInput(c, room); err != nil {
		return err
	}
	if err := app.store.UpdateRoom(c.Request().Context(), room); errors.Is(err, ErrSlotTaken) {
		return slotTakenError(err)
	} else if err != nil {
		return err
	}
	app.hub.publish(room.ID) // 開いている画面に開閉の変化を伝える
	return c.JSON(http.StatusOK, app.withOpen(room))
}

func (app *App) handleDeleteRoom(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	if err := app.store.DeleteRoom(c.Request().Context(), room.ID); err != nil {
		return err
	}
	app.notifier.Ack(room.ID)
	app.hub.publish(room.ID)
	return c.NoContent(http.StatusNoContent)
}

func (app *App) handleFinishCall(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	callID, err := strconv.ParseInt(c.Param("callId"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "不正な呼び出しIDです")
	}
	var in struct {
		Memo string `json:"memo"`
	}
	_ = c.Bind(&in)
	if err := app.store.FinishCall(c.Request().Context(), room.ID, callID, strings.TrimSpace(in.Memo), app.cfg.lessonDate(time.Now())); errors.Is(err, ErrNotFound) {
		return echo.NewHTTPError(http.StatusConflict, "この呼び出しはすでに終了しています")
	} else if err != nil {
		return err
	}
	app.notifier.QueueChanged(room.ID, reasonDone)
	return c.NoContent(http.StatusNoContent)
}

// 手動で開始したときに開いておく長さ(1コマ分 + 余裕)
const manualOpenDuration = 100 * time.Minute

// POST /api/rooms/:id/open 「授業を開始」。時間割に関係なく、今から 100 分間開く
func (app *App) handleOpenRoom(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	until := now().Add(manualOpenDuration)
	if err := app.store.SetManualState(c.Request().Context(), room.ID, &until, nil); err != nil {
		return err
	}
	room.OpenUntil, room.ClosedUntil = &until, nil
	app.hub.publish(room.ID) // 学生の画面を更新させる
	return c.JSON(http.StatusOK, app.withOpen(room))
}

// POST /api/rooms/:id/close 「授業を終了」。時間割上の授業中なら、その時限が終わるまで閉じたままにする
func (app *App) handleCloseRoom(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	ctx := c.Request().Context()
	var closedUntil *time.Time
	if end, ok := app.cfg.scheduledEnd(room.DayOfWeek, room.Period, room.LastPeriod(), time.Now()); ok {
		closedUntil = &end
	}
	if err := app.store.SetManualState(ctx, room.ID, nil, closedUntil); err != nil {
		return err
	}
	// 残っている呼び出しは取り消す
	if err := app.store.CancelAllWaiting(ctx, room.ID); err != nil {
		return err
	}
	room.OpenUntil, room.ClosedUntil = nil, closedUntil
	app.notifier.QueueChanged(room.ID, reasonClosed) // SSE の通知も含む
	return c.JSON(http.StatusOK, app.withOpen(room))
}

func (app *App) handleAck(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	app.notifier.Ack(room.ID)
	return c.NoContent(http.StatusNoContent)
}

func (app *App) handleListMemos(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	memos, err := app.store.ListMemos(c.Request().Context(), room.ID, c.QueryParam("date"))
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, memos)
}

func (app *App) handleMemoDates(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	dates, err := app.store.MemoDates(c.Request().Context(), room.ID)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, dates)
}

func (app *App) handleMemosCSV(c echo.Context) error {
	room, err := app.ownerRoom(c)
	if err != nil {
		return err
	}
	memos, err := app.store.ListMemos(c.Request().Context(), room.ID, "")
	if err != nil {
		return err
	}
	w := c.Response()
	w.Header().Set(echo.HeaderContentType, "text/csv; charset=utf-8")
	w.Header().Set(echo.HeaderContentDisposition, `attachment; filename="memos-`+room.ID+`.csv"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("\xEF\xBB\xBF")) // Excel で文字化けしないよう BOM を付ける
	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"授業日", "最終更新", "学籍メール", "氏名", "種別", "メモ"})
	for _, m := range memos {
		typ := ""
		if m.CallType != nil {
			typ = map[string]string{"QUESTION": "質問", "CHECK": "課題チェック"}[*m.CallType]
		}
		_ = cw.Write([]string{m.LessonDate, m.UpdatedAt.In(app.cfg.Loc).Format("2006-01-02 15:04"), m.StudentEmail, m.StudentName, typ, m.Body})
	}
	cw.Flush()
	return cw.Error()
}

// ---------- shared ----------

func (app *App) handleGetRoom(c echo.Context) error {
	room, err := app.memberRoom(c)
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, room)
}

type queueCounts struct {
	Total    int `json:"total"`
	Question int `json:"question"`
	Check    int `json:"check"`
}

func (app *App) handleQueue(c echo.Context) error {
	room, err := app.memberRoom(c)
	if err != nil {
		return err
	}
	calls, err := app.store.WaitingCalls(c.Request().Context(), room.ID)
	if err != nil {
		return err
	}
	var cnt queueCounts
	cnt.Total = len(calls)
	for _, cl := range calls {
		if cl.Type == "QUESTION" {
			cnt.Question++
		} else {
			cnt.Check++
		}
	}
	u := currentUser(c)
	if room.OwnerID == u.ID {
		// 先生には先頭2人まで
		head := calls
		if len(head) > 2 {
			head = head[:2]
		}
		// この授業で書いたメモと呼び出し回数を付ける(2回目以降は前のメモを上書きする)
		t := time.Now()
		if err := app.store.FillLessonInfo(c.Request().Context(), room.ID, app.cfg.lessonDate(t), app.cfg.dayStart(t), head); err != nil {
			return err
		}
		return c.JSON(http.StatusOK, map[string]any{"counts": cnt, "head": head, "isOpen": room.IsOpen, "serverTime": time.Now().UTC()})
	}
	// 学生には自分の順番だけ(他の学生の名前は見せない)
	position, myType := 0, ""
	for i, cl := range calls {
		if cl.StudentID == u.ID {
			position, myType = i+1, cl.Type
			break
		}
	}
	return c.JSON(http.StatusOK, map[string]any{"counts": cnt, "position": position, "myType": myType, "isOpen": room.IsOpen})
}

// ---------- student ----------

func (app *App) handleJoin(c echo.Context) error {
	var in struct {
		RoomID string `json:"roomId"`
	}
	if err := c.Bind(&in); err != nil || in.RoomID == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "QRコードが不正です")
	}
	ctx := c.Request().Context()
	room, err := app.store.GetRoom(ctx, in.RoomID)
	if errors.Is(err, ErrNotFound) {
		return echo.NewHTTPError(http.StatusNotFound, "ルームが見つかりません")
	} else if err != nil {
		return err
	}
	if err := app.store.Enroll(ctx, room.ID, currentUser(c).ID); err != nil {
		return err
	}
	return c.JSON(http.StatusOK, app.withOpen(room))
}

// 受講中のルーム一覧と、今開いているルーム
func (app *App) handleMyRooms(c echo.Context) error {
	rooms, err := app.store.ListEnrolledRooms(c.Request().Context(), currentUser(c).ID)
	if err != nil {
		return err
	}
	var current *Room
	for _, r := range rooms {
		app.withOpen(r)
		if r.IsOpen && current == nil {
			current = r
		}
	}
	sortRooms(rooms)
	return c.JSON(http.StatusOK, map[string]any{"rooms": rooms, "current": current})
}

func (app *App) handleCreateCall(c echo.Context) error {
	room, err := app.memberRoom(c)
	if err != nil {
		return err
	}
	if !room.IsOpen {
		return echo.NewHTTPError(http.StatusConflict, "授業時間外です")
	}
	var in struct {
		Type string `json:"type"`
	}
	if err := c.Bind(&in); err != nil || (in.Type != "QUESTION" && in.Type != "CHECK") {
		return echo.NewHTTPError(http.StatusBadRequest, "呼び出しの種類が不正です")
	}
	if err := app.store.CreateCall(c.Request().Context(), room.ID, currentUser(c).ID, in.Type); errors.Is(err, ErrAlreadyWaiting) {
		return echo.NewHTTPError(http.StatusConflict, "すでに呼び出し中です")
	} else if err != nil {
		return err
	}
	app.notifier.QueueChanged(room.ID, reasonCalled)
	return c.NoContent(http.StatusCreated)
}

func (app *App) handleCancelCall(c echo.Context) error {
	room, err := app.memberRoom(c)
	if err != nil {
		return err
	}
	changed, err := app.store.CancelMyCall(c.Request().Context(), room.ID, currentUser(c).ID)
	if err != nil {
		return err
	}
	if changed {
		app.notifier.QueueChanged(room.ID, reasonCancelled)
	}
	return c.NoContent(http.StatusNoContent)
}

// ---------- push ----------

func (app *App) handlePushSubscribe(c echo.Context) error {
	var in PushSubInput
	if err := c.Bind(&in); err != nil || in.Endpoint == "" || in.Keys.P256dh == "" || in.Keys.Auth == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "購読情報が不正です")
	}
	if err := app.store.SavePushSub(c.Request().Context(), currentUser(c).ID, &in); err != nil {
		return err
	}
	return c.NoContent(http.StatusNoContent)
}

// POST /api/push/test 自分の端末にテスト通知を送り、結果を返す
func (app *App) handlePushTest(c echo.Context) error {
	if !app.push.enabled() {
		return echo.NewHTTPError(http.StatusConflict, "サーバーに VAPID 鍵が設定されていません(.env の VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)")
	}
	res, err := app.push.SendSync(c.Request().Context(), currentUser(c).ID, Notification{
		Title: "テスト通知",
		Body:  "通知は正しく届いています",
		URL:   "/",
		Kind:  "test",
	})
	if err != nil {
		return err
	}
	return c.JSON(http.StatusOK, res)
}
