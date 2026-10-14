// In-memory preview timings only. No text, keys, or telemetry are retained.
const requests = new Map()
const captures = new Map()
export function startCaptureTiming(requestId, startedAt) {
  if (requests.size > 100) requests.clear()
  requests.set(requestId, startedAt)
}
export function acknowledgeCaptureTiming(receipt) {
  const started = requests.get(receipt?.requestId)
  if (started === undefined) return
  requests.delete(receipt.requestId)
  for (const id of receipt.captureIds || []) {
    captures.set(id, started)
    if(captures.size>256)captures.delete(captures.keys().next().value)
  }
}
export function measureCapturePaint(snapshot, flying = 0) {
  if (document.hidden || flying) return
  const pending = new Set(snapshot.captures.map(c => c.id))
  const filed = new Set(snapshot.filedCaptureIds || snapshot.activity.map(a => a.captureId))
  for (const [id, started] of captures) {
    if (pending.has(id) || !filed.has(id)) continue
    captures.delete(id)
    // Two frames bracket a paint opportunity; this is not a display-device trace.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const panel = document.querySelector('.jev-paint-time')
      if (panel) panel.textContent = `Latest capture → screen: ${Math.round(performance.now() - started)} ms`
    }))
  }
}
