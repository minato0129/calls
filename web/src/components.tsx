import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api } from './api'
import { useApp } from './app-context'
import { IconBack, IconMemo, IconRooms, IconUser } from './icons'
import { enablePush, isIOS, isStandalone, pushSupported, pushUnsupportedReason, resyncPush, sendTestPush } from './push'

// ---------- 画面の枠 ----------

// 上部のバー。タイトルは左寄せ、右側にアイコンのボタンを置く
export function Header({ title, sub, back, actions }: { title: string; sub?: ReactNode; back?: string; actions?: ReactNode }) {
  return (
    <header className="topbar">
      {back && <Link to={back} className="icon-btn" aria-label="戻る"><IconBack /></Link>}
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="topbar-actions">{actions}</div>}
    </header>
  )
}

export function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="icon-btn" aria-label={label} title={label} onClick={onClick}>{children}</button>
}

// 先生の画面のメニュー。スマホでは画面の下のタブ、PC では左のサイドバーになる
// desktopOnly: スマホではタブを出さない画面(ルームの中など)でも、PC ではサイドバーを出す
export function TabBar({ desktopOnly = false }: { desktopOnly?: boolean }) {
  const { user } = useApp()
  const { pathname } = useLocation()
  // サイドバーの分だけ画面を右にずらす(styles.css の body.has-sidenav)
  useEffect(() => {
    document.body.classList.add('has-sidenav')
    return () => document.body.classList.remove('has-sidenav')
  }, [])
  const tab = (to: string, label: string, icon: ReactNode, active: boolean) => (
    <NavLink to={to} className={`tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
      {icon}<span>{label}</span>
    </NavLink>
  )
  return (
    <nav className={`tabbar ${desktopOnly ? 'desktop-only' : ''}`} aria-label="メニュー">
      <div className="sidenav-brand" aria-hidden>
        <img src="/icon-192.png" alt="" width={32} height={32} />
        <span>先生呼び出し</span>
      </div>
      {tab('/', 'ルーム', <IconRooms />, pathname === '/' || pathname.startsWith('/rooms/'))}
      {tab('/memos', 'メモ', <IconMemo />, pathname === '/memos')}
      {tab('/account', 'アカウント', <IconUser />, pathname === '/account')}
      {user && <p className="sidenav-user">{user.name} 先生</p>}
    </nav>
  )
}

// 下から出てくるシート。背景のタップと Esc で閉じる
export function Sheet({ title, onClose, children }: { title?: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    document.body.classList.add('no-scroll')
    ref.current?.focus()
    return () => { document.removeEventListener('keydown', onKey); document.body.classList.remove('no-scroll') }
  }, [onClose])
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-handle" aria-hidden />
        {title && <h2 className="sheet-title">{title}</h2>}
        {children}
      </div>
    </div>
  )
}

// 「…」から開くメニュー(下から出る操作の一覧)
export interface MenuItem { label: string; icon?: ReactNode; danger?: boolean; onSelect: () => void }
export function MenuSheet({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return (
    <Sheet onClose={onClose}>
      <div className="menu">
        {items.map((it) => (
          <button key={it.label} type="button" className={`menu-item ${it.danger ? 'danger' : ''}`} onClick={() => { onClose(); it.onSelect() }}>
            {it.icon}{it.label}
          </button>
        ))}
        <button type="button" className="menu-item cancel" onClick={onClose}>閉じる</button>
      </div>
    </Sheet>
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

// ---------- 通知 ----------

type PushState = NotificationPermission | 'unsupported'

function usePushState() {
  const { config } = useApp()
  const [state, setState] = useState<PushState>(pushSupported() ? Notification.permission : 'unsupported')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (config) void resyncPush(config.vapidPublicKey) }, [config])
  const enable = async () => {
    setMsg('')
    setBusy(true)
    try {
      const r = await enablePush(config?.vapidPublicKey ?? '')
      if (r === 'ok') setState('granted')
      else if (r === 'denied') setState('denied')
      else if (r === 'no-key') setMsg('サーバーで通知が設定されていません(.env の VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY)')
      else setState('unsupported')
    } catch (e) {
      // Brave のように購読がブラウザ設定で止められている場合などはここに来る
      setMsg(`通知の登録に失敗しました: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  return { state, msg, busy, enable }
}

// 画面の上に出す細い案内。通知がまだオフのときだけ出す(ブロック・非対応の説明はアカウント画面)
export function PushBanner({ text }: { text: string }) {
  const { state, msg, busy, enable } = usePushState()
  if (state !== 'default') return null
  return (
    <div className="banner">
      <p>{text}</p>
      <button type="button" className="btn small primary" disabled={busy} onClick={() => void enable()}>オンにする</button>
      {msg && <p className="error banner-error">{msg}</p>}
    </div>
  )
}

// アカウント画面の「通知」の欄。状態に応じて、オンにする・テスト・直し方を出す
export function PushSettings() {
  const { config } = useApp()
  const { state, msg, busy, enable } = usePushState()
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      let r = await sendTestPush()
      if (r.sent === 0 && r.removed > 0) {
        // この端末の登録が無効(鍵の変更など)だった。今の鍵で登録し直して、もう一度送る
        await enablePush(config?.vapidPublicKey ?? '')
        r = await sendTestPush()
      }
      if (r.sent > 0) setResult({ ok: true, text: `送信しました(${r.sent}台)。数秒で通知が届けば正常です` })
      else if (r.removed > 0) setResult({ ok: false, text: '端末の登録が無効になっていました。アプリを開き直して、もう一度試してください' })
      else if (r.errors.length > 0) setResult({ ok: false, text: `送信に失敗しました: ${r.errors.join(' / ')}` })
      else setResult({ ok: false, text: 'この端末の通知がサーバーに登録されていません。アプリを開き直してください' })
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <section className="group">
      <h2 className="group-title">通知</h2>
      <div className="group-body">
        {state === 'granted' && (
          <>
            <div className="group-row"><span>この端末の通知</span><span className="status-on">オン</span></div>
            <button type="button" className="group-row action" disabled={testing} onClick={() => void test()}>
              {testing ? '送信中…' : 'テスト通知を送る'}
            </button>
            {result && <p className={`group-note ${result.ok ? '' : 'error'}`}>{result.text}</p>}
          </>
        )}
        {state === 'default' && (
          <>
            <div className="group-row"><span>この端末の通知</span><span className="muted">オフ</span></div>
            <button type="button" className="group-row action" disabled={busy} onClick={() => void enable()}>通知をオンにする</button>
          </>
        )}
        {state === 'denied' && (
          <p className="group-note">通知がブロックされています。端末の設定でこのアプリの通知を許可してください。</p>
        )}
        {state === 'unsupported' && (
          <p className="group-note">{pushUnsupportedReason() ?? 'この端末では通知が使えません。'}</p>
        )}
        {msg && <p className="group-note error">{msg}</p>}
      </div>
    </section>
  )
}

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

// ホーム画面に追加するよう促す(アプリとして開いているときは出さない)
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
      <div className="banner tall">
        <p><b>ホーム画面に追加してください</b><br />Safari の共有ボタンから「ホーム画面に追加」を選び、追加したアイコンから開くと通知が届きます。</p>
      </div>
    )
  }
  if (!bip) return null
  return (
    <div className="banner">
      <p>ホーム画面に追加すると、すぐ開けて通知も届きます</p>
      <button type="button" className="btn small primary" onClick={async () => { await bip.prompt(); setHidden(true) }}>追加</button>
    </div>
  )
}

export function LogoutButton() {
  const { setUser } = useApp()
  const nav = useNavigate()
  return (
    <button type="button" className="btn wide" onClick={async () => { await api.logout(); setUser(null); nav('/login') }}>
      ログアウト
    </button>
  )
}
