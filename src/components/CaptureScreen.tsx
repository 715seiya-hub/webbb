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

interface Stats {
  readonly attempts: number
  readonly lastStatus: string
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
  if (!w || !h)
    return {
      blob: null,
      reason: `video not ready (readyState=${video.readyState}, ${w}x${h})`,
    }

  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { blob: null, reason: 'no 2d ctx' }

  ctx.drawImage(video, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85)
  )
  return blob
    ? { blob, reason: `captured ${w}x${h}` }
    : { blob: null, reason: 'toBlob failed' }
}

async function callOcr(
  blob: Blob,
  deep: boolean
): Promise<{
  text: string
  source?: string
  fallbackFrom?: string
  finishReason?: string
  blockReason?: string
  bytes?: number
}> {
  const form = new FormData()
  form.append('image', blob, 'frame.jpg')
  if (deep) form.append('deep', '1')

  const res = await fetch('/api/ocr', { method: 'POST', body: form })

  if (!res.ok) {
    let detail = ''
    try {
      const body = await res.json()
      if (body.status === 429) detail = 'RATE LIMIT (429)'
      else if (body.status) detail = `${body.error ?? 'err'} ${body.status}`
      else if (body.error) detail = body.error
    } catch {
      /* ignore */
    }
    throw new Error(`OCR ${res.status}${detail ? ` · ${detail}` : ''}`)
  }

  return await res.json()
}

export function CaptureScreen() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const intervalRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const busyRef = useRef(false)
  const deepRef = useRef(false)

  const [running, setRunning] = useState(false)
  const [interval, setInterval_] = useState(7)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [camVisible, setCamVisible] = useState(true)
  const [deepMode, setDeepMode] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [zoomCaps, setZoomCaps] = useState<ZoomCaps | null>(null)
  const [results, setResults] = useState<readonly ResultItem[]>([])
  const [camError, setCamError] = useState<string | null>(null)
  const [camReady, setCamReady] = useState(false)
  const [reading, setReading] = useState(false)
  const [stats, setStats] = useState<Stats>({ attempts: 0, lastStatus: '—' })
  const [camRetry, setCamRetry] = useState(0)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [camLabel, setCamLabel] = useState('')

  // Enumerate cameras
  useEffect(() => {
    async function listDevices() {
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = all.filter((d) => d.kind === 'videoinput')
        setDevices(videoDevices)
      } catch {
        /* ignore */
      }
    }
    listDevices()

    navigator.mediaDevices.addEventListener('devicechange', listDevices)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', listDevices)
    }
  }, [])

  // Camera init
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        setCamReady(false)
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null

        const constraints: MediaStreamConstraints = {
          video: selectedDeviceId
            ? { deviceId: { exact: selectedDeviceId } }
            : { facingMode: { ideal: facing } },
          audio: false,
        }

        const stream = await navigator.mediaDevices.getUserMedia(constraints)

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        streamRef.current = stream
        const vid = videoRef.current
        if (vid) {
          vid.srcObject = stream
          try {
            await vid.play()
          } catch {
            vid.muted = true
            await vid.play()
          }
          setCamReady(true)
        }

        const track = stream.getVideoTracks()[0]
        setCamLabel(track?.label ?? '')

        // Re-enumerate to get labels (available after permission granted)
        const all = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = all.filter((d) => d.kind === 'videoinput')
        setDevices(videoDevices)

        const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>
        if (caps.zoom) {
          const z = caps.zoom as { min: number; max: number; step?: number }
          setZoomCaps({ min: z.min, max: z.max, step: z.step || 0.1 })
          setZoom(z.min)
        } else {
          setZoomCaps(null)
          setZoom(1)
        }
        setCamError(null)
      } catch (err) {
        setCamError(
          err instanceof Error ? err.message : 'カメラを起動できませんでした'
        )
      }
    }

    init()
    return () => {
      cancelled = true
    }
  }, [facing, selectedDeviceId, camRetry])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current)
    }
  }, [])

  // Capture + OCR
  const doCapture = useCallback(async () => {
    if (busyRef.current) return

    setStats((s) => ({ ...s, attempts: s.attempts + 1 }))

    const { blob, reason } = await captureFrame(
      videoRef.current,
      canvasRef.current
    )
    if (!blob) {
      setStats((s) => ({ ...s, lastStatus: reason }))
      return
    }

    busyRef.current = true
    setReading(true)

    try {
      const data = await callOcr(blob, deepRef.current)
      const text = data.text.trim()

      if (text.length === 0 || text === '？' || text === '?') {
        const why =
          text === '？' || text === '?'
            ? 'no quiz visible'
            : (data.blockReason ??
              data.finishReason ??
              (data.bytes ? `${(data.bytes / 1024).toFixed(0)}KB` : 'no reason'))
        setStats((s) => ({ ...s, lastStatus: `skip (${why})` }))
        return
      }

      const tag = data.fallbackFrom
        ? ` [${data.source} ← ${data.fallbackFrom}]`
        : data.source && data.source !== 'gemini'
          ? ` [${data.source}]`
          : ''

      setStats((s) => ({
        ...s,
        lastStatus: `ok ${text.length} chars${tag}`,
      }))

      setResults((prev) => {
        const last = prev[prev.length - 1]
        if (last && normalize(last.text) === normalize(text)) return prev
        return [...prev, { id: crypto.randomUUID(), text, at: Date.now() }]
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setStats((s) => ({ ...s, lastStatus: `error: ${msg.slice(0, 80)}` }))
    } finally {
      busyRef.current = false
      setReading(false)
    }
  }, [])

  // Auto-capture interval
  useEffect(() => {
    if (!running) {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    doCapture()
    intervalRef.current = window.setInterval(doCapture, interval * 1000)

    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [running, interval, doCapture])

  // Auto-scroll results
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [results])

  // Sync deepRef
  useEffect(() => {
    deepRef.current = deepMode
  }, [deepMode])

  // Zoom
  useEffect(() => {
    if (!zoomCaps) return
    const track = streamRef.current?.getVideoTracks()[0]
    if (track) {
      track
        .applyConstraints({ advanced: [{ zoom } as MediaTrackConstraintSet] })
        .catch(() => {})
    }
  }, [zoom, zoomCaps])

  return (
    <main className="flex h-dvh flex-col">
      {/* Main content */}
      <div className="flex min-h-0 flex-1 flex-col landscape:flex-row">
        {/* Camera */}
        <section
          className={`relative overflow-hidden bg-black ${camVisible ? 'min-h-[40vh] landscape:min-h-0 flex-1' : 'hidden'}`}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 h-full w-full object-contain"
          />
          {!camReady && !camError && (
            <div className="absolute inset-0 flex items-center justify-center bg-black text-sm text-neutral-400">
              カメラを起動中...
            </div>
          )}
          {camError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 p-6 text-center text-sm text-red-300">
              <p>{camError}</p>
              <button
                type="button"
                onClick={() => {
                  setCamError(null)
                  setCamRetry((n) => n + 1)
                }}
                className="rounded-full bg-neutral-700 px-4 py-2 text-xs text-white"
              >
                再試行
              </button>
            </div>
          )}
          {reading && (
            <div className="absolute right-3 top-3 rounded-full bg-black/60 px-3 py-1 text-xs text-neutral-200">
              読み取り中…
            </div>
          )}
          {zoomCaps && (
            <div className="absolute left-3 top-3 rounded-full bg-black/60 px-3 py-1 font-mono text-xs text-white">
              🔍 {(zoom / zoomCaps.min).toFixed(1)}x
            </div>
          )}
          {(running || stats.attempts > 0) && (
            <div className="absolute bottom-3 left-3 right-3 rounded bg-black/70 px-2 py-1 font-mono text-[11px] text-neutral-100">
              <div>
                attempts: {stats.attempts} · busy: {reading ? 'yes' : 'no'}
              </div>
              <div className="break-all">{stats.lastStatus}</div>
            </div>
          )}
        </section>

        {/* Results */}
        <section
          ref={scrollRef}
          className="min-h-[120px] flex-1 overflow-y-auto border-t border-neutral-700 bg-white px-4 py-3 text-base leading-relaxed text-black landscape:border-l landscape:border-t-0"
        >
          {results.length === 0 ? (
            <p className="text-neutral-600">
              {running
                ? '回答待ち…（クイズ問題を画面に映してください）'
                : '「開始」を押すと自動で、または「📸 撮影」で1枚だけ判定します。'}
            </p>
          ) : (
            <ul className="space-y-3">
              {results.map((r) => (
                <li
                  key={r.id}
                  className="border-l-2 border-neutral-400 pl-3"
                >
                  <div className="text-xs tabular-nums text-neutral-600">
                    {new Date(r.at).toLocaleTimeString('ja-JP', {
                      hour12: false,
                    })}
                  </div>
                  <div className="whitespace-pre-wrap font-semibold text-black">
                    {r.text}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Controls */}
      <div className="flex flex-col gap-2 border-t border-neutral-800 bg-neutral-900 px-3 py-2">
        {/* Top row: settings */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Timer slider */}
          <label className="flex min-w-[100px] flex-1 items-center gap-2 text-xs text-neutral-200">
            <span className="w-7 tabular-nums">{interval}s</span>
            <input
              type="range"
              min={4}
              max={15}
              step={1}
              value={interval}
              onChange={(e) => setInterval_(Number(e.target.value))}
              className="flex-1 accent-emerald-500"
            />
          </label>

          {/* Mode toggle */}
          <div className="flex overflow-hidden rounded-full border border-neutral-500 text-xs">
            <button
              type="button"
              onClick={() => setDeepMode(false)}
              className={`px-3 py-1.5 transition active:scale-95 ${
                deepMode
                  ? 'text-neutral-300'
                  : 'bg-emerald-500 font-semibold text-black'
              }`}
              aria-pressed={!deepMode}
            >
              ⚡ 通常
            </button>
            <button
              type="button"
              onClick={() => setDeepMode(true)}
              className={`px-3 py-1.5 transition active:scale-95 ${
                deepMode
                  ? 'bg-purple-500 font-semibold text-white'
                  : 'text-neutral-300'
              }`}
              aria-pressed={deepMode}
            >
              🧠 じっくり
            </button>
          </div>

          {/* Camera buttons */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setCamVisible((v) => !v)}
              className="rounded-full border border-neutral-500 px-3 py-1.5 text-xs text-neutral-100 active:scale-95"
              aria-label="カメラ表示切替"
            >
              {camVisible ? '📷 隠す' : '📷 表示'}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelectedDeviceId(null)
                setFacing((f) =>
                  f === 'environment' ? 'user' : 'environment'
                )
              }}
              className="rounded-full border border-neutral-500 px-3 py-1.5 text-xs text-neutral-100 active:scale-95"
              aria-label="カメラ切替"
            >
              ⟲ {facing === 'environment' ? '背面' : '前面'}
            </button>
            {/* Camera lens selector (wide, normal, etc.) */}
            {devices.filter((d) => d.label).length > 1 && (
              <select
                value={selectedDeviceId ?? ''}
                onChange={(e) => {
                  const id = e.target.value
                  if (id) {
                    setSelectedDeviceId(id)
                  } else {
                    setSelectedDeviceId(null)
                  }
                }}
                className="rounded-full border border-neutral-500 bg-neutral-800 px-2 py-1.5 text-xs text-neutral-100"
                aria-label="カメラレンズ選択"
              >
                <option value="">自動</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label.replace(/\s*\(.*?\)\s*/g, '').slice(0, 20) ||
                      `カメラ ${d.deviceId.slice(0, 4)}`}
                  </option>
                ))}
              </select>
            )}
          </div>
          {/* Current camera label */}
          {camLabel && (
            <span className="text-[10px] text-neutral-500">
              {camLabel.slice(0, 30)}
            </span>
          )}
        </div>

        {/* Zoom slider */}
        {zoomCaps && (
          <div className="flex items-center gap-3 text-xs text-neutral-200">
            <span className="w-14 tabular-nums">
              🔍 {(zoom / zoomCaps.min).toFixed(1)}x
            </span>
            <input
              type="range"
              min={zoomCaps.min}
              max={zoomCaps.max}
              step={zoomCaps.step}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="flex-1 accent-emerald-500"
              aria-label="ズーム"
            />
            <button
              type="button"
              onClick={() => setZoom(zoomCaps.min)}
              className="rounded-full border border-neutral-500 px-2 py-1 text-[10px] text-neutral-100 active:scale-95"
            >
              1x
            </button>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setRunning((r) => !r)}
            className={`flex-1 rounded-full px-4 py-3 text-lg font-bold shadow-md transition active:scale-95 ${
              running
                ? 'bg-red-500 text-white'
                : 'bg-emerald-500 text-black'
            }`}
          >
            {running ? '■ 停止' : '▶ 開始'}
          </button>
          <button
            type="button"
            onClick={doCapture}
            disabled={reading}
            className="flex-1 rounded-full bg-blue-500 px-4 py-3 text-lg font-bold text-white shadow-md transition active:scale-95 disabled:opacity-50"
          >
            📸 撮影
          </button>
        </div>
      </div>

      {/* Hidden canvas for capture */}
      <canvas ref={canvasRef} className="hidden" />
    </main>
  )
}
