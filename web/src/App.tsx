import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useApp } from './app-context'
import Login from './pages/Login'
import TeacherHome from './pages/TeacherHome'
import TeacherRoom from './pages/TeacherRoom'
import Memos from './pages/Memos'
import StudentHome from './pages/StudentHome'
import StudentRoom from './pages/StudentRoom'
import Scan from './pages/Scan'
import Join from './pages/Join'
import type { ReactNode } from 'react'

function RequireLogin({ children }: { children: ReactNode }) {
  const { user, loading } = useApp()
  const loc = useLocation()
  if (loading) return <div className="center muted">読み込み中…</div>
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname)}`} replace />
  return <>{children}</>
}

function Home() {
  const { user } = useApp()
  return user?.role === 'TEACHER' ? <TeacherHome /> : <StudentHome />
}

function RoomPage() {
  const { user } = useApp()
  return user?.role === 'TEACHER' ? <TeacherRoom /> : <StudentRoom />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireLogin><Home /></RequireLogin>} />
      <Route path="/rooms/:id" element={<RequireLogin><RoomPage /></RequireLogin>} />
      <Route path="/memos" element={<RequireLogin><Memos /></RequireLogin>} />
      <Route path="/scan" element={<RequireLogin><Scan /></RequireLogin>} />
      <Route path="/join/:roomId" element={<RequireLogin><Join /></RequireLogin>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
