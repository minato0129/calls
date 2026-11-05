import { useEffect, useMemo, useState } from 'react'
import { api, CALL_LABEL, slotLabel, type Memo, type Room } from '../api'
import { ErrorText, Header } from '../components'

// 科目(ルーム)と日付で切り替え、学生ごとにまとめて表示する
export default function Memos() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState('')
  const [dates, setDates] = useState<string[]>([])
  const [date, setDate] = useState('')
  const [memos, setMemos] = useState<Memo[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    api.rooms().then((rs) => { setRooms(rs); if (rs[0]) setRoomId(rs[0].id) }).catch((e) => setError(e.message))
  }, [])
  useEffect(() => {
    if (!roomId) return
    api.memoDates(roomId).then((ds) => { setDates(ds); setDate(ds[0] ?? '') }).catch((e) => setError(e.message))
  }, [roomId])
  useEffect(() => {
    if (!roomId || !date) { setMemos([]); return }
    api.memos(roomId, date).then(setMemos).catch((e) => setError(e.message))
  }, [roomId, date])

  const byStudent = useMemo(() => {
    const m = new Map<string, Memo[]>()
    for (const memo of memos) m.set(memo.studentId, [...(m.get(memo.studentId) ?? []), memo])
    return [...m.values()]
  }, [memos])

  return (
    <>
      <Header title="メモ一覧" back="/" />
      <main className="page stack">
        <div className="row">
          <label>科目
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
              {rooms.map((r) => <option key={r.id} value={r.id}>{r.subject}({r.className} {slotLabel(r)})</option>)}
            </select>
          </label>
          <label>日付
            <select value={date} onChange={(e) => setDate(e.target.value)} disabled={dates.length === 0}>
              {dates.length === 0 && <option value="">メモなし</option>}
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        </div>
        {roomId && <a className="btn wide" href={`/api/rooms/${roomId}/memos.csv`}>この科目のメモをCSVで保存</a>}
        <ErrorText error={error} />

        {byStudent.length === 0 && <p className="center muted pad">メモはありません</p>}
        {byStudent.map((list) => (
          <section key={list[0].studentId} className="card stack-sm">
            <div>
              <div className="room-title">{list[0].studentName}</div>
              <div className="muted small">{list[0].studentEmail}</div>
            </div>
            {list.map((m) => (
              <div key={m.id} className="memo">
                <span className="muted small">
                  {new Date(m.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                  {m.callType && ` ・ ${CALL_LABEL[m.callType]}`}
                </span>
                <p>{m.body}</p>
              </div>
            ))}
          </section>
        ))}
      </main>
    </>
  )
}
