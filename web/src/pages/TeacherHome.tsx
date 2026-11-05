import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, DAYS, slotLabel, type Room } from '../api'
import { useApp } from '../app-context'
import { ErrorText, Header, LogoutButton, PushCard } from '../components'

export default function TeacherHome() {
  const { user, config } = useApp()
  const [rooms, setRooms] = useState<Room[]>([])
  const [error, setError] = useState('')
  const [form, setForm] = useState({ subject: '', className: '', dayOfWeek: 1, period: 1 })
  const [creating, setCreating] = useState(false)

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

        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault()
            setError('')
            setCreating(true)
            try {
              await api.createRoom(form)
              setForm({ ...form, subject: '', className: '' })
              await load()
            } catch (err) { setError((err as Error).message) } finally { setCreating(false) }
          }}
        >
          <h2>ルームを作成</h2>
          <label>科目名
            <input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="IoT制作" />
          </label>
          <label>クラス名
            <input required value={form.className} onChange={(e) => setForm({ ...form, className: e.target.value })} placeholder="IE2A" />
          </label>
          <div className="row">
            <label>曜日
              <select value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: Number(e.target.value) })}>
                {[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{DAYS[d]}曜</option>)}
              </select>
            </label>
            <label>時限
              <select value={form.period} onChange={(e) => setForm({ ...form, period: Number(e.target.value) })}>
                {config?.periods.map((p) => <option key={p.no} value={p.no}>{p.no}限 ({p.start}〜{p.end})</option>)}
              </select>
            </label>
          </div>
          <button className="btn primary wide" disabled={creating}>作成</button>
          <ErrorText error={error} />
        </form>
      </main>
    </>
  )
}
