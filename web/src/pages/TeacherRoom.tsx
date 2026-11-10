import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { QRCodeSVG } from 'qrcode.react'
import { api, CALL_LABEL, slotLabel, type Call, type Room, type TeacherQueue } from '../api'
import { useNow, useRoomEvents } from '../app-context'
import { elapsed, ErrorText, Header, IconButton, MenuSheet, PushBanner, Sheet, TabBar } from '../components'
import { IconClose, IconEdit, IconMore, IconQR, IconTrash } from '../icons'
import { RoomForm } from '../RoomForm'
import { chime, onForegroundPush } from '../push'

// showMemoChip: メモの中身を横に出している所では「メモあり」は出さない
function CallChips({ c, showMemoChip = true }: { c: Call; showMemoChip?: boolean }) {
  return (
    <span className="chips">
      <span className={`chip ${c.type === 'CHECK' ? 'check' : 'question'}`}>{CALL_LABEL[c.type]}</span>
      {(c.callsToday ?? 0) > 1 && <span className="chip plain">{c.callsToday}回目</span>}
      {showMemoChip && c.memo && <span className="chip plain">メモあり</span>}
    </span>
  )
}

export default function TeacherRoom() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const now = useNow()
  const [room, setRoom] = useState<Room | null>(null)
  const [queue, setQueue] = useState<TeacherQueue | null>(null)
  const [selected, setSelected] = useState<Call | null>(null)
  const [memo, setMemo] = useState('')
  const [sheet, setSheet] = useState<'none' | 'menu' | 'edit' | 'qr'>('none')
  const [switching, setSwitching] = useState(false)
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

  useEffect(() => { api.room(id).then(setRoom).catch((e) => setError(e.message)) }, [id])
  useRoomEvents(id, load)
  useEffect(() => {
    document.addEventListener('visibilitychange', ack)
    return () => document.removeEventListener('visibilitychange', ack)
  }, [ack])
  useEffect(() => onForegroundPush(() => chime()), [])

  const openCall = (c: Call) => { setSelected(c); setMemo(c.memo ?? '') }
  const closeSheet = useCallback(() => setSheet('none'), [])
  const closeCall = useCallback(() => setSelected(null), [])

  const toggleSession = async () => {
    if (!queue) return
    if (queue.isOpen && queue.counts.total > 0 &&
      !confirm(`待っている ${queue.counts.total} 人の呼び出しは取り消されます。授業を終了しますか?`)) return
    setSwitching(true)
    try {
      setRoom(await (queue.isOpen ? api.closeRoom(id) : api.openRoom(id)))
      await load()
    } catch (e) { setError((e as Error).message) } finally { setSwitching(false) }
  }

  const deleteRoom = async () => {
    if (!confirm('このルームを削除しますか?\nメモもすべて削除されます。必要なら先にメモの画面から CSV を保存してください。')) return
    await api.deleteRoom(id)
    nav('/', { replace: true })
  }

  const joinUrl = `${location.origin}/join/${id}`
  const [copied, setCopied] = useState(false)
  // Teams などに貼れるよう、参加用のリンクをコピーする
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { prompt('参加用のリンク', joinUrl) }
  }

  const [head, next] = queue?.head ?? []
  const openUntil = queue?.isOpen && room?.openUntil && new Date(room.openUntil).getTime() > now
    ? new Date(room.openUntil).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : ''

  return (
    <>
      <Header
        title={room?.subject ?? 'ルーム'}
        sub={room ? `${room.className}・${slotLabel(room)}` : undefined}
        back="/"
        actions={<>
          <IconButton label="参加用の QR コード" onClick={() => setSheet('qr')}><IconQR /></IconButton>
          <IconButton label="その他の操作" onClick={() => setSheet('menu')}><IconMore /></IconButton>
        </>}
      />
      {/* スマホは1列(授業の状態 → 先頭の人 → 次 → 人数)。PC は左に呼び出し、右に授業の状態・人数・QR の2列 */}
      <main className="page stack room-layout">
        <div className="room-main">
          {/* いちばん前の人。黒板のようなカードで大きく出す */}
          {head ? (
            <section className="board" aria-live="polite">
              <div className="board-top">
                <span className="board-no" aria-label="1番目">1</span>
                <CallChips c={head} showMemoChip={false} />
                <span className="board-time">{elapsed(head.createdAt, now)}</span>
              </div>
              <p className="board-name">{head.studentName}</p>
              {head.memo && <p className="board-memo">{head.memo}</p>}
              <button type="button" className="btn board-btn" onClick={() => openCall(head)}>対応する</button>
            </section>
          ) : queue && (
            <section className="board empty-board">
              <p>{queue.isOpen ? '呼び出しを待っています' : '授業を開始すると、学生が呼び出せるようになります'}</p>
            </section>
          )}

          {next && (
            <button type="button" className="next-row" onClick={() => openCall(next)}>
              <span className="next-label">次</span>
              <span className="next-name">{next.studentName}</span>
              <CallChips c={next} />
              <span className="next-time">{elapsed(next.createdAt, now)}</span>
            </button>
          )}
          <ErrorText error={error} />
        </div>

        <aside className="room-side">
          {queue && (
            <section className={`session ${queue.isOpen ? 'on' : ''}`}>
              <p>
                {queue.isOpen ? <b>授業中</b> : '授業時間外'}
                {openUntil && <span>{openUntil} まで</span>}
              </p>
              <button type="button" className={`btn small ${queue.isOpen ? '' : 'primary'}`} disabled={switching} onClick={() => void toggleSession()}>
                {queue.isOpen ? '授業を終了' : '授業を開始'}
              </button>
            </section>
          )}

          <PushBanner text="呼び出されたときに通知を受け取る" />

          {queue && (
            <dl className="stats">
              <div><dt>待っている人</dt><dd>{queue.counts.total}</dd></div>
              <div><dt>質問</dt><dd>{queue.counts.question}</dd></div>
              <div><dt>課題チェック</dt><dd>{queue.counts.check}</dd></div>
            </dl>
          )}

          {/* PC だけ: 参加用の QR を横に出しておく。プロジェクターに映すときは「大きく表示」 */}
          <section className="qr-card desktop-only" aria-label="参加用の QR コード">
            <QRCodeSVG value={joinUrl} size={168} marginSize={1} className="qr-card-code" />
            <div className="qr-card-body">
              <p className="qr-card-title">参加用の QR コード</p>
              <p className="hint">学生はアプリの「QR コードを読み取る」から参加します</p>
              <div className="qr-card-actions">
                <button type="button" className="btn small" onClick={() => setSheet('qr')}>大きく表示</button>
                <button type="button" className="btn small" onClick={() => void copyLink()}>{copied ? 'コピーしました' : 'リンクをコピー'}</button>
              </div>
            </div>
          </section>
        </aside>
      </main>
      <TabBar desktopOnly />

      {selected && (
        <Sheet title={selected.studentName} onClose={closeCall}>
          <div className="stack">
            <p className="sheet-meta"><CallChips c={selected} showMemoChip={false} /><span>{elapsed(selected.createdAt, now)}待ち</span></p>
            <label>{selected.memo ? 'この授業のメモ(書き換えると上書きされます)' : 'メモ(任意)'}
              <textarea rows={4} value={memo} onChange={(e) => setMemo(e.target.value)}
                placeholder={selected.type === 'CHECK' ? '例: 課題3 チェック済' : '例: センサーの配線について'} />
            </label>
            <p className="hint">メモは授業ごとに1人1枚です。{selected.memo ? '空にして対応済にするとメモは消えます。' : 'この授業でまた呼び出されたときに表示されます。'}</p>
            <button
              type="button"
              className="btn primary wide large"
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
              対応済にする
            </button>
          </div>
        </Sheet>
      )}

      {sheet === 'menu' && (
        <MenuSheet onClose={closeSheet} items={[
          { label: '参加用の QR コードを表示', icon: <IconQR />, onSelect: () => setSheet('qr') },
          { label: 'ルームを変更', icon: <IconEdit />, onSelect: () => setSheet('edit') },
          { label: 'ルームを削除', icon: <IconTrash />, danger: true, onSelect: () => void deleteRoom() },
        ]} />
      )}

      {sheet === 'edit' && room && (
        <Sheet title="ルームを変更" onClose={closeSheet}>
          <p className="hint">メモ・参加している学生・QR コードはそのまま引き継がれます。</p>
          <RoomForm
            initial={{ subject: room.subject, className: room.className, dayOfWeek: room.dayOfWeek, period: room.period, periodEnd: room.periodEnd }}
            submitLabel="保存"
            onCancel={closeSheet}
            onSubmit={async (v) => {
              setRoom(await api.updateRoom(id, v))
              closeSheet()
              await load()
            }}
          />
        </Sheet>
      )}

      {/* 学生にスマホの画面を見せて読み取ってもらうので、全画面で大きく出す */}
      {sheet === 'qr' && (
        <div className="qr-screen" role="dialog" aria-modal aria-label="参加用の QR コード">
          <button type="button" className="icon-btn qr-close" aria-label="閉じる" onClick={closeSheet}><IconClose /></button>
          <QRCodeSVG value={joinUrl} size={512} marginSize={2} className="qr-code" />
          <p className="qr-title">{room?.subject}</p>
          <p className="qr-sub">アプリの「QR コードを読み取る」から参加</p>
        </div>
      )}
    </>
  )
}
