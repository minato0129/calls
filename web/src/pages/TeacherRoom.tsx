import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api, CALL_LABEL, slotLabel, type Call, type Room, type TeacherQueue } from '../api'
import { useNow, useRoomEvents } from '../app-context'
import { elapsed, ErrorText, Header, PushCard } from '../components'
import { RoomForm } from '../RoomForm'
import { chime, onForegroundPush } from '../push'

export default function TeacherRoom() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const now = useNow()
  const [room, setRoom] = useState<Room | null>(null)
  const [switching, setSwitching] = useState(false)
  const [queue, setQueue] = useState<TeacherQueue | null>(null)
  const [selected, setSelected] = useState<Call | null>(null)
  const [memo, setMemo] = useState('')
  const [showQR, setShowQR] = useState(false)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // アプリが前面にあるとき、サーバーに「確認済み」を送って再通知を止める
  const ack = useCallback(() => {
    if (document.visibilityState === 'visible') void api.ack(id).catch(() => undefined)
  }, [id])

  const load = useCallback(async () => {
    try {
      const q = await api.teacherQueue(id)
      setQueue(q)
      if (q.counts.total > 0) ack()
    } catch (e) { setError((e as Error).message) }
  }, [id, ack])

  useEffect(() => {
    api.room(id).then(setRoom).catch((e) => setError(e.message))
  }, [id])
  useRoomEvents(id, load)
  useEffect(() => {
    document.addEventListener('visibilitychange', ack)
    return () => document.removeEventListener('visibilitychange', ack)
  }, [ack])
  useEffect(() => onForegroundPush(() => chime()), [])

  const joinUrl = `${location.origin}/join/${id}`

  return (
    <>
      <Header title={room?.subject ?? 'ルーム'} back="/" right={
        <button className="link-btn" onClick={() => setShowQR(!showQR)}>{showQR ? '閉じる' : 'QR'}</button>
      } />
      <main className="page stack">
        {room && (
          <section className="card session">
            <div>
              <p className="muted small">
                {room.className} ・ {slotLabel(room)}{' '}
                <button className="link-btn inline" onClick={() => setEditing(true)}>変更</button>
              </p>
              <p>
                {queue?.isOpen ? <span className="badge live">授業中</span> : <span className="badge">授業時間外</span>}
                {queue?.isOpen && room.openUntil && new Date(room.openUntil) > new Date(now) && (
                  <span className="muted small"> {new Date(room.openUntil).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} まで</span>
                )}
              </p>
            </div>
            {queue?.isOpen ? (
              <button
                className="btn"
                disabled={switching}
                onClick={async () => {
                  if (queue.counts.total > 0 && !confirm(`待っている ${queue.counts.total} 人の呼び出しは取り消されます。授業を終了しますか?`)) return
                  setSwitching(true)
                  try { setRoom(await api.closeRoom(id)); await load() } catch (e) { setError((e as Error).message) } finally { setSwitching(false) }
                }}
              >
                授業を終了
              </button>
            ) : (
              <button
                className="btn primary"
                disabled={switching}
                onClick={async () => {
                  setSwitching(true)
                  try { setRoom(await api.openRoom(id)); await load() } catch (e) { setError((e as Error).message) } finally { setSwitching(false) }
                }}
              >
                授業を開始
              </button>
            )}
          </section>
        )}

        {showQR && (
          <div className="card qr">
            <QRCodeSVG value={joinUrl} size={240} marginSize={2} />
            <p className="muted small">学生はアプリの「QRコードを読み取る」からこのコードを読み取ります</p>
          </div>
        )}

        <PushCard text="呼び出しがあったときに通知を受け取れるようにします" />

        <section className="counts card">
          <div className="count-main">
            <span className="count-num">{queue?.counts.total ?? '-'}</span>
            <span className="muted">人 待機中</span>
          </div>
          <div className="count-sub">
            <span>質問 <b>{queue?.counts.question ?? 0}</b></span>
            <span>課題チェック <b>{queue?.counts.check ?? 0}</b></span>
          </div>
        </section>

        <section className="stack">
          {queue && queue.head.length === 0 && <p className="center muted pad">呼び出しはありません</p>}
          {queue?.head.map((c, i) => (
            <button key={c.id} className={`card call-row ${i === 0 ? 'first' : ''}`} onClick={() => { setSelected(c); setMemo('') }}>
              <span className="call-no">{i + 1}</span>
              <span className="call-body">
                <span className="call-name">{c.studentName}</span>
                <span className={`chip ${c.type === 'CHECK' ? 'check' : 'question'}`}>{CALL_LABEL[c.type]}</span>
              </span>
              <span className="call-time">{elapsed(c.createdAt, now)}</span>
            </button>
          ))}
          {queue && queue.counts.total > queue.head.length && (
            <p className="muted center small">ほか {queue.counts.total - queue.head.length} 人が待っています</p>
          )}
        </section>

        <ErrorText error={error} />

        <button
          className="btn danger-outline wide"
          onClick={async () => {
            if (!confirm('このルームを削除しますか?\nメモもすべて削除されます。必要なら先にメモ一覧からCSVを保存してください。')) return
            await api.deleteRoom(id)
            nav('/', { replace: true })
          }}
        >
          ルームを削除
        </button>
      </main>

      {editing && room && (
        <div className="dialog-backdrop" onClick={() => setEditing(false)}>
          <div className="dialog stack" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
            <h2>ルームを変更</h2>
            <p className="hint">メモ・参加している学生・QRコードはそのまま引き継がれます。</p>
            <RoomForm
              initial={{ subject: room.subject, className: room.className, dayOfWeek: room.dayOfWeek, period: room.period, periodEnd: room.periodEnd }}
              submitLabel="保存"
              onCancel={() => setEditing(false)}
              onSubmit={async (v) => {
                setRoom(await api.updateRoom(id, v))
                setEditing(false)
                await load()
              }}
            />
          </div>
        </div>
      )}

      {selected && (
        <div className="dialog-backdrop" onClick={() => setSelected(null)}>
          <div className="dialog stack" role="dialog" aria-modal onClick={(e) => e.stopPropagation()}>
            <h2>{selected.studentName}</h2>
            <p><span className={`chip ${selected.type === 'CHECK' ? 'check' : 'question'}`}>{CALL_LABEL[selected.type]}</span> ・ {elapsed(selected.createdAt, now)}待ち</p>
            <label>メモ(任意)
              <textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)}
                placeholder={selected.type === 'CHECK' ? '例: 課題3 チェック済' : '例: センサーの配線について'} />
            </label>
            <div className="row">
              <button className="btn" onClick={() => setSelected(null)}>キャンセル</button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api.finishCall(id, selected.id, memo)
                    setSelected(null)
                    await load()
                  } catch (e) { setError((e as Error).message); setSelected(null) } finally { setBusy(false) }
                }}
              >
                対応済
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
