// Explicit lookup — December's own two web tools.
//
// The page never browses on its own. When a person writes "look up the UF
// home schedule", the organizing pass needs one honest way to go read the
// real thing; every other capture stays exactly what it was. Milk stays milk.
//
// These live in the MCP adapter process, not in the engine, so both settle
// engines get the same surface: Claude sees them as december_* MCP tools,
// Codex sees them over the same stdio server it already runs with
// sandbox_mode="read-only". No engine builtin, no per-harness special case.
//
// The module holds no state and writes no files. It searches, it reads one
// page, and it hands back text. Filing is the pass's job, with the six
// primitives it already has.

import { lookup as dnsLookup } from 'node:dns/promises'

const USER_AGENT = 'December/0.1 (personal page; explicit user lookup only)'
// Overridable so a person can point December at their own search endpoint
// (a self-hosted SearXNG, say). {query} is the URL-encoded query.
const searchTemplate = () => process.env.DECEMBER_SEARCH_URL || 'https://html.duckduckgo.com/html/?q={query}'
const MAX_BYTES = 400_000 // a page this big has already said what it had to
const MAX_TEXT = 8_000
const MAX_REDIRECTS = 3
const TIMEOUT_MS = 15_000
const READABLE = /^(?:text\/html|text\/plain|application\/xhtml\+xml|application\/json|text\/xml|application\/xml)\b/i

/** The one line every failure ends with: a gap is a task, never a guess. */
export const FALLBACK = 'file a look-up task naming what to check and where; never answer from memory'

// ------------------------------------------------------------ tool surface

export const WEB_TOOLS = [
  {
    name: 'december_web_search',
    description:
      'Search the open web, ONLY when a capture explicitly asks you to look something up ("look up", "pull", "get the latest", "find out when", "track" a public fact). An ordinary capture is never looked up: "milk" stays milk. Returns titles, urls, and snippets. A snippet is NOT a fact: pick the most official source (the organization\'s own site over an aggregator) and read it with december_web_fetch before you file anything.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in plain words.' },
        limit: { type: 'number', description: 'How many results to return, 1 to 8. Default 5.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'december_web_fetch',
    description:
      'Read one public web page and get its text back. Use it after december_web_search, on the most official source you found. Everything you file must come from this text, in the person\'s own plain words, with the source named in the block or the filing summary. Never invent a date, a time, a number, or a name the page does not state. If the fetch fails or the page does not say, ' + FALLBACK + '.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The http(s) url to read.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
]

const WEB_TOOL_NAMES = new Set(WEB_TOOLS.map((t) => t.name))

/** True for the tools this module answers itself instead of forwarding. */
export const isWebTool = (name) => WEB_TOOL_NAMES.has(name)

// ------------------------------------------------------------- the guards
// Search results are attacker-controlled text: whatever the open web put on
// a results page. December's own server sits on loopback and answers tool
// calls, so a fetch tool that will follow any url is a way back into it.
// Everything that came from the web is checked here, before a socket opens.

const v4 = (host) => {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1))
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null
}

/** Loopback, private, link-local, CGNAT, multicast — anything not the open web. */
export function privateAddress(host) {
  let h = String(host || '').trim().toLowerCase()
  if (!h) return true
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const quad = v4(h)
  if (quad) {
    const [a, b] = quad
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local, and the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // multicast and reserved
    return false
  }
  if (h.includes(':')) {
    if (h === '::' || h === '::1') return true
    const mapped = /^::ffff:(.+)$/.exec(h)
    if (mapped) return privateAddress(mapped[1])
    if (/^f[cd]/.test(h)) return true // unique local
    if (/^fe[89ab]/.test(h)) return true // link-local
    return false
  }
  return false
}

const LOCAL_SUFFIX = /(?:\.localhost|\.local|\.internal|\.intranet|\.home\.arpa)$/

/** Parse and vet a url that came from the web. Throws with the fallback line. */
export function guardUrl(raw) {
  let url
  try {
    url = new URL(String(raw || '').trim())
  } catch {
    throw new Error(`not a url: ${String(raw || '').slice(0, 120)} — ${FALLBACK}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`only http and https can be read, not ${url.protocol} — ${FALLBACK}`)
  }
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || LOCAL_SUFFIX.test(host) || !host.includes('.') || privateAddress(host)) {
    throw new Error(`${url.hostname} is not on the open web — ${FALLBACK}`)
  }
  return url
}

/** The name may still point home. Resolve it and check every address. */
async function assertPublicHost(url, lookup) {
  if (v4(url.hostname) || url.hostname.includes(':')) return // literal, already checked
  let addresses
  try {
    addresses = await lookup(url.hostname, { all: true })
  } catch {
    throw new Error(`could not resolve ${url.hostname} — ${FALLBACK}`)
  }
  // Best effort: fetch resolves the name again on its own, so a name that
  // flips between answers can still slip past. It closes the ordinary case.
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) {
    throw new Error(`${url.hostname} resolves off the open web — ${FALLBACK}`)
  }
}

// ------------------------------------------------------------ reading html

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', middot: '·', bull: '·',
}

/** Decode the entities a page actually uses; leave anything unknown alone. */
export function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => safeChar(parseInt(hex, 16), m))
    .replace(/&#(\d+);/g, (m, dec) => safeChar(Number(dec), m))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
}

const safeChar = (code, fallback) => {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return fallback
  try {
    return String.fromCodePoint(code)
  } catch {
    return fallback
  }
}

const collapse = (text) => decodeEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()

const BLOCKISH = /<\/?(?:p|div|br|li|tr|td|h[1-6]|section|article|header|footer|nav|table|ul|ol|dl|dt|dd|blockquote)\b[^>]*>/gi

/** Turn a page into the text a person would read off it. Nothing clever. */
export function extractText(html) {
  let body = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
  const title = collapse(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] || '')
  body = body.replace(BLOCKISH, '\n').replace(/<[^>]*>/g, ' ')
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line, i, lines) => line || (i > 0 && lines[i - 1]))
    .join('\n')
    .trim()
  return { title, text }
}

// --------------------------------------------------------------- searching

/** A results page hides its links behind a redirector; take the real one. */
export function normalizeResultUrl(href) {
  let raw = decodeEntities(String(href || '').trim())
  if (!raw) return null
  if (raw.startsWith('//')) raw = `https:${raw}`
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const wrapped = url.searchParams.get('uddg') || url.searchParams.get('url') || url.searchParams.get('u')
  if (wrapped && /^https?:\/\//i.test(wrapped)) {
    try {
      url = new URL(wrapped)
    } catch {
      return null
    }
  }
  url.hash = ''
  return url.toString()
}

const RESULT_LINK = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
const RESULT_LINK_ALT = /<a\b[^>]*href="([^"]*)"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi
const RESULT_SNIPPET = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/gi

/** Pull {title, url, snippet} out of a results page, dropping anything that
    is not a public http(s) link. Wrong-shaped html yields nothing, never junk. */
export function parseSearchResults(html, limit = 5) {
  const page = String(html || '')
  const snippets = [...page.matchAll(RESULT_SNIPPET)].map((m) => collapse(m[1]))
  const links = [...page.matchAll(RESULT_LINK), ...page.matchAll(RESULT_LINK_ALT)]
  const out = []
  const seen = new Set()
  for (const [i, match] of links.entries()) {
    const url = normalizeResultUrl(match[1])
    if (!url || seen.has(url)) continue
    try {
      guardUrl(url)
    } catch {
      continue // a results page pointing at loopback is not a result
    }
    seen.add(url)
    out.push({ title: collapse(match[2]), url, snippet: snippets[i] || '' })
    if (out.length >= limit) break
  }
  return out
}

// ----------------------------------------------------------- the two calls

const clampLimit = (n) => Math.min(8, Math.max(1, Math.round(Number(n) || 5)))

async function readCapped(res) {
  const reader = res.body?.getReader?.()
  if (!reader) return String(await res.text()).slice(0, MAX_BYTES)
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  return Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES)
}

async function get(url, { fetchImpl, lookup, guard = true }) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (guard) await assertPublicHost(current, lookup)
    let res
    try {
      res = await fetchImpl(current.toString(), {
        redirect: 'manual',
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(`could not reach ${current.hostname}: ${String(err.message || err).slice(0, 120)} — ${FALLBACK}`)
    }
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (location) {
      // Every hop is re-checked: a public url that redirects to loopback is
      // exactly the trick the guard exists for.
      const next = new URL(location, current)
      current = guard ? guardUrl(next.toString()) : next
      continue
    }
    if (!res.ok) throw new Error(`${current.hostname} answered ${res.status} — ${FALLBACK}`)
    return { res, url: current }
  }
  throw new Error(`${url.hostname} kept redirecting — ${FALLBACK}`)
}

/** Search the web for an explicitly requested lookup. Snippets, not facts. */
export async function searchWeb({ query, limit } = {}, { fetchImpl = fetch, lookup = dnsLookup } = {}) {
  const q = String(query || '').trim().slice(0, 200)
  if (!q) throw new Error('say what to look up')
  // The endpoint is the person's own configuration, not a web link, so it is
  // not held to the open-web guard; every result it returns still is.
  const endpoint = new URL(searchTemplate().replace('{query}', encodeURIComponent(q)))
  const { res } = await get(endpoint, { fetchImpl, lookup, guard: false })
  const results = parseSearchResults(await readCapped(res), clampLimit(limit))
  return {
    query: q,
    results,
    note: results.length
      ? 'snippets are not facts: december_web_fetch the most official source before filing anything'
      : `nothing came back — ${FALLBACK}`,
  }
}

/** Read one public page. Everything filed after this must come from `text`. */
export async function fetchPage({ url } = {}, { fetchImpl = fetch, lookup = dnsLookup } = {}) {
  const target = guardUrl(url)
  const { res, url: final } = await get(target, { fetchImpl, lookup })
  const type = res.headers.get('content-type') || ''
  if (type && !READABLE.test(type)) {
    throw new Error(`${final.hostname} returned ${type.split(';')[0]}, which is not readable text — ${FALLBACK}`)
  }
  const raw = await readCapped(res)
  const { title, text } = extractText(raw)
  if (!text) throw new Error(`${final.hostname} had no readable text — ${FALLBACK}`)
  return {
    url: final.toString(),
    title,
    text: text.slice(0, MAX_TEXT),
    truncated: text.length > MAX_TEXT,
    fetchedAt: new Date().toISOString(),
    note: `file only what this text states, name the source, and never fill a gap from memory — when it does not say, ${FALLBACK}`,
  }
}

/** Dispatch, mirroring lib/tools.mjs so the adapter stays one switch thick. */
export async function callWebTool(name, args = {}, deps = {}) {
  switch (name) {
    case 'december_web_search':
      return searchWeb(args, deps)
    case 'december_web_fetch':
      return fetchPage(args, deps)
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}
