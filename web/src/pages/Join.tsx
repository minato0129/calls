import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import { useApp } from '../app-context'
import { Header } from '../components'

export default function Join() {
  const { roomId = '' } = useParams()
  const { user } = useApp()
  const nav = useNavigate()
  const [error, setError] = useState('')

  useEffect(() => {
    if (user?.role !== 'STUDENT') return
    api.join(roomId)
      .then((r) => nav(r.isOpen ? `/rooms/${r.id}` : '/', { replace: true }))
      .catch((e) => setError(e.message))
  }, [roomId, user, nav])

  if (user?.role === 'TEACHER') {
    return (
      <>
        <Header title="参加" back="/" />
        <main className="page"><p>先生のアカウントでは参加できません。</p><Link to="/" className="btn wide">ホームへ</Link></main>
      </>
    )
  }
  return (
    <>
      <Header title="参加" back="/" />
      <main className="page center">{error ? <p className="error">{error}</p> : <p className="muted">参加しています…</p>}</main>
    </>
  )
}
