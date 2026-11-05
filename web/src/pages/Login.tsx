import { useState } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../app-context'
import { ErrorText } from '../components'

export default function Login() {
  const { user, config, loading, setUser } = useApp()
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/'
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  if (loading) return <div className="center muted">読み込み中…</div>
  if (user) return <Navigate to={next} replace />

  return (
    <main className="login">
      <img src="/icon-192.png" alt="" width={72} height={72} className="login-icon" />
      <h1>先生呼び出し</h1>
      <p className="muted">手を挙げ続けなくても、呼んだ順に先生が来ます</p>

      {config?.authMode === 'microsoft' ? (
        <a className="btn primary wide" href={`/auth/login?next=${encodeURIComponent(next)}`}>
          Microsoft アカウントでログイン
        </a>
      ) : (
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault()
            setError('')
            try {
              setUser(await api.devLogin(email, name))
              nav(next, { replace: true })
            } catch (err) { setError((err as Error).message) }
          }}
        >
          <p className="tag">開発用ログイン</p>
          <label>メールアドレス
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="1234567@example.ac.jp" />
          </label>
          <label>表示名
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="山田 太郎" />
          </label>
          <p className="hint">ローカル部が7桁の数字なら学生、それ以外は先生としてログインします</p>
          <button className="btn primary wide">ログイン</button>
          <ErrorText error={error} />
        </form>
      )}
    </main>
  )
}
