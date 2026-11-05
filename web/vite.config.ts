import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // push を受け取るため Service Worker は自前(src/sw.ts)で書く
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false, // 登録は src/push.ts で行う
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: '先生呼び出し',
        short_name: '呼び出し',
        description: '授業中に先生を順番に呼び出すアプリ',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        theme_color: '#1f6f5c',
        background_color: '#f6f1e7',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist', // 本番は web コンテナの nginx が配信する
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // nginx 経由(localhost:8080)やトンネルの URL からのアクセスを許可する
    allowedHosts: ['localhost', '.trycloudflare.com'],
    // Docker でマウントしたフォルダは変更通知が届かないことがあるのでポーリングする
    watch: process.env.VITE_POLLING === 'true' ? { usePolling: true, interval: 300 } : undefined,
    // Docker を使わず手元で npm run dev するときだけ使われる(Docker では nginx が振り分ける)
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: false },
      '/auth': { target: 'http://localhost:8080', changeOrigin: false },
    },
  },
})
