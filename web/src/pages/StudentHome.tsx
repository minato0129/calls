import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, slotLabel, type Room } from '../api'
import { useApp } from '../app-context'
import { ErrorText, Header, InstallCard, PushBanner } from '../components'
import { IconScan, IconUser } from '../icons'

export default function StudentHome() {
  const { user } = useApp()
  const [data, setData] = useState<{ rooms: Room[]; current: Room | null } | null>(null)
  const [error, setError] = useState('')

  // 先生が授業を開始したら自動でルームへ入れるよう、5秒ごとと画面に戻ったときに確認する
  useEffect(() => {
    const load = () => api.myRooms().then((d) => { setData(d); setError('') }).catch((e) => setError(e.message))
    void load()
    const t = window.setInterval(load, 5000)
    const onVisible = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [])

  // 受講中の授業が今開いていればそのままルームへ
  if (data?.current) return <Navigate to={`/rooms/${data.current.id}`} replace />

  return (
    <>
      <Header title="先生呼び出し" sub={user?.name}
        actions={<Link to="/account" className="icon-btn" aria-label="アカウント"><IconUser /></Link>} />
      <main className="page stack with-actionbar">
        <InstallCard />
        <PushBanner text="自分の番が近づいたら通知を受け取る" />

        {data && data.rooms.length === 0 && (
          <div className="empty">
            <p className="empty-title">まだ授業に参加していません</p>
            <p>授業の最初に、先生が見せる QR コードを下のボタンから読み取ってください。</p>
            <p className="hint desktop-only">PC で使うときは、先生から共有された参加用のリンクを開いても参加できます。</p>
          </div>
        )}

        {data && data.rooms.length > 0 && (
          <>
            <p className="muted">今は受講中の授業の時間ではありません。授業が始まると自動で開きます。</p>
            <ul className="list" aria-label="受講中の授業">
              {data.rooms.map((r) => (
                <li key={r.id}>
                  <Link to={`/rooms/${r.id}`} className="list-row">
                    <span className="slot">{slotLabel(r)}</span>
                    <span className="list-main">
                      <span className="list-title">{r.subject}</span>
                      <span className="list-sub">{r.className}・{r.ownerName}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        <ErrorText error={error} />
      </main>

      <div className="actionbar">
        <Link to="/scan" className="btn primary wide large"><IconScan />QR コードを読み取る</Link>
      </div>
    </>
  )
}
