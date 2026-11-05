import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, slotLabel, type Room } from '../api'
import { useApp } from '../app-context'
import { ErrorText, Header, InstallCard, LogoutButton, PushCard } from '../components'

export default function StudentHome() {
  const { user } = useApp()
  const [data, setData] = useState<{ rooms: Room[]; current: Room | null } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.myRooms().then(setData).catch((e) => setError(e.message))
  }, [])

  // 受講中の授業が今開いていればそのままルームへ
  if (data?.current) return <Navigate to={`/rooms/${data.current.id}`} replace />

  return (
    <>
      <Header title="先生呼び出し" right={<LogoutButton />} />
      <main className="page stack">
        <p className="muted">{user?.name}</p>
        <InstallCard />
        <PushCard text="自分の番が近づいたときに通知を受け取れるようにします" />

        <div className="card stack center">
          <p>{data && data.rooms.length > 0 ? '今は受講中の授業の時間ではありません。' : 'まだ授業に参加していません。'}</p>
          <p className="muted small">授業の最初に、先生が表示するQRコードを読み取ってください</p>
          <Link to="/scan" className="btn primary wide">QRコードを読み取る</Link>
        </div>

        {data && data.rooms.length > 0 && (
          <section className="stack-sm">
            <h2>受講中の授業</h2>
            {data.rooms.map((r) => (
              <div key={r.id} className="card room-row">
                <div>
                  <div className="room-title">{r.subject}</div>
                  <div className="muted small">{r.className} ・ {slotLabel(r)} ・ {r.ownerName}</div>
                </div>
              </div>
            ))}
          </section>
        )}
        <ErrorText error={error} />
      </main>
    </>
  )
}
