import { useState, type FormEvent } from 'react'
import { DAYS, type RoomInput } from './api'
import { useApp } from './app-context'
import { ErrorText } from './components'

// ルームの作成・変更で使う入力フォーム。開始〜終了の時限で、連続した複数コマを指定できる
export function RoomForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: RoomInput
  submitLabel: string
  onSubmit: (v: RoomInput) => Promise<void>
  onCancel?: () => void
}) {
  const { config } = useApp()
  const [form, setForm] = useState<RoomInput>(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const periods = config?.periods ?? []

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try { await onSubmit(form) } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>科目名
        <input required value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="IoT制作" />
      </label>
      <label>クラス名
        <input required value={form.className} onChange={(e) => setForm({ ...form, className: e.target.value })} placeholder="IE2A" />
      </label>
      <label>曜日
        <select value={form.dayOfWeek} onChange={(e) => setForm({ ...form, dayOfWeek: Number(e.target.value) })}>
          {[1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{DAYS[d]}曜</option>)}
        </select>
      </label>
      <div className="row">
        <label>開始
          <select
            value={form.period}
            // 開始を後ろにずらしたら、終了も最低その時限まで動かす
            onChange={(e) => { const v = Number(e.target.value); setForm({ ...form, period: v, periodEnd: Math.max(v, form.periodEnd) }) }}
          >
            {periods.map((p) => <option key={p.no} value={p.no}>{p.no}限 ({p.start}〜)</option>)}
          </select>
        </label>
        <label>終了
          <select value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: Number(e.target.value) })}>
            {periods.filter((p) => p.no >= form.period).map((p) => <option key={p.no} value={p.no}>{p.no}限 (〜{p.end})</option>)}
          </select>
        </label>
      </div>
      <p className="hint">2コマ続きの授業は「開始 1限・終了 2限」のように指定します。間の休み時間も呼び出しの列は続きます。</p>
      <div className="row">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>キャンセル</button>}
        <button className="btn primary" disabled={busy}>{submitLabel}</button>
      </div>
      <ErrorText error={error} />
    </form>
  )
}
