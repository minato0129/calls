import { useEffect, useState } from 'react'
import { api, CALL_LABEL, type Memo, type Room } from '../api'
import { ErrorText, Header, TabBar } from '../components'
import { IconDownload } from '../icons'

// 授業(ルーム)と日付で切り替える。メモは授業ごとに1人1枚
export default function Memos() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState('')
  const [dates, setDates] = useState<string[]>([])
  const [date, setDate] = useState('')
  const [memos, setMemos] = useState<Memo[] | null>(null)
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
    setMemos(null)
    api.memos(roomId, date).then(setMemos).catch((e) => setError(e.message))
  }, [roomId, date])

  return (
    <>
      <Header title="メモ"
        actions={roomId ? <a className="icon-btn" href={`/api/rooms/${roomId}/memos.csv`} aria-label="この授業のメモを CSV で保存" title="CSV で保存"><IconDownload /></a> : undefined} />
      <div className="filters">
        <select value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label="授業">
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.subject} {r.className}</option>)}
        </select>
        <select value={date} onChange={(e) => setDate(e.target.value)} disabled={dates.length === 0} aria-label="日付">
          {dates.length === 0 && <option value="">メモなし</option>}
          {dates.map((d) => <option key={d} value={d}>{formatDate(d)}</option>)}
        </select>
      </div>
      <main className="page stack with-tabbar">
        <ErrorText error={error} />
        {memos && memos.length === 0 && (
          <div className="empty"><p>{rooms.length === 0 ? 'ルームを作ると、ここに授業ごとのメモが並びます。' : 'この授業のメモはまだありません。対応済にするときに書いたメモがここに並びます。'}</p></div>
        )}
        {memos && memos.length > 0 && (
          <ul className="list memos" aria-label="メモ">
            {memos.map((m) => (
              <li key={m.id} className="memo">
                <div className="memo-head">
                  <span className="memo-name">{m.studentName}</span>
                  <span className="memo-time">{new Date(m.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <p className="memo-body">{m.body}</p>
                <p className="memo-sub">{m.studentEmail}{m.callType && `・最後は${CALL_LABEL[m.callType]}`}</p>
              </li>
            ))}
          </ul>
        )}
      </main>
      <TabBar />
    </>
  )
}

// "2026-11-09" → "11月9日(月)"
function formatDate(d: string) {
  const [y, m, day] = d.split('-').map(Number)
  const w = '日月火水木金土'[new Date(y, m - 1, day).getDay()]
  return `${m}月${day}日(${w})`
}
