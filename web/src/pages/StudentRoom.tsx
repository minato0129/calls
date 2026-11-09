import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { api, CALL_LABEL, slotLabel, type CallType, type Room, type StudentQueue } from '../api'
import { useRoomEvents } from '../app-context'
import { ErrorText, Header, PushBanner } from '../components'
import { chime, onForegroundPush } from '../push'

export default function StudentRoom() {
  const { id = '' } = useParams()
  const [room, setRoom] = useState<Room | null>(null)
  const [queue, setQueue] = useState<StudentQueue | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')

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

  const call = async (type: CallType) => {
    setError('')
    setBusy(true)
    try { await api.call(id, type); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const cancel = async () => {
    setError('')
    setBusy(true)
    try { await api.cancelCall(id); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const open = queue?.isOpen ?? false
  const waiting = !!queue?.myType
  const first = waiting && queue!.position === 1

  return (
    <>
      <Header title={room?.subject ?? '授業'} sub={room ? `${room.className}・${slotLabel(room)}・${room.ownerName}` : undefined} back="/" />
      <main className="page stack with-actionbar tall">
        <PushBanner text="自分の番が近づいたら通知を受け取る" />

        {/* 整理券。呼び出し中は自分の順番を大きく出す */}
        <section className={`ticket ${waiting ? 'waiting' : ''} ${first ? 'first' : ''}`} aria-live="polite">
          {loadError ? (
            <>
              <p className="ticket-head">状況を取得できませんでした</p>
              <p className="error">{loadError}</p>
              <button type="button" className="btn small" onClick={() => void load()}>再読み込み</button>
            </>
          ) : !queue ? (
            <p className="muted">読み込み中…</p>
          ) : waiting ? (
            <>
              <p className="ticket-head">{CALL_LABEL[queue.myType as CallType]}で呼び出し中</p>
              <p className="ticket-no"><b>{queue.position}</b><span>番目</span></p>
              <p className="ticket-foot">
                {first ? (notice || '次はあなたの番です。先生が来るまで待ってください') : `前に ${queue.position - 1} 人います`}
              </p>
            </>
          ) : open ? (
            <>
              <p className="ticket-head">待っている人</p>
              <p className="ticket-no idle"><b>{queue.counts.total}</b><span>人</span></p>
              <p className="ticket-foot">下のボタンで先生を呼び出せます</p>
            </>
          ) : (
            <>
              <p className="ticket-head">授業時間外です</p>
              <p className="ticket-foot">先生が授業を開始すると、呼び出せるようになります</p>
            </>
          )}
        </section>
        <ErrorText error={error} />
      </main>

      {/* 親指が届く画面の下に、呼び出しのボタンを置く */}
      <div className="actionbar">
        {waiting ? (
          <button type="button" className="btn wide large danger-outline" disabled={busy} onClick={() => void cancel()}>
            呼び出しを取り消す
          </button>
        ) : (
          <div className="call-buttons">
            {(['QUESTION', 'CHECK'] as CallType[]).map((t) => (
              <button key={t} type="button" className={`call-btn ${t === 'CHECK' ? 'check' : 'question'}`}
                disabled={!open || busy} onClick={() => void call(t)}>
                {CALL_LABEL[t]}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
