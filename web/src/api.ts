export type Role = 'STUDENT' | 'TEACHER'
export type CallType = 'QUESTION' | 'CHECK'

export interface User { id: string; email: string; name: string; role: Role }
export interface Period { no: number; start: string; end: string }
export interface AppConfig { authMode: 'dev' | 'microsoft'; vapidPublicKey: string; periods: Period[] }

export interface Room {
  id: string
  ownerId: string
  ownerName: string
  subject: string
  className: string
  dayOfWeek: number
  period: number
  createdAt: string
  isOpen: boolean
  openUntil: string | null
  closedUntil: string | null
}

export interface Counts { total: number; question: number; check: number }
export interface Call { id: number; studentId: string; studentName: string; type: CallType; createdAt: string }
export interface TeacherQueue { counts: Counts; head: Call[]; isOpen: boolean; serverTime: string }
export interface StudentQueue { counts: Counts; position: number; myType: CallType | ''; isOpen: boolean }

export interface Memo {
  id: number
  studentId: string
  studentName: string
  studentEmail: string
  callType: CallType | null
  body: string
  createdAt: string
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `エラーが発生しました (${res.status})`
    try { msg = (await res.json()).error ?? msg } catch { /* noop */ }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

export const api = {
  config: () => request<AppConfig>('GET', '/api/config'),
  me: () => request<User>('GET', '/api/me'),
  devLogin: (email: string, name: string) => request<User>('POST', '/auth/dev-login', { email, name }),
  logout: () => request<void>('POST', '/auth/logout'),

  // 先生
  rooms: () => request<Room[]>('GET', '/api/rooms'),
  createRoom: (r: { subject: string; className: string; dayOfWeek: number; period: number }) =>
    request<Room>('POST', '/api/rooms', r),
  deleteRoom: (id: string) => request<void>('DELETE', `/api/rooms/${id}`),
  finishCall: (roomId: string, callId: number, memo: string) =>
    request<void>('POST', `/api/rooms/${roomId}/calls/${callId}/done`, { memo }),
  ack: (roomId: string) => request<void>('POST', `/api/rooms/${roomId}/ack`),
  openRoom: (roomId: string) => request<Room>('POST', `/api/rooms/${roomId}/open`),
  closeRoom: (roomId: string) => request<Room>('POST', `/api/rooms/${roomId}/close`),
  memos: (roomId: string, date: string) =>
    request<Memo[]>('GET', `/api/rooms/${roomId}/memos?date=${encodeURIComponent(date)}`),
  memoDates: (roomId: string) => request<string[]>('GET', `/api/rooms/${roomId}/memo-dates`),

  // 共通
  room: (id: string) => request<Room>('GET', `/api/rooms/${id}`),
  teacherQueue: (id: string) => request<TeacherQueue>('GET', `/api/rooms/${id}/queue`),
  studentQueue: (id: string) => request<StudentQueue>('GET', `/api/rooms/${id}/queue`),

  // 学生
  join: (roomId: string) => request<Room>('POST', '/api/join', { roomId }),
  myRooms: () => request<{ rooms: Room[]; current: Room | null }>('GET', '/api/my/rooms'),
  call: (roomId: string, type: CallType) => request<void>('POST', `/api/rooms/${roomId}/calls`, { type }),
  cancelCall: (roomId: string) => request<void>('DELETE', `/api/rooms/${roomId}/calls/mine`),

  pushSubscribe: (sub: PushSubscriptionJSON) => request<void>('POST', '/api/push/subscribe', sub),
}

export const DAYS = ['日', '月', '火', '水', '木', '金', '土']
export const CALL_LABEL: Record<CallType, string> = { QUESTION: '質問', CHECK: '課題チェック' }

export function slotLabel(r: Pick<Room, 'dayOfWeek' | 'period'>) {
  return `${DAYS[r.dayOfWeek]}曜 ${r.period}限`
}
