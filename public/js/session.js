// Shared page session. Feature modules read and write this object;
// they do not keep their own copy of the year. New page features get a
// file under public/js/ — they do not grow app.js unless they are boot,
// poll, or this session object.

export const $ = (sel) => document.querySelector(sel)
export const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

export const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const fmtAmount = (n, unit) => {
  const v = Number(n) || 0
  const s = Math.abs(v) >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100)
  return unit === '$' ? `$${s}` : `${s}${unit ? ` ${unit}` : ''}`
}

export function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.classList.add('show')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => el.classList.remove('show'), 2600)
}

export async function api(path, body) {
  const res = await fetch(path, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'request failed')
  return data
}

export const page = {
  state: null,
  prev: null,
  booting: true,
  spaceEls: new Map(),
  pollTimer: null,
  pending: new Set(),
  flying: 0,
  focusId: null,
  yearOpen: false,
  yearShown: null,
  restOpen: '',
  awake: new Set(),
  attentionCount: 0,
  queuedTexts: [],
  reachedFor: false,
  coIndex: 0,
  coAnswered: new Map(),
  coParked: false,
  field: null,
  enterHint: null,
}

export const hooks = {
  render() {},
  renderStage() {},
  fitCapture() {},
  renderSuggestions() {},
  schedulePoll() {},
  jumpToSpace() {},
}
