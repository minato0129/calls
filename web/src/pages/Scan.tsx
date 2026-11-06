import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QrScanner from 'qr-scanner'

type Status = 'starting' | 'scanning' | 'stalled' | 'found' | 'error'

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const onResize = () => setSize(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return size
}

// 映像が届いているか(iOS では再生中でもフレームが来ず、真っ黒のままになることがある)
function hasFrames(v: HTMLVideoElement) {
  return !v.paused && v.readyState >= 2 && v.videoWidth > 0
}

// アプリ内でQRを読み取る(iOS ではホーム画面のアプリと Safari でログイン状態が別なので、標準カメラで読むとうまくいかない)
export default function Scan() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const scannerRef = useRef<QrScanner | null>(null)
  const done = useRef(false)
  const [status, setStatus] = useState<Status>('starting')
  const [message, setMessage] = useState('')
  const [hasFlash, setHasFlash] = useState(false)
  const [flashOn, setFlashOn] = useState(false)
  const [debug, setDebug] = useState('')
  const view = useViewport()
  // 枠の大きさ。暗くする SVG の穴と枠の両方をこの値で描く
  const hole = Math.min(view.w * 0.7, view.h * 0.7, 320)

  const describe = () => {
    const v = videoRef.current
    if (!v) return ''
    const track = (v.srcObject as MediaStream | null)?.getVideoTracks()[0]
    return `video ${v.videoWidth}x${v.videoHeight} ready=${v.readyState} paused=${v.paused} ` +
      `track=${track ? `${track.readyState}${track.muted ? ' muted' : ''}` : 'なし'} ` +
      `standalone=${window.matchMedia('(display-mode: standalone)').matches}`
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    // iOS は属性として付いていないと、インライン再生や自動再生を許さないことがある
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.setAttribute('autoplay', '')
    video.muted = true

    let cancelled = false
    let scanner: QrScanner | null = null
    let watchdog: number | undefined
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
      // 起動したのに映像が来ない(真っ黒)ときは、タップで再開できるようにする
      watchdog = window.setInterval(() => {
        if (cancelled || done.current) return
        setStatus((s) => {
          if (s === 'scanning' && !hasFrames(video)) {
            setDebug(describe())
            return 'stalled'
          }
          if (s === 'stalled' && hasFrames(video)) return 'scanning'
          return s
        })
      }, 1500)
    }, 50)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(watchdog)
      scanner?.destroy()
      scannerRef.current = null
    }
  }, [nav])

  // タップ(ユーザー操作)の中で再生し直す。iOS はこれでないと再生を始めないことがある
  const resume = useCallback(async () => {
    const video = videoRef.current
    const scanner = scannerRef.current
    if (!video || !scanner) return
    try {
      await video.play()
      if (!hasFrames(video)) {
        // それでも映像が来なければカメラをつなぎ直す
        scanner.stop()
        await scanner.start()
      }
    } catch { /* 下で状態を見直す */ }
    window.setTimeout(() => {
      if (hasFrames(video)) setStatus('scanning')
      else setDebug(describe())
    }, 800)
  }, [])

  return (
    <div className="scan">
      <video ref={videoRef} className="scan-video" playsInline muted autoPlay />

      {/* 枠の外を暗くし、中央の正方形だけを見せる(大きな box-shadow は iOS で描画が崩れることがあるので SVG で描く) */}
      <svg className="scan-shade" aria-hidden>
        <defs>
          <mask id="scan-hole">
            <rect width="100%" height="100%" fill="white" />
            <rect x={(view.w - hole) / 2} y={(view.h - hole) / 2} width={hole} height={hole} rx="20" ry="20" fill="black" />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="rgba(0,0,0,0.55)" mask="url(#scan-hole)" />
      </svg>
      <div className={`scan-frame ${status === 'found' ? 'found' : ''}`} style={{ width: hole, height: hole }} aria-hidden>
        <span className="corner tl" /><span className="corner tr" />
        <span className="corner bl" /><span className="corner br" />
      </div>

      <header className="scan-top">
        <button className="scan-back" onClick={() => nav(-1)} aria-label="戻る">‹</button>
        <h1>QRコードを読み取る</h1>
        <span className="scan-back" />
      </header>

      {status === 'stalled' && (
        <button className="scan-resume" onClick={() => void resume()}>
          タップしてカメラを表示
          <small>{debug}</small>
        </button>
      )}

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
