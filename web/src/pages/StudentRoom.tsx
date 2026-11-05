import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, CALL_LABEL, slotLabel, type CallType, type Room, type StudentQueue } from '../api'
import { useRoomEvents } from '../app-context'
import { ErrorText, Header, PushCard } from '../components'
import { chime, onForegroundPush } from '../push'

export default function StudentRoom() {
  const { id = '' } = useParams()
  const [room, setRoom] = useState<Room | null>(null)
  const [queue, setQueue] = useState<StudentQueue | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

  const [loadError, setLoadError] = useState('')

  const load = useCallback(async () => {
    try {
      setQueue(await api.studentQueue(id))
      setLoadError('')
    } catch (e) { setLoadError((e as Error).message) }
  }, [id])

  useEffect(() => { api.room(id).then(setRoom).catch((e) => setError(e.message)) }, [id])
  useRoomEvents(id, load)
  useEffect(() => onForegroundPush((d) => { chime(); setNotice(d.body) }), [])
  useEffect(() => { if (queue?.position !== 1) setNotice('') }, [queue?.position])

  // 同じボタンをもう一度押したら取り消し
  const press = async (type: CallType) => {
    setError('')
    setBusy(true)
    try {
      if (queue?.myType === type) await api.cancelCall(id)
      else await api.call(id, type)
      await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const waiting = !!queue?.myType
  const open = queue?.isOpen ?? false

  return (
    <>
      <Header title={room?.subject ?? '授業'} back="/" />
      <main className="page stack">
        {room && <p className="muted">{room.className} ・ {slotLabel(room)} ・ {room.ownerName}</p>}
        <PushCard text="自分の番が近づいたときに通知を受け取れるようにします" />

        <section className={`card status ${waiting ? (queue!.position === 1 ? 'next' : 'waiting') : ''}`} aria-live="polite">
          {loadError ? (
            // 通信に失敗したときは「授業時間外」と区別して原因を出す
            <>
              <p><b>状況を取得できませんでした</b></p>
              <p className="error">{loadError}</p>
              <button className="btn" onClick={() => void load()}>再読み込み</button>
            </>
          ) : !queue ? (
            <p className="muted">読み込み中…</p>
          ) : !open ? (
            <>
              <p>授業時間外です</p>
              <p className="muted small">先生が授業を開始すると、自動で呼び出せるようになります</p>
            </>
          ) : waiting ? (
            <>
              <p className="muted small">{CALL_LABEL[queue!.myType as CallType]}で呼び出し中</p>
              <p className="position"><b>{queue!.position}</b> 番目</p>
              {queue!.position === 1
                ? <p><b>{notice || 'あなたの番です。先生が来るまで待ってください'}</b></p>
                : <p className="muted">前に {queue!.position - 1} 人います</p>}
            </>
          ) : (
            <>
              <p>待っている人: <b>{queue?.counts.total ?? '-'}</b> 人</p>
              <p className="muted small">ボタンを押すと先生を呼び出します</p>
            </>
          )}
        </section>

        <div className="call-buttons">
          {(['QUESTION', 'CHECK'] as CallType[]).map((t) => {
            const active = queue?.myType === t
            return (
              <button
                key={t}
                className={`big-btn ${t === 'CHECK' ? 'check' : 'question'} ${active ? 'active' : ''}`}
                disabled={!open || busy || (waiting && !active)}
                onClick={() => press(t)}
              >
                {active ? '取り消す' : CALL_LABEL[t]}
              </button>
            )
          })}
        </div>
        <ErrorText error={error} />
      </main>
    </>
  )
}
