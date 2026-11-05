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

// SSE でキューの変化を受け取り、そのたびに onChange を呼ぶ
export function useRoomEvents(roomId: string | undefined, onChange: () => void) {
  const cb = useRef(onChange)
  cb.current = onChange
  useEffect(() => {
    if (!roomId) return
    let es: EventSource | null = null
    let retry: number | undefined
    const connect = () => {
      es = new EventSource(`/api/rooms/${roomId}/events`)
      es.addEventListener('queue', () => cb.current())
      es.onerror = () => {
        es?.close()
        retry = window.setTimeout(connect, 3000)
      }
    }
    connect()
    // スマホはバックグラウンドで接続が切れるので、前面に戻ったら取り直す
    const onVisible = () => { if (document.visibilityState === 'visible') cb.current() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      es?.close()
      window.clearTimeout(retry)
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
