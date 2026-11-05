import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Html5Qrcode } from 'html5-qrcode'
import { Header } from '../components'

// アプリ内でQRを読み取る(iOS ではホーム画面のアプリと Safari でログイン状態が別なので、標準カメラで読むとうまくいかない)
export default function Scan() {
  const nav = useNavigate()
  const [error, setError] = useState('')
  const done = useRef(false)

  useEffect(() => {
    const qr = new Html5Qrcode('qr-reader', { verbose: false })
    let started = false
    qr.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 240, height: 240 } },
      (text) => {
        if (done.current) return
        const m = text.match(/\/join\/([0-9a-f]+)/)
        if (!m) { setError('このアプリのQRコードではありません'); return }
        done.current = true
        nav(`/join/${m[1]}`, { replace: true })
      },
      () => undefined,
    ).then(() => { started = true })
      .catch(() => setError('カメラを起動できませんでした。カメラの使用を許可してください'))
    return () => { if (started) void qr.stop().catch(() => undefined) }
  }, [nav])

  return (
    <>
      <Header title="QRコードを読み取る" back="/" />
      <main className="page stack">
        <div id="qr-reader" className="qr-reader" />
        <p className="muted center small">先生が表示しているQRコードを枠に合わせてください</p>
        {error && <p className="error center">{error}</p>}
      </main>
    </>
  )
}
