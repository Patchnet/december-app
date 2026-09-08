import { softWeatherIcon } from './soft-weather.js'
// Optional display data. Never a block type or a filing instruction.
// Codes are Open-Meteo's documented WMO subset, not every WMO code table.
export const WEATHER_CODES = {
  0: ['Clear sky', 'clear'], 1: ['Mainly clear', 'clear'],
  2: ['Partly cloudy', 'partly-cloudy'], 3: ['Overcast', 'overcast'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'drizzle'], 53: ['Moderate drizzle', 'drizzle'], 55: ['Dense drizzle', 'drizzle'],
  56: ['Light freezing drizzle', 'sleet'], 57: ['Dense freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'], 63: ['Moderate rain', 'rain'], 65: ['Heavy rain', 'rain'],
  66: ['Light freezing rain', 'sleet'], 67: ['Heavy freezing rain', 'sleet'],
  71: ['Light snow', 'snow'], 73: ['Moderate snow', 'snow'], 75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'], 80: ['Light rain showers', 'rain'],
  81: ['Moderate rain showers', 'rain'], 82: ['Violent rain showers', 'rain'],
  85: ['Light snow showers', 'snow'], 86: ['Heavy snow showers', 'snow'],
  95: ['Thunderstorm', 'thunderstorms'], 96: ['Thunderstorm with light hail', 'thunderstorms-hail'],
  99: ['Thunderstorm with heavy hail', 'thunderstorms-hail'],
}

export const ASSET_NAME = /^[a-f0-9]{64}\.(?:jpg|png|webp)$/
const text = (v, max = 180) => typeof v === 'string' ? v.trim().slice(0, max) : ''
export function sourceURL(raw) {
  try {
    const u = new URL(raw)
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return ''
    u.hash = ''
    return u.href.length <= 2048 ? u.href : ''
  } catch { return '' }
}

export function weatherFor(code, isDay) {
  const [label, base] = (Number.isInteger(code) && WEATHER_CODES[code]) || ['Condition unavailable', 'not-available']
  const icon = base === 'clear' || base === 'partly-cloudy'
    ? isDay === true ? `${base}-day` : isDay === false ? `${base}-night` : 'not-available'
    : base
  return { label, icon }
}

export function temperature(celsius, unit = 'C') {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return '—'
  return `${Math.round(unit === 'F' ? celsius * 9 / 5 + 32 : celsius)}°${unit === 'F' ? 'F' : 'C'}`
}

export function normalizePreview(raw) {
  if (!raw || typeof raw !== 'object') return null
  const source = sourceURL(raw.source)
  if (!source) return null
  const common = { kind: raw.kind, source, credit: text(raw.credit, 80), sample: raw.sample === true }
  if (raw.kind === 'image') {
    if (!ASSET_NAME.test(raw.asset || '')) return null
    return { ...common, asset: raw.asset, alt: text(raw.alt), fit: raw.fit === 'contain' ? 'contain' : 'cover' }
  }
  if (raw.kind !== 'weather') return null
  const stamp = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : ''
  const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -150 && v <= 100 ? v : null
  return {
    ...common, location: text(raw.location, 100), code: Number.isInteger(raw.code) ? raw.code : null,
    isDay: typeof raw.isDay === 'boolean' ? raw.isDay : null,
    celsius: finite(raw.celsius), feelsCelsius: finite(raw.feelsCelsius),
    unit: raw.unit === 'F' ? 'F' : 'C', observedAt: stamp(raw.observedAt), expiresAt: stamp(raw.expiresAt),
    status: ['ready', 'stale', 'unavailable'].includes(raw.status) ? raw.status : 'unavailable',
  }
}

// Compact cards already expose this exact source in their preview caption.
// Only collapse a standalone URL; preserve prose, other links and full notes.
export function previewNoteText(raw, preview, full = false) {
  const p = normalizePreview(preview)
  if (full || !p) return raw
  return String(raw).split('\n').filter(line => {
    const value = line.trim()
    if (!/^https?:\/\/\S+$/.test(value)) return true
    try { return new URL(value).href !== p.source } catch { return true }
  }).join('\n').trim()
}

const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
export function weatherScene(raw) {
  const p = normalizePreview(raw)
  if (p?.kind !== 'weather') return ''
  const {icon,label} = p.status === 'unavailable' ? weatherFor(null,null) : weatherFor(p.code,p.isDay)
  const night = p.isDay === false && icon !== 'not-available'
  return `<div class="weather-scene" data-sky="${icon}" data-night="${night}" aria-hidden="true"><div class="sky-light"></div><div class="sky-haze"></div><div class="sky-art">${softWeatherIcon(icon,label)}</div></div>`
}

export function previewHTML(raw, now = Date.now(), sceneInHeader = false) {
  const p = normalizePreview(raw)
  if (!p) return ''
  const credit = p.credit || new URL(p.source).hostname
  const caption = `<figcaption><a href="${esc(p.source)}" target="_blank" rel="noopener noreferrer">${esc(credit)} ↗</a>${p.sample ? '<span>Sample</span>' : ''}</figcaption>`
  if (p.kind === 'image') return `<figure class="note-preview image-preview"><img src="/api/preview-assets/${p.asset}" alt="${esc(p.alt)}" loading="lazy" decoding="async" width="640" height="400" style="object-fit:${p.fit}" data-preview-image><div class="image-unavailable" hidden>Image unavailable · your note is still here</div>${caption}</figure>`
  const missing = p.status === 'unavailable'
  const stale = !missing && (p.status === 'stale' || !p.expiresAt || Date.parse(p.expiresAt) <= now)
  const { label } = missing ? weatherFor(null, null) : weatherFor(p.code, p.isDay)
  const time = p.observedAt ? new Date(p.observedAt).toLocaleString('en', {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : ''
  return `<figure class="note-preview weather-preview${sceneInHeader ? ' weather-below' : ''}">${sceneInHeader ? '' : weatherScene(p)}<div class="weather-reading"><div><p class="preview-place">${esc(p.location || 'Location unavailable')}</p><div class="preview-temperature">${missing ? '—' : temperature(p.celsius, p.unit)}</div></div><div class="weather-description"><p class="preview-condition">${esc(label)}</p>${!missing && p.feelsCelsius !== null ? `<p class="preview-feels">Feels like ${temperature(p.feelsCelsius, p.unit)}</p>` : ''}</div></div><p class="preview-freshness">${missing ? 'Weather unavailable' : stale ? 'Saved forecast · may be out of date' : 'Forecast snapshot'}${time ? ` · ${esc(time)}` : ''}</p>${caption}</figure>`
}

// One delegated handler also covers a card that is opened or repainted later.
export function installPreviewFallbacks(root = document) {
  const fail = (e) => {
    const img = e.target
    if (!img?.matches?.('[data-preview-image]')) return
    img.hidden = true
    const fallback = img.nextElementSibling
    if (fallback) fallback.hidden = false
  }
  root.addEventListener('error', fail, true)
  return () => root.removeEventListener('error', fail, true)
}
