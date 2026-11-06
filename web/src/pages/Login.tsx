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
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const loginError = params.get('error') ?? '' // Microsoft ログインに失敗したときサーバーから渡される

  if (loading) return <div className="center muted">読み込み中…</div>
  if (user) return <Navigate to={next} replace />

  return (
    <main className="login">
      <img src="/icon-192.png" alt="" width={72} height={72} className="login-icon" />
      <h1>先生呼び出し</h1>
      <p className="muted">手を挙げ続けなくても、呼んだ順に先生が来ます</p>

      {loginError && <p className="card error" role="alert">{loginError}</p>}

      {config?.authMode !== 'dev' && (
        <>
          <a className="btn primary wide ms-login" href={`/auth/login?next=${encodeURIComponent(next)}`}>
            <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
              <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
              <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
            </svg>
            Microsoft アカウントでログイン
          </a>
          <p className="hint">学校の Microsoft アカウント(Teams や Office と同じもの)でログインします</p>
        </>
      )}

      {config?.devLogin && (
        // Microsoft ログインと併用しているときは折りたたんでおく
        <details className="card dev-login" open={config.authMode === 'dev'}>
          <summary className="tag">開発用ログイン(テスト用)</summary>
          <form
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault()
              setError('')
              try {
                setUser(await api.devLogin(email, name, password))
                nav(next, { replace: true })
              } catch (err) { setError((err as Error).message) }
            }}
          >
            <label>メールアドレス
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="sensei@example.ac.jp" />
            </label>
            <label>表示名
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="テスト 先生" />
            </label>
            {config.devLoginNeedsPassword && (
              <label>開発用ログインのパスワード
                <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </label>
            )}
            <p className="hint">@ の前が7桁の数字なら学生、それ以外は先生としてログインします。Microsoft で使っているメールアドレスは使えません。</p>
            <button className="btn primary wide">ログイン</button>
            <ErrorText error={error} />
          </form>
        </details>
      )}
    </main>
  )
}
