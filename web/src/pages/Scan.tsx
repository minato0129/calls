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

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

// カメラを何回まで自動でつなぎ直すか(それでも映らなければ「タップして再開」を出す)
const AUTO_RETRY = 2

// アプリ内でQRを読み取る(iOS ではホーム画面のアプリと Safari でログイン状態が別なので、標準カメラで読むとうまくいかない)
//
// カメラの映像は <video> を直接見せず、<canvas> に描き写して見せる。
// iOS のホーム画面に追加したアプリでは、カメラは動いている(緑の点が付く)のに
// <video> が真っ黒のまま描かれないことがあるため。canvas への描き写しは映像そのものから読むので、この不具合の影響を受けない
export default function Scan() {
  const nav = useNavigate()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const done = useRef(false)
  const [status, setStatusState] = useState<Status>('starting')
  // 見張り役(setInterval)からも今の状態を読めるよう、ref にも持っておく
  const statusRef = useRef<Status>('starting')
  const setStatus = useCallback((s: Status) => { statusRef.current = s; setStatusState(s) }, [])
  const [message, setMessage] = useState('')
  const [hasFlash, setHasFlash] = useState(false)
  const [flashOn, setFlashOn] = useState(false)
  const [debug, setDebug] = useState('')
  const view = useViewport()
  // 枠の大きさ。暗くする SVG の穴と枠の両方をこの値で描く
  const hole = Math.min(view.w * 0.7, view.h * 0.7, 320)

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    const v = videoRef.current
    if (v) v.srcObject = null
    setHasFlash(false)
    setFlashOn(false)
  }, [])

  // カメラを開いて <video> につなぐ。つなぎ直すときは前のカメラを必ず止めてから開く
  // (iOS は前のカメラが残っていると、新しいほうの映像が来ないことがある)
  const openCamera = useCallback(async () => {
    stopCamera()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    })
    streamRef.current = stream
    const v = videoRef.current
    if (!v) { stream.getTracks().forEach((t) => t.stop()); return }
    v.srcObject = stream
    await v.play().catch(() => undefined) // 再生できないときは見張り役がつなぎ直す
    const track = stream.getVideoTracks()[0]
    const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & { torch?: boolean }
    setHasFlash(!!caps.torch)
  }, [stopCamera])

  const describe = () => {
    const v = videoRef.current
    if (!v) return ''
    const track = streamRef.current?.getVideoTracks()[0]
    return `video ${v.videoWidth}x${v.videoHeight} ready=${v.readyState} paused=${v.paused} ` +
      `track=${track ? `${track.readyState}${track.muted ? ' muted' : ''}` : 'なし'} standalone=${isStandalone()}`
  }

  useEffect(() => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return
    // iOS は属性として付いていないと、インライン再生や自動再生を許さないことがある
    video.setAttribute('playsinline', '')
    video.setAttribute('muted', '')
    video.muted = true

    let cancelled = false
    let raf = 0
    let scanTimer: number | undefined
    let watchdog: number | undefined
    let scanning = false
    let retries = 0
    let lastTime = -1
    let lastFrameAt = 0
    let darkCount = 0
    const engine = QrScanner.createQrEngine()
    const scanCanvas = document.createElement('canvas')
    const sample = document.createElement('canvas')
    sample.width = sample.height = 16
    const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
    const ctx = canvas.getContext('2d')

    const fail = (e: unknown) => {
      if (cancelled) return
      const name = (e as DOMException)?.name
      setStatus('error')
      setMessage(
        name === 'NotAllowedError' ? 'カメラの使用が許可されていません。設定でこのアプリのカメラを許可してください'
          : name === 'NotFoundError' ? 'カメラが見つかりませんでした'
            : name === 'NotReadableError' ? 'カメラをほかのアプリが使っています。ほかのアプリを閉じてから開き直してください'
              : `カメラを起動できませんでした(${name ?? e})`,
      )
    }

    const start = async () => {
      setStatus('starting')
      setMessage('')
      lastFrameAt = performance.now()
      darkCount = 0
      try {
        await openCamera()
        if (!cancelled && statusRef.current !== 'found') setStatus('scanning')
      } catch (e) { fail(e) }
    }

    // 映像を canvas に描き写す(画面いっぱいに、はみ出す分は切り取る)
    const draw = () => {
      raf = requestAnimationFrame(draw)
      if (video.readyState < 2 || video.videoWidth === 0) return
      if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastFrameAt = performance.now() }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const cw = Math.round(canvas.clientWidth * dpr)
      const ch = Math.round(canvas.clientHeight * dpr)
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch }
      const scale = Math.max(cw / video.videoWidth, ch / video.videoHeight)
      const dw = video.videoWidth * scale
      const dh = video.videoHeight * scale
      ctx?.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh)
    }
    raf = requestAnimationFrame(draw)

    // 画面の枠と同じ範囲(中央の正方形)だけを読む
    const scan = async () => {
      if (scanning || done.current || cancelled || video.readyState < 2 || video.videoWidth === 0) return
      scanning = true
      try {
        const size = Math.round(Math.min(video.videoWidth, video.videoHeight) * 0.7)
        const result = await QrScanner.scanImage(video, {
          scanRegion: { x: Math.round((video.videoWidth - size) / 2), y: Math.round((video.videoHeight - size) / 2), width: size, height: size },
          qrEngine: engine,
          canvas: scanCanvas,
          returnDetailedScanResult: true,
        })
        if (done.current || cancelled) return
        const m = result.data.match(/\/join\/([0-9a-f]+)/)
        if (!m) { setMessage('このアプリのQRコードではありません'); return }
        done.current = true
        setStatus('found')
        navigator.vibrate?.(80)
        // 枠が緑になったのを見せてから移る
        window.setTimeout(() => { stopCamera(); nav(`/join/${m[1]}`, { replace: true }) }, 250)
      } catch { /* QR が写っていないときもここに来る */ } finally { scanning = false }
    }

    // 映像が止まっている・真っ黒のままなら、自動でカメラをつなぎ直す
    const check = () => {
      if (cancelled || done.current) return
      const s = statusRef.current
      if (s !== 'scanning' && s !== 'stalled') return
      const track = streamRef.current?.getVideoTracks()[0]
      const stalled = performance.now() - lastFrameAt > 2500 || !track || track.readyState === 'ended'
      // 届いた映像がまったくの黒か(レンズをふさいでいる場合も黒いが、自動のつなぎ直しを数回するだけ)
      if (!stalled && sampleCtx && video.videoWidth > 0) {
        sampleCtx.drawImage(video, 0, 0, 16, 16)
        const d = sampleCtx.getImageData(0, 0, 16, 16).data
        let max = 0
        for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2])
        darkCount = max < 8 ? darkCount + 1 : 0
      }
      if (!stalled && darkCount < 3) {
        retries = 0
        if (s === 'stalled') setStatus('scanning')
        return
      }
      if (s === 'stalled') return
      if (retries < AUTO_RETRY) {
        retries++
        void start()
        return
      }
      setDebug(describe())
      setStatus('stalled')
    }

    // ほかのアプリに切り替えると iOS はカメラを止めるので、戻ってきたら開き直す
    const onVisible = () => {
      if (cancelled || done.current) return
      if (document.visibilityState === 'hidden') stopCamera()
      else { retries = 0; void start() }
    }

    // 開発時(React の StrictMode)は画面が「作る→片付ける→作る」と2回動く。
    // すぐにカメラを起動すると、1回目の片付けが2回目のカメラまで止めてしまうので、少し遅らせて起動し、1回目は起動前に取り消す
    const timer = window.setTimeout(() => {
      if (cancelled) return
      void start()
      scanTimer = window.setInterval(() => void scan(), 120)
      watchdog = window.setInterval(check, 1000)
      document.addEventListener('visibilitychange', onVisible)
    }, 50)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearInterval(scanTimer)
      window.clearInterval(watchdog)
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisible)
      stopCamera()
      void engine.then((e) => { if (e instanceof Worker) e.terminate() }).catch(() => undefined)
    }
  }, [nav, openCamera, stopCamera, setStatus])

  // タップ(ユーザー操作)の中でカメラを開き直す。iOS はこれでないと映像を出さないことがある
  const resume = useCallback(async () => {
    setStatus('starting')
    setMessage('')
    try {
      await openCamera()
      setStatus('scanning')
    } catch (e) {
      setStatus('error')
      setMessage(`カメラを起動できませんでした(${(e as DOMException)?.name ?? e})`)
    }
  }, [openCamera, setStatus])

  const toggleFlash = async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !flashOn } as MediaTrackConstraintSet] })
      setFlashOn(!flashOn)
    } catch { setHasFlash(false) }
  }

  return (
    <div className="scan">
      {/* 映像の元。見せるのは上に重ねた canvas(<video> は iOS のホーム画面アプリで黒いままになることがある) */}
      <video ref={videoRef} className="scan-video" playsInline muted />
      <canvas ref={canvasRef} className="scan-video" aria-hidden />

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
        <button className="scan-back" onClick={() => { stopCamera(); nav(-1) }} aria-label="戻る">‹</button>
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
        {status === 'error' && (
          <button className="scan-flash" onClick={() => void resume()}>もう一度試す</button>
        )}
        {hasFlash && status === 'scanning' && (
          <button className="scan-flash" onClick={() => void toggleFlash()}>
            {flashOn ? 'ライトを消す' : 'ライトをつける'}
          </button>
        )}
      </div>
    </div>
  )
}
