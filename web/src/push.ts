import { api } from './api'

// 通知が使えない理由。使えるなら null
export function pushUnsupportedReason(): string | null {
  if (!window.isSecureContext) {
    return `HTTPS ではないため通知が使えません(今のアドレス: ${location.origin})。` +
      'PC なら http://localhost:8080 で、スマホならトンネルの https:// の URL で開いてください。'
  }
  if (isIOS() && !isStandalone()) {
    return 'iPhone では、ホーム画面に追加したアプリから開いたときだけ通知が使えます。'
  }
  if (!('serviceWorker' in navigator)) {
    return 'このブラウザでは通知が使えません。プライベート(シークレット)ウィンドウや、他のアプリ内のブラウザで開いていないか確認してください。'
  }
  if (!('PushManager' in window) || !('Notification' in window)) {
    return isIOS()
      ? 'この iOS では通知が使えません。iOS 16.4 以降にアップデートしてください。'
      : 'このブラウザは Web Push に対応していません。Chrome / Edge / Safari / Firefox の最新版で開いてください。'
  }
  return null
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
}

export function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
}

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return
  const url = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js'
  await navigator.serviceWorker.register(url, { type: import.meta.env.DEV ? 'module' : 'classic', scope: '/' })
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

// 必ずボタンのタップから呼ぶこと(iOS はユーザー操作なしでは許可ダイアログを出せない)
export async function enablePush(vapidPublicKey: string): Promise<'ok' | 'denied' | 'unsupported' | 'no-key'> {
  if (!pushSupported()) return 'unsupported'
  if (!vapidPublicKey) return 'no-key'
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return 'denied'
  // Service Worker の登録に失敗していると ready が永遠に終わらないので、時間を区切る
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Service Worker を登録できませんでした。ページを再読み込みしてください')), 10000)),
  ])
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    })
  }
  await api.pushSubscribe(sub.toJSON())
  return 'ok'
}

// 既に許可済みなら、ログイン後に購読をサーバーへ登録し直す(別ユーザーで使った端末対策)
export async function resyncPush(vapidPublicKey: string) {
  if (!pushSupported() || Notification.permission !== 'granted' || !vapidPublicKey) return
  await enablePush(vapidPublicKey).catch(() => undefined)
}

// アプリを前面で開いているときの通知(Service Worker から postMessage で届く)
export function onForegroundPush(handler: (data: { title: string; body: string; kind: string }) => void) {
  if (!('serviceWorker' in navigator)) return () => undefined
  const listener = (e: MessageEvent) => { if (e.data?.type === 'push') handler(e.data) }
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}

let audioCtx: AudioContext | null = null
export function chime() {
  try {
    navigator.vibrate?.([200, 100, 200])
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    ;[880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18)
      gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + i * 0.18 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.3)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + i * 0.18)
      osc.stop(ctx.currentTime + i * 0.18 + 0.32)
    })
  } catch { /* 音が鳴らせない環境は無視 */ }
}
