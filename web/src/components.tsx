import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from './api'
import { useApp } from './app-context'
import { enablePush, isIOS, isStandalone, pushSupported, resyncPush } from './push'

export function Header({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      {back ? <Link to={back} className="back" aria-label="戻る">‹</Link> : <span className="back-spacer" />}
      <h1>{title}</h1>
      <div className="topbar-right">{right}</div>
    </header>
  )
}

export function LogoutButton() {
  const { setUser } = useApp()
  const nav = useNavigate()
  return (
    <button className="link-btn" onClick={async () => { await api.logout(); setUser(null); nav('/login') }}>
      ログアウト
    </button>
  )
}

// 通知の許可。許可済みなら何も出さない
export function PushCard({ text }: { text: string }) {
  const { config } = useApp()
  const [state, setState] = useState<NotificationPermission | 'unsupported'>(
    pushSupported() ? Notification.permission : 'unsupported',
  )
  const [msg, setMsg] = useState('')

  useEffect(() => { if (config) void resyncPush(config.vapidPublicKey) }, [config])

  if (state === 'granted') return null
  if (state === 'unsupported') {
    if (isIOS() && !isStandalone()) return null // iOS はホーム画面に追加してからでないと使えない(InstallCard で案内)
    return <div className="card note">この端末では通知が使えません。画面を開いたままにしてください。</div>
  }
  if (state === 'denied') {
    return <div className="card note">通知がブロックされています。端末の設定からこのアプリの通知を許可してください。</div>
  }
  return (
    <div className="card note">
      <p>{text}</p>
      <button
        className="btn primary"
        onClick={async () => {
          const r = await enablePush(config?.vapidPublicKey ?? '')
          if (r === 'ok') setState('granted')
          else if (r === 'denied') setState('denied')
          else if (r === 'no-key') setMsg('サーバー側で通知が設定されていません(VAPID鍵)')
          else setState('unsupported')
        }}
      >
        通知をオンにする
      </button>
      {msg && <p className="error">{msg}</p>}
    </div>
  )
}

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

// PWA としてホーム画面に追加するよう促す
export function InstallCard() {
  const [bip, setBip] = useState<BIPEvent | null>(null)
  const [hidden, setHidden] = useState(isStandalone())
  useEffect(() => {
    const h = (e: Event) => { e.preventDefault(); setBip(e as BIPEvent) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])
  if (hidden) return null
  if (isIOS()) {
    return (
      <div className="card note">
        <p><b>アプリとして追加してください</b></p>
        <p>Safari の共有ボタン <span aria-hidden>⬆︎</span> →「ホーム画面に追加」を選び、ホーム画面のアイコンから開き直してください。通知はアプリとして開いたときだけ届きます。</p>
      </div>
    )
  }
  if (!bip) return null
  return (
    <div className="card note">
      <p><b>アプリとして追加すると、すぐに開けて通知も届きます</b></p>
      <button className="btn primary" onClick={async () => { await bip.prompt(); setHidden(true) }}>ホーム画面に追加</button>
    </div>
  )
}

export function ErrorText({ error }: { error: string }) {
  return error ? <p className="error" role="alert">{error}</p> : null
}

export function elapsed(fromIso: string, nowMs: number) {
  const sec = Math.max(0, Math.floor((nowMs - new Date(fromIso).getTime()) / 1000))
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}
