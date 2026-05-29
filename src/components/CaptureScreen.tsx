'use client'

import { useRef, useState, useEffect, useCallback } from 'react'

interface ResultItem {
  readonly id: string
  readonly text: string
  readonly at: number
}

interface ZoomCaps {
  readonly min: number
  readonly max: number
  readonly step: number
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

async function captureFrame(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null
): Promise<{ blob: Blob | null; reason: string }> {
  if (!video || !canvas) return { blob: null, reason: 'no video/canvas' }

  const w = video.videoWidth
  const h = video.videoHeight
  if (!w || !h) return { blob: null, reason: `video not ready ${w}x${h}` }

  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { blob: null, reason: 'no 2d ctx' }

  ctx.drawImage(video, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.6)
  )
  return blob ? { blob, reason: '' } : { blob: null, reason: 'toBlob failed' }
}

async function callOcr(blob: Blob, deep: boolean) {
  const form = new FormData()
  form.append('image', blob, 'frame.jpg')
  if (deep) form.append('deep', '1')

  const res = await fetch('/api/ocr', { method: 'POST', body: form })
  const data = await res.json()

  if (!res.ok || !data.ok) {
    const msg = data.error ?? data.detail ?? `HTTP ${res.status}`
    throw new Error(msg)
  }

  return data as { text: string; source?: string; finishReason?: string; blockReason?: string }
}

export function CaptureScreen() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const busyRef = useRef(false)
  const deepRef = useRef(false)

  const [running, setRunning] = useState(false)
  const [sec, setSec] = useState(5)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [showCam, setShowCam] = useState(true)
  const [deep, setDeep] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [zoomCaps, setZoomCaps] = useState<ZoomCaps | null>(null)
  const [results, setResults] = useState<readonly ResultItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [camReady, setCamReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState('—')
  const [retryKey, setRetryKey] = useState(0)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [camName, setCamName] = useState('')

  // ── Camera ──
  useEffect(() => {
    let dead = false
    setCamReady(false)
    setError(null)

    async function start() {
      try {
        streamRef.current?.getTracks().forEach((t) => t.stop())
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId } }
            : { facingMode: { ideal: facing } },
          audio: false,
        })
        if (dead) { stream.getTracks().forEach((t) => t.stop()); return }

        streamRef.current = stream
        const vid = videoRef.current
        if (vid) {
          vid.srcObject = stream
          vid.muted = true
          await vid.play().catch(() => {})
          setCamReady(true)
        }

        const track = stream.getVideoTracks()[0]
        setCamName(track?.label ?? '')

        // Enumerate after permission granted (to get labels)
        const all = await navigator.mediaDevices.enumerateDevices()
        if (!dead) setDevices(all.filter((d) => d.kind === 'videoinput'))

        const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>
        if (caps.zoom) {
          const z = caps.zoom as { min: number; max: number; step?: number }
          setZoomCaps({ min: z.min, max: z.max, step: z.step || 0.1 })
          setZoom(z.min)
        } else {
          setZoomCaps(null)
        }
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : 'カメラ起動失敗')
      }
    }

    start()
    return () => { dead = true }
  }, [facing, deviceId, retryKey])

  // Cleanup
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    if (timerRef.current !== null) clearInterval(timerRef.current)
  }, [])

  // ── Capture + OCR ──
  const capture = useCallback(async () => {
    if (busyRef.current) return
    const { blob, reason } = await captureFrame(videoRef.current, canvasRef.current)
    if (!blob) { setLog(reason); return }

    busyRef.current = true
    setBusy(true)
    setLog('送信中…')

    try {
      const data = await callOcr(blob, deepRef.current)
      const text = data.text.trim()

      if (!text || text === '？' || text === '?') {
        setLog('問題が見つかりません — スキップ')
        return
      }

      setLog(`✓ ${text.length}文字 [${data.source}]`)
      setResults((prev) => {
        const last = prev[prev.length - 1]
        if (last && normalize(last.text) === normalize(text)) return prev
        return [...prev, { id: crypto.randomUUID(), text, at: Date.now() }]
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setLog(`✗ ${msg.slice(0, 120)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  // ── Auto-capture timer ──
  useEffect(() => {
    if (!running) {
      if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null }
      return
    }
    capture()
    timerRef.current = window.setInterval(capture, sec * 1000)
    return () => { if (timerRef.current !== null) { clearInterval(timerRef.current); timerRef.current = null } }
  }, [running, sec, capture])

  // Auto-scroll
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }) }, [results])
  // Sync ref
  useEffect(() => { deepRef.current = deep }, [deep])
  // Zoom
  useEffect(() => {
    if (!zoomCaps) return
    streamRef.current?.getVideoTracks()[0]
      ?.applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] })
      .catch(() => {})
  }, [zoom, zoomCaps])

  return (
    <main className="flex h-dvh flex-col">
      {/* ── Content area ── */}
      <div className="flex min-h-0 flex-1 flex-col landscape:flex-row">

        {/* Camera */}
        <section className={`relative overflow-hidden bg-black ${showCam ? 'min-h-[35vh] landscape:min-h-0 flex-1' : 'hidden'}`}>
          <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-contain" />

          {!camReady && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-neutral-400 text-sm">カメラ起動中…</div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-4 text-center">
              <p className="text-red-300 text-sm">{error}</p>
              <button type="button" onClick={() => { setError(null); setRetryKey((n) => n + 1) }}
                className="rounded-full bg-neutral-700 px-4 py-2 text-xs text-white">再試行</button>
            </div>
          )}
          {busy && <div className="absolute right-2 top-2 rounded-full bg-black/60 px-3 py-1 text-xs text-neutral-200">読み取り中…</div>}
          {zoomCaps && <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-1 font-mono text-xs text-white">🔍{(zoom / zoomCaps.min).toFixed(1)}x</div>}

          {/* Debug log */}
          <div className="absolute bottom-2 left-2 right-2 rounded bg-black/70 px-2 py-1 font-mono text-[11px] text-neutral-200 break-all">
            {log}
          </div>
        </section>

        {/* Results */}
        <section ref={scrollRef}
          className="min-h-[100px] flex-1 overflow-y-auto border-t border-neutral-700 bg-white px-4 py-3 text-base leading-relaxed text-black landscape:border-l landscape:border-t-0">
          {results.length === 0 ? (
            <p className="text-neutral-500">
              {running ? '回答待ち…（クイズ問題を画面に映してください）' : '「開始」を押すと自動で、「📸 撮影」で1枚だけ判定します。'}
            </p>
          ) : (
            <ul className="space-y-3">
              {results.map((r) => (
                <li key={r.id} className="border-l-2 border-neutral-400 pl-3">
                  <div className="text-xs tabular-nums text-neutral-500">{new Date(r.at).toLocaleTimeString('ja-JP', { hour12: false })}</div>
                  <div className="whitespace-pre-wrap font-semibold text-black">{r.text}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* ── Controls ── */}
      <div className="flex flex-col gap-2 border-t border-neutral-800 bg-neutral-900 px-3 py-2">

        {/* Row 1: slider + mode + cam buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-[90px] flex-1 items-center gap-1 text-xs text-neutral-200">
            <span className="w-7 tabular-nums">{sec}s</span>
            <input type="range" min={3} max={30} step={1} value={sec}
              onChange={(e) => setSec(Number(e.target.value))} className="flex-1 accent-emerald-500" />
          </label>

          <div className="flex overflow-hidden rounded-full border border-neutral-500 text-xs">
            <button type="button" onClick={() => setDeep(false)}
              className={`px-3 py-1.5 transition active:scale-95 ${deep ? 'text-neutral-300' : 'bg-emerald-500 font-semibold text-black'}`}>⚡ 通常</button>
            <button type="button" onClick={() => setDeep(true)}
              className={`px-3 py-1.5 transition active:scale-95 ${deep ? 'bg-purple-500 font-semibold text-white' : 'text-neutral-300'}`}>🧠 じっくり</button>
          </div>

          <button type="button" onClick={() => setShowCam((v) => !v)}
            className="rounded-full border border-neutral-500 px-3 py-1.5 text-xs text-neutral-100 active:scale-95">
            {showCam ? '📷隠す' : '📷表示'}
          </button>
          <button type="button" onClick={() => { setDeviceId(null); setFacing((f) => f === 'environment' ? 'user' : 'environment') }}
            className="rounded-full border border-neutral-500 px-3 py-1.5 text-xs text-neutral-100 active:scale-95">
            ⟲ {facing === 'environment' ? '背面' : '前面'}
          </button>

          {devices.filter((d) => d.label).length > 1 && (
            <select value={deviceId ?? ''} onChange={(e) => setDeviceId(e.target.value || null)}
              className="rounded-full border border-neutral-500 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100">
              <option value="">自動</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label.replace(/\s*\(.*?\)/g, '').slice(0, 20) || `cam-${d.deviceId.slice(0, 4)}`}
                </option>
              ))}
            </select>
          )}
          {camName && <span className="text-[10px] text-neutral-500">{camName.slice(0, 25)}</span>}
        </div>

        {/* Zoom */}
        {zoomCaps && (
          <div className="flex items-center gap-2 text-xs text-neutral-200">
            <span className="w-12 tabular-nums">🔍{(zoom / zoomCaps.min).toFixed(1)}x</span>
            <input type="range" min={zoomCaps.min} max={zoomCaps.max} step={zoomCaps.step} value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))} className="flex-1 accent-emerald-500" />
            <button type="button" onClick={() => setZoom(zoomCaps.min)}
              className="rounded-full border border-neutral-500 px-2 py-1 text-[10px] text-neutral-100 active:scale-95">1x</button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          <button type="button" onClick={() => setRunning((r) => !r)}
            className={`flex-1 rounded-full px-4 py-3 text-lg font-bold shadow-md transition active:scale-95 ${running ? 'bg-red-500 text-white' : 'bg-emerald-500 text-black'}`}>
            {running ? '■ 停止' : '▶ 開始'}
          </button>
          <button type="button" onClick={capture} disabled={busy}
            className="flex-1 rounded-full bg-blue-500 px-4 py-3 text-lg font-bold text-white shadow-md transition active:scale-95 disabled:opacity-50">
            📸 撮影
          </button>
        </div>
      </div>

      <canvas ref={canvasRef} className="hidden" />
    </main>
  )
}
