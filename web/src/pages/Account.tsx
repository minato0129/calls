import { useApp } from '../app-context'
import { Header, InstallCard, LogoutButton, PushSettings, TabBar } from '../components'

// アカウント: 名前・通知の設定・ログアウト
export default function Account() {
  const { user } = useApp()
  const teacher = user?.role === 'TEACHER'
  return (
    <>
      <Header title="アカウント" back={teacher ? undefined : '/'} />
      <main className={`page stack ${teacher ? 'with-tabbar' : ''}`}>
        <InstallCard />
        <section className="group">
          <div className="group-body">
            <div className="profile">
              <span className="avatar" aria-hidden>{user?.name.slice(0, 1)}</span>
              <div>
                <p className="profile-name">{user?.name}</p>
                <p className="muted small">{user?.email}・{teacher ? '先生' : '学生'}</p>
              </div>
            </div>
          </div>
        </section>
        <PushSettings />
        <LogoutButton />
      </main>
      {teacher && <TabBar />}
    </>
  )
}
