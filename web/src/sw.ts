/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('install', () => { void self.skipWaiting() })
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })

interface PushData { title: string; body: string; url: string; kind: string }

self.addEventListener('push', (event) => {
  const data: PushData = event.data?.json() ?? { title: '呼び出し', body: '', url: '/', kind: '' }
  event.waitUntil((async () => {
    // 開いている画面にも伝えて、音とバイブを鳴らす
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of clients) c.postMessage({ type: 'push', ...data })
    // 通知は必ず表示する。iOS は通知を出さないプッシュが続くと登録を取り消すため、前面にいても省略しない
    await self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url },
      tag: data.kind, // 同じ種類の通知は1件にまとめる
    })
  })())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url: string = event.notification.data?.url ?? '/'
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const c of clients) {
      const w = c as WindowClient
      await w.focus()
      await w.navigate(url).catch(() => undefined)
      return
    }
    await self.clients.openWindow(url)
  })())
})
