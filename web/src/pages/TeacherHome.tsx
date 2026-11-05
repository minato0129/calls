import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, slotLabel, type Room } from '../api'
import { RoomForm } from '../RoomForm'
import { useApp } from '../app-context'
import { ErrorText, Header, LogoutButton, PushCard } from '../components'

export default function TeacherHome() {
  const { user } = useApp()
  const [rooms, setRooms] = useState<Room[]>([])
  const [error, setError] = useState('')
  const [formKey, setFormKey] = useState(0)

  const load = () => api.rooms().then(setRooms).catch((e) => setError(e.message))
  useEffect(() => { void load() }, [])

  return (
    <>
      <Header title="ルーム" right={<LogoutButton />} />
      <main className="page stack">
        <p className="muted">{user?.name} 先生</p>
        <PushCard text="学生から呼び出されたときに通知を受け取れるようにします" showTest />

        <section className="stack">
          {rooms.length === 0 && <p className="muted">まだルームがありません。下のフォームから作成してください。</p>}
          {rooms.map((r) => (
            <Link key={r.id} to={`/rooms/${r.id}`} className="card room-row">
              <div>
                <div className="room-title">{r.subject}</div>
                <div className="muted">{r.className} ・ {slotLabel(r)}</div>
              </div>
              {r.isOpen ? <span className="badge live">授業中</span> : <span className="badge">待機</span>}
            </Link>
          ))}
        </section>

        <Link to="/memos" className="btn wide">メモ一覧</Link>

        <section className="card stack">
          <h2>ルームを作成</h2>
          <RoomForm
            key={formKey}
            initial={{ subject: '', className: '', dayOfWeek: 1, period: 1, periodEnd: 1 }}
            submitLabel="作成"
            onSubmit={async (v) => {
              await api.createRoom(v)
              setFormKey((k) => k + 1) // 入力欄を空に戻す
              await load()
            }}
          />
        </section>
        <ErrorText error={error} />
      </main>
    </>
  )
}
