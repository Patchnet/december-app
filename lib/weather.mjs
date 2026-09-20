// Weather is the one watch that has a better answer than a web page: a
// forecast service that speaks in the codes the card already knows
// (public/js/preview-model.js keeps Open-Meteo's WMO subset). So a watched
// block that reads like "weather in Tallahassee" skips the search and asks
// Open-Meteo directly, and what comes back is a preview beside the page —
// the designed weather card — not an excerpt filed as prose.
//
// Still behind the watch gate: nothing here runs for an untagged block, and
// nothing here writes a word onto the person's page. The card is decoration
// (lib/previews.mjs); the block stays exactly the words they wrote.

const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const TIMEOUT_MS = 12_000
export const WEATHER_TTL_MS = 60 * 60 * 1000 // a reading is good for an hour

/** The place a weather query names, or null when the words are not a
    weather ask. "weather in Tallahassee", "Tallahassee weather", "track the
    weather here in tallahassee" all name Tallahassee; "weather" alone does
    not — there is no place to look up, so it falls back to the web. */
export function weatherPlace(query) {
  const q = String(query || '').trim().replace(/[.!?]+$/, '')
  if (!q || !/\bweather\b|\bforecast\b/i.test(q)) return null
  const lead = /^(?:(?:please\s+)?(?:track|watch|follow|check|keep (?:track of|an eye on)|keep)\s+)?(?:the\s+|today'?s\s+|this week'?s\s+)?(?:local\s+)?(?:weather|forecast)(?:\s+forecast)?(?:\s+(?:for|in|at|around|here in|over in|near))?\s*(.*)$/i.exec(q)
  const tail = /^(.+?)\s+(?:weather|forecast)(?:\s+forecast)?$/i.exec(q)
  const raw = lead ? lead[1] : tail ? tail[1] : ''
  const place = raw.replace(/^(?:for|in|at|here in|near)\s+/i, '').replace(/^(?:the\s+)?/i, '').replace(/\s+/g, ' ').trim()
  return place && place.length <= 80 && !/^(?:here|today|now|this week)$/i.test(place) ? place : null
}

/** One stable key per place, so the store finds the reading from the block's
    own words without a url in them. */
export function weatherSource(place) {
  const slug = String(place || '').toLowerCase().replace(/\s+/g, ' ').trim()
  return `https://open-meteo.com/?place=${encodeURIComponent(slug)}`
}

async function getJSON(url, fetchImpl) {
  let res
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (err) {
    throw new Error(`could not reach the forecast service: ${String(err?.message || err).slice(0, 100)}`)
  }
  if (!res.ok) throw new Error(`the forecast service answered ${res.status}`)
  return res.json()
}

/** Where a place is, by name. The service's first answer is the best one. */
export async function geocode(place, { fetchImpl = fetch } = {}) {
  const url = `${GEOCODE}?name=${encodeURIComponent(place)}&count=1&language=en&format=json`
  const body = await getJSON(url, fetchImpl)
  const hit = body?.results?.[0]
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') throw new Error(`no place called "${place}" on the map`)
  const region = hit.country_code === 'US' ? hit.admin1 : hit.country
  return {
    name: hit.name,
    label: region && region !== hit.name ? `${hit.name}, ${region}` : hit.name,
    latitude: hit.latitude,
    longitude: hit.longitude,
    unit: hit.country_code === 'US' ? 'F' : 'C',
  }
}

/** The reading now, shaped exactly as the weather card takes it. */
export async function fetchWeather(place, { fetchImpl = fetch, now = Date.now() } = {}) {
  const where = await geocode(place, { fetchImpl })
  const url = `${FORECAST}?latitude=${where.latitude}&longitude=${where.longitude}&current=temperature_2m,apparent_temperature,weather_code,is_day&timezone=auto`
  const body = await getJSON(url, fetchImpl)
  const cur = body?.current
  if (!cur || typeof cur.temperature_2m !== 'number') throw new Error(`no current reading for ${where.label}`)
  return {
    kind: 'weather',
    source: weatherSource(place),
    credit: 'Open-Meteo',
    location: where.label,
    code: Number.isInteger(cur.weather_code) ? cur.weather_code : null,
    isDay: cur.is_day === 1 ? true : cur.is_day === 0 ? false : null,
    celsius: cur.temperature_2m,
    feelsCelsius: typeof cur.apparent_temperature === 'number' ? cur.apparent_temperature : null,
    unit: where.unit,
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + WEATHER_TTL_MS).toISOString(),
    status: 'ready',
  }
}
