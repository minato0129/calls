package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
	"github.com/labstack/echo/v4"
)

// ================= SSE hub =================
// ルームごとに購読者を持ち、キューが変わったら "queue" イベントを送る。
// 中身は送らず、クライアントは受け取ったら GET /queue で取り直す(権限ごとに見える内容が違うため)

type Hub struct {
	mu   sync.Mutex
	subs map[string]map[chan struct{}]struct{}
}

func newHub() *Hub { return &Hub{subs: map[string]map[chan struct{}]struct{}{}} }

func (h *Hub) subscribe(roomID string) chan struct{} {
	ch := make(chan struct{}, 1)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.subs[roomID] == nil {
		h.subs[roomID] = map[chan struct{}]struct{}{}
	}
	h.subs[roomID][ch] = struct{}{}
	return ch
}

func (h *Hub) unsubscribe(roomID string, ch chan struct{}) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs[roomID], ch)
	if len(h.subs[roomID]) == 0 {
		delete(h.subs, roomID)
	}
}

func (h *Hub) publish(roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for ch := range h.subs[roomID] {
		select {
		case ch <- struct{}{}:
		default: // 未処理の通知が既にあるならまとめる
		}
	}
}

// GET /api/rooms/:id/events
func (app *App) handleEvents(c echo.Context) error {
	room, err := app.memberRoom(c)
	if err != nil {
		return err
	}
	w := c.Response()
	w.Header().Set(echo.HeaderContentType, "text/event-stream")
	w.Header().Set(echo.HeaderCacheControl, "no-cache")
	w.Header().Set("X-Accel-Buffering", "no") // nginx にバッファさせない
	w.WriteHeader(http.StatusOK)

	ch := app.hub.subscribe(room.ID)
	defer app.hub.unsubscribe(room.ID, ch)

	_, _ = w.Write([]byte("event: queue\ndata: {}\n\n"))
	w.Flush()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-c.Request().Context().Done():
			return nil
		case <-ch:
			_, _ = w.Write([]byte("event: queue\ndata: {}\n\n"))
		case <-heartbeat.C:
			_, _ = w.Write([]byte(": ping\n\n"))
		}
		w.Flush()
	}
}

// ================= Web Push =================

type Notification struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Kind  string `json:"kind"` // teacher-call / your-turn
}

type Pusher struct {
	cfg   *Config
	store *Store
}

func (p *Pusher) enabled() bool { return p.cfg.VapidPublic != "" && p.cfg.VapidPrivate != "" }

func (p *Pusher) Send(userID string, n Notification) {
	if !p.enabled() {
		log.Printf("[push disabled] to=%s %s: %s", userID, n.Title, n.Body)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		subs, err := p.store.PushSubs(ctx, userID)
		if err != nil {
			log.Printf("push: list subs: %v", err)
			return
		}
		payload, _ := json.Marshal(n)
		for _, s := range subs {
			resp, err := webpush.SendNotificationWithContext(ctx, payload, &webpush.Subscription{
				Endpoint: s.Endpoint,
				Keys:     webpush.Keys{P256dh: s.P256dh, Auth: s.Auth},
			}, &webpush.Options{
				Subscriber:      p.cfg.VapidSubject,
				VAPIDPublicKey:  p.cfg.VapidPublic,
				VAPIDPrivateKey: p.cfg.VapidPrivate,
				TTL:             120,
				Urgency:         webpush.UrgencyHigh,
			})
			if err != nil {
				log.Printf("push: send: %v", err)
				continue
			}
			resp.Body.Close()
			// 購読が無効になっていたら消す
			if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
				_ = p.store.DeletePushSub(ctx, s.Endpoint)
			} else if resp.StatusCode >= 300 {
				log.Printf("push: status %d for %s", resp.StatusCode, userID)
			}
		}
	}()
}

// ================= 通知ロジック =================
//
// 先生向け:
//   - 待機人数が 0→1 になったら通知し、確認済みフラグを false にする
//   - 確認済みになるまで 3 分ごと(RENOTIFY_SECONDS)に再通知する
//   - 先生のアプリが前面に来たら(POST /ack)確認済みにして止める
//   - 待機人数が 0 になったらリセット
// 学生向け:
//   - 先生が先頭の人を「対応済」にしたら、新しく先頭になった人に「次があなたの番です」

type roomNotifyState struct {
	count int
	ack   bool
	timer *time.Timer
}

type Notifier struct {
	app   *App
	mu    sync.Mutex
	rooms map[string]*roomNotifyState
}

func newNotifier(app *App) *Notifier {
	return &Notifier{app: app, rooms: map[string]*roomNotifyState{}}
}

type changeReason int

const (
	reasonCalled changeReason = iota
	reasonCancelled
	reasonDone
	reasonClosed
)

func (n *Notifier) QueueChanged(roomID string, reason changeReason) {
	defer n.app.hub.publish(roomID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	calls, err := n.app.store.WaitingCalls(ctx, roomID)
	if err != nil {
		log.Printf("notifier: %v", err)
		return
	}
	room, err := n.app.store.GetRoom(ctx, roomID)
	if err != nil {
		return
	}

	n.mu.Lock()
	st := n.rooms[roomID]
	if st == nil {
		st = &roomNotifyState{}
		n.rooms[roomID] = st
	}
	prev := st.count
	st.count = len(calls)
	if st.count == 0 {
		if st.timer != nil {
			st.timer.Stop()
		}
		delete(n.rooms, roomID)
	} else if prev == 0 {
		st.ack = false
		n.scheduleLocked(roomID, st)
	}
	n.mu.Unlock()

	if prev == 0 && len(calls) > 0 {
		n.notifyTeacher(room, calls[0])
	}
	if reason == reasonDone && len(calls) > 0 {
		n.app.push.Send(calls[0].StudentID, Notification{
			Title: room.Subject,
			Body:  "次があなたの番です。準備をしてください",
			URL:   "/rooms/" + room.ID,
			Kind:  "your-turn",
		})
	}
}

func (n *Notifier) scheduleLocked(roomID string, st *roomNotifyState) {
	if st.timer != nil {
		st.timer.Stop()
	}
	st.timer = time.AfterFunc(n.app.cfg.RenotifyInterval, func() { n.renotify(roomID) })
}

func (n *Notifier) renotify(roomID string) {
	n.mu.Lock()
	st := n.rooms[roomID]
	if st == nil || st.ack || st.count == 0 {
		n.mu.Unlock()
		return
	}
	n.scheduleLocked(roomID, st)
	n.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	calls, err := n.app.store.WaitingCalls(ctx, roomID)
	if err != nil || len(calls) == 0 {
		return
	}
	room, err := n.app.store.GetRoom(ctx, roomID)
	if err != nil {
		return
	}
	n.notifyTeacher(room, calls[0])
}

func (n *Notifier) notifyTeacher(room *Room, head CallView) {
	label := "質問"
	if head.Type == "CHECK" {
		label = "課題チェック"
	}
	n.app.push.Send(room.OwnerID, Notification{
		Title: room.Subject + " " + room.ClassName,
		Body:  head.StudentName + "からの呼び出し(" + label + ")",
		URL:   "/rooms/" + room.ID,
		Kind:  "teacher-call",
	})
}

// 先生のアプリが前面に来たとき
func (n *Notifier) Ack(roomID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if st := n.rooms[roomID]; st != nil {
		st.ack = true
		if st.timer != nil {
			st.timer.Stop()
			st.timer = nil
		}
	}
}

// 起動時に DB 上の待機状態を読み込む(サーバー再起動で通知状態が消えるため)
func (n *Notifier) Restore(ctx context.Context) {
	ids, err := n.app.store.RoomsWithWaitingCalls(ctx)
	if err != nil {
		log.Printf("restore: %v", err)
		return
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, id := range ids {
		calls, err := n.app.store.WaitingCalls(ctx, id)
		if err != nil || len(calls) == 0 {
			continue
		}
		// 再起動前に先生が見ていたかは分からないので、確認済み扱いにして再通知はしない
		n.rooms[id] = &roomNotifyState{count: len(calls), ack: true}
	}
}

// 授業時間が終わったルームに残った呼び出しを1分ごとに片付ける
func (n *Notifier) RunCloser(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			ids, err := n.app.store.RoomsWithWaitingCalls(ctx)
			if err != nil {
				continue
			}
			for _, id := range ids {
				room, err := n.app.store.GetRoom(ctx, id)
				if err != nil || n.app.cfg.roomOpen(room, time.Now()) {
					continue
				}
				if err := n.app.store.CancelAllWaiting(ctx, id); err == nil {
					n.QueueChanged(id, reasonClosed)
				}
			}
		}
	}
}
