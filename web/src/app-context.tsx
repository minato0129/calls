import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, ApiError, type AppConfig, type User } from './api'

interface Ctx {
  user: User | null
  config: AppConfig | null
  loading: boolean
  setUser: (u: User | null) => void
}

const AppCtx = createContext<Ctx>({ user: null, config: null, loading: true, setUser: () => undefined })

export function AppProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      api.config().then(setConfig),
      api.me().then(setUser).catch((e) => { if (!(e instanceof ApiError && e.status === 401)) throw e }),
    ]).finally(() => setLoading(false))
  }, [])

  return <AppCtx.Provider value={{ user, config, loading, setUser }}>{children}</AppCtx.Provider>
}

export const useApp = () => useContext(AppCtx)

// SSE が何も届かない状態がこれだけ続いたら、止まっているとみなして定期的に取り直す
// (サーバーは 15 秒ごとに ping を送るので、正常ならこれを超えることはない)
const SSE_STALE_MS = 35_000
const FALLBACK_POLL_MS = 3_000

// キューの変化を受け取り、そのたびに onChange を呼ぶ。
// 基本は SSE。トンネルやプロキシが SSE を溜め込んで届かないときは、3 秒ごとの取得に切り替える
export function useRoomEvents(roomId: string | undefined, onChange: () => void) {
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    if (!roomId) return
    let es: EventSource | null = null
    let retry: number | undefined
    let lastMessage = 0 // まだ一度も届いていない
    const connect = () => {
      es = new EventSource(`/api/rooms/${roomId}/events`)
      es.addEventListener('queue', () => { lastMessage = Date.now(); cb.current() })
      es.addEventListener('ping', () => { lastMessage = Date.now() })
      es.onerror = () => {
        es?.close()
        retry = window.setTimeout(connect, 3000)
      }
    }
    // SSE を待たずに、まず今の状態を読み込む
    cb.current()
    connect()
    const startedAt = Date.now()
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      const healthy = lastMessage > 0 && Date.now() - lastMessage < SSE_STALE_MS
      // 接続直後の数秒は SSE の最初のメッセージを待つ
      if (!healthy && Date.now() - startedAt >= FALLBACK_POLL_MS - 100) cb.current()
    }, FALLBACK_POLL_MS)
    // スマホはバックグラウンドで接続が切れるので、前面に戻ったら取り直す
    const onVisible = () => { if (document.visibilityState === 'visible') cb.current() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      es?.close()
      window.clearTimeout(retry)
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [roomId])
}

// 1秒ごとに再描画(経過時間の表示用)
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
