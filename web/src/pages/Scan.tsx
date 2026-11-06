import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QrScanner from 'qr-scanner'

// アプリ内でQRを読み取る(iOS ではホーム画面のアプリと Safari でログイン状態が別なので、標準カメラで読むとうまくいかない)
export default function Scan() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const done = useRef(false)
  const [status, setStatus] = useState<'starting' | 'scanning' | 'found' | 'error'>('starting')
  const [message, setMessage] = useState('')
  const [hasFlash, setHasFlash] = useState(false)
  const [flashOn, setFlashOn] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    let scanner: QrScanner | null = null
    // 開発時(React の StrictMode)は画面が「作る→片付ける→作る」と2回動く。
    // すぐにカメラを起動すると、1回目の片付けが2回目のカメラまで止めてしまい、映像が出なかったり重なったりする。
    // 少し遅らせて起動し、1回目は起動前に取り消す
    const timer = window.setTimeout(() => {
      if (cancelled) return
      scanner = new QrScanner(
        video,
        (result) => {
          if (done.current) return
          const m = result.data.match(/\/join\/([0-9a-f]+)/)
          if (!m) {
            setMessage('このアプリのQRコードではありません')
            return
          }
          done.current = true
          setStatus('found')
          navigator.vibrate?.(80)
          scanner?.stop()
          // 枠が緑になったのを見せてから移る
          window.setTimeout(() => nav(`/join/${m[1]}`, { replace: true }), 250)
        },
        {
          preferredCamera: 'environment',
          maxScansPerSecond: 10,
          returnDetailedScanResult: true,
          // 画面に見えている枠と同じ範囲(中央の正方形)だけを読む
          calculateScanRegion: (v) => {
            const size = Math.round(Math.min(v.videoWidth, v.videoHeight) * 0.7)
            return { x: Math.round((v.videoWidth - size) / 2), y: Math.round((v.videoHeight - size) / 2), width: size, height: size }
          },
        },
      )
      scannerRef.current = scanner
      scanner.start()
        .then(async () => {
          if (cancelled || !scanner) return
          setStatus('scanning')
          setHasFlash(await scanner.hasFlash().catch(() => false))
        })
        .catch(() => {
          if (cancelled) return
          setStatus('error')
          setMessage('カメラを起動できませんでした。設定でこのアプリのカメラの使用を許可してください')
        })
    }, 50)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      scanner?.destroy()
      scannerRef.current = null
    }
  }, [nav])

  return (
    <div className="scan">
      <video ref={videoRef} className="scan-video" playsInline muted />

      {/* 枠の外を暗くし、中央の正方形だけを見せる */}
      <div className={`scan-frame ${status === 'found' ? 'found' : ''}`} aria-hidden>
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />
      </div>

      <header className="scan-top">
        <button className="scan-back" onClick={() => nav(-1)} aria-label="戻る">‹</button>
        <h1>QRコードを読み取る</h1>
        <span className="scan-back" />
      </header>

      <div className="scan-bottom">
        {status === 'starting' && <p>カメラを起動しています…</p>}
        {status === 'scanning' && <p>先生が表示しているQRコードを枠に合わせてください</p>}
        {status === 'found' && <p>読み取りました</p>}
        {message && <p className="scan-error" role="alert">{message}</p>}
        {hasFlash && status === 'scanning' && (
          <button
            className="scan-flash"
            onClick={async () => {
              await scannerRef.current?.toggleFlash()
              setFlashOn(scannerRef.current?.isFlashOn() ?? false)
            }}
          >
            {flashOn ? 'ライトを消す' : 'ライトをつける'}
          </button>
        )}
      </div>
    </div>
  )
}
