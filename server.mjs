#!/usr/bin/env node
// December web server — the one writer. Serves the page, the thin HTTP
// API, and the /api/tool seam every assistant reaches December through.
// Intelligence lives outside: the settle pass is a subscription-powered
// agent connected to the same tools your own Claude uses.

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname, normalize, basename } from 'node:path'
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync as fsExists } from 'node:fs'
import { ROOT, DATA_DIR, project, addCapture, addCaptureBatch, check, undo, undoManual, clearAsk, hasInbox, editText, retireSpace, restoreSpace, setPinned, setFinished, writeAbout, rolloverIfNeeded, watchForNewYear, applyCarryover, dismissCarryover, readYear, readMonth, listYears, observePersists, stateFingerprint, stateRevision, undoIsFresh, canUndoManual, createLatestWorkQueue } from './lib/core.mjs'
import { TOOLS, callTool } from './lib/tools.mjs'
import { manners } from './lib/manners.mjs'
import * as settle from './lib/settle.mjs'
import { startWatch } from './lib/watch.mjs'
import { ENGINES, getSettings, updateSettings, detectEngines } from './lib/settings.mjs'
import { docxText } from './lib/docx.mjs'
import { CLIENTS as CONNECT_CLIENTS, publishSkills, register as registerClient, statuses as connectionStatuses, verify as verifyClient } from './lib/connect.mjs'
import { createPocketSync } from './lib/pocket-sync.mjs'

const PUBLIC = join(ROOT, 'public')
const PORT = Number(process.env.PORT || 3008)
// The shipped version, from the package manifest beside this file.
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
})()
const UPLOADS = join(DATA_DIR, 'uploads')
// What the reading agent can genuinely open: documents, images, plain data.
const UPLOAD_TYPES = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.html', '.htm', '.ipynb',
  '.docx', '.xlsx', '.pptx',
])

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

await settle.writeMcpConfig()
await rolloverIfNeeded() // the turn of the year happens before anything else
const pocket = await createPocketSync({ dataDir: DATA_DIR })
const pocketUploads = createLatestWorkQueue(async (page) => {
  if (!pocket.status().paired) return
  await pocket.queuePage(page)
  const status = await pocket.flush()
  if (status.lastError) throw new Error(status.lastError)
}, {
  delayMs: 500,
  onError: (error) => console.log('Pocket page upload failed:', String(error?.message || error).slice(0, 200)),
})
observePersists(() => {
  const page = project(settleStatus())
  pocketUploads.schedule(page, page.revision)
})
const newYearTimer = watchForNewYear((y) => console.log(`the page turned: ${y} archived`))
let engineAvailability = await detectEngines()
let surfacingScheduled = false
const selectedEngineAvailable = () => !!engineAvailability[getSettings().engine]
const settleStatus = () => {
  const status = settle.status()
  if (selectedEngineAvailable()) return status
  return { ...status, running: false, pending: hasInbox(), lastError: null, captureOnly: true }
}
const scheduleSettle = (delay) => {
  if (selectedEngineAvailable()) settle.schedule(delay)
}
const scheduleSurfacing = () => {
  if (!surfacingScheduled && selectedEngineAvailable()) {
    surfacingScheduled = true
    settle.scheduleSurfacing()
  }
}
scheduleSurfacing()
// captures caught mid-restart must not strand: settle whatever waited
if (hasInbox()) scheduleSettle(5000)

// The watch pass wakes with the app and then keeps its own slow clock. It
// touches the network only for blocks a person tagged, and what it brings
// back arrives as an ordinary capture, so the settle pass files it the way
// it files everything else.
const stopWatch = startWatch({ onCaptured: () => scheduleSettle() })

async function pullPocketCaptures() {
  const result = await pocket.pullCaptures(({ id, text, at }) => addCapture(text, undefined, { id, at }))
  if (result.imported) scheduleSettle()
  return result
}

if (pocket.status().paired) {
  const page = project(settleStatus())
  pocketUploads.schedule(page, page.revision)
}
void pullPocketCaptures().catch((error) => console.log('Pocket capture pull failed:', String(error?.message || error).slice(0, 200)))
const pocketTimer = setInterval(() => {
  void pullPocketCaptures().catch((error) => console.log('Pocket capture pull failed:', String(error?.message || error).slice(0, 200)))
}, 10_000)

// the year is too precious for one copy: a dated snapshot every day, 30 kept
function backup() {
  try {
    const dir = join(DATA_DIR, 'backups')
    mkdirSync(dir, { recursive: true })
    const src = join(DATA_DIR, 'state.json')
    const dest = join(dir, `state-${new Date().toISOString().slice(0, 10)}.json`)
    if (fsExists(src) && !fsExists(dest)) copyFileSync(src, dest)
    const all = readdirSync(dir).filter((f) => f.startsWith('state-')).sort()
    while (all.length > 30) unlinkSync(join(dir, all.shift()))
  } catch {}
}
backup()
const backupTimer = setInterval(backup, 6 * 3600 * 1000)

/** The year as a document you keep. */
function exportMarkdown() {
  const p = project()
  const y = p.year.year
  const lines = [`# December ${y}`, '', `_Exported ${new Date().toISOString().slice(0, 10)}_`, '']
  if (p.about?.markdown) lines.push('## About Me', '', p.about.markdown, '')
  for (const s of p.spaces) {
    lines.push(`## ${s.name}`, '')
    for (const b of s.blocks) {
      if (b.type === 'tracker') lines.push(`**${b.title || 'Progress'}**: ${b.current} of ${b.target}${b.unit ? ` ${b.unit}` : ''}`, '')
      if (b.type === 'ledger') {
        lines.push(`**${b.title || 'Ledger'}**: total ${b.unit === '$' ? '$' : ''}${b.total}${b.unit && b.unit !== '$' ? ` ${b.unit}` : ''}`, '')
        for (const e of b.entries) lines.push(`- ${e.at?.slice(0, 10) || ''} ${e.label}: ${b.unit === '$' ? '$' : ''}${e.amount}`)
        lines.push('')
      }
      if (b.type === 'list') {
        if (b.title) lines.push(`**${b.title}**`, '')
        for (const i of b.items) lines.push(`- [${i.done ? 'x' : ' '}] ${i.text}${i.doneAt ? ` _(${i.doneAt.slice(0, 10)})_` : ''}`)
        lines.push('')
      }
      if (b.type === 'streak') lines.push(`**${b.title}**: ${b.dates.length} days`, '')
      if (b.type === 'note') lines.push(...(b.title ? [`**${b.title}**`, ''] : []), b.text, '')
      if (b.type === 'reminder') lines.push(`- [${b.done ? 'x' : ' '}] ${b.text}${b.when ? ` _(${b.when}${b.repeat ? `, ${b.repeat}` : ''})_` : ''}`, '')
    }
  }
  const names = ['January','February','March','April','May','June','July','August','September','October','November','December']
  lines.push('## The year, month by month', '')
  p.year.months.forEach((m, i) => {
    if (m.events || m.highlights.length) lines.push(`- **${names[i]}**: ${m.events} moments${m.highlights.length ? ` — ${m.highlights.join('; ')}` : ''}`)
  })
  return lines.join('\n')
}

// Every answer carries the same small set of refusals: don't guess the type,
// don't leak the address, don't let another document frame or open into this
// one. The page itself gets a policy computed from what it actually contains.
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'x-frame-options': 'DENY',
}

const policyCache = new Map()

// The one inline script December ships is the theme flash-guard. Rather than
// opening script-src to every inline script, hash the ones the file really
// has, so an injected one is refused by the browser.
export function contentSecurityPolicy(html) {
  if (policyCache.has(html)) return policyCache.get(html)
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => `'sha256-${createHash('sha256').update(match[1], 'utf8').digest('base64')}'`)
  const policy = [
    "default-src 'none'",
    ["script-src 'self'", ...hashes].join(' '),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ')
  policyCache.set(html, policy)
  return policy
}

const json = (res, code, body) => {
  const headers = { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' }
  if (code === 413) headers.connection = 'close'
  res.writeHead(code, headers)
  res.end(JSON.stringify(body))
}

// A capability the Pocket routes require. Any page can post to a loopback
// server, but only a page December itself served can read a reply, so a
// value handed out over a same-origin read is a value a hostile tab cannot
// hold. It is minted per run and never touches disk.
const POCKET_CAPABILITY = randomBytes(32).toString('base64url')
export function capabilityMatches(offered) {
  if (typeof offered !== 'string') return false
  const a = Buffer.from(offered)
  const b = Buffer.from(POCKET_CAPABILITY)
  return a.length === b.length && timingSafeEqual(a, b)
}

const JSON_BODY_LIMIT = 1_000_000

function limitedBody(req, cap, message) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let refused = false
    req.on('data', (chunk) => {
      if (refused) return
      size += chunk.length
      if (size > cap) {
        refused = true
        chunks.length = 0
        const error = new Error(message)
        error.statusCode = 413
        reject(error)
      } else {
        chunks.push(chunk)
      }
    })
    req.on('end', () => {
      if (!refused) resolve(Buffer.concat(chunks, size))
    })
    req.on('error', (error) => {
      if (!refused) reject(error)
    })
  })
}

async function readBody(req) {
  const raw = await limitedBody(req, JSON_BODY_LIMIT, 'body too large (1 MB cap)')
  return raw.length ? JSON.parse(raw.toString('utf8')) : {}
}

function readRaw(req, cap) {
  return limitedBody(req, cap, 'file too large (15 MB cap)')
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const file = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain' })
    return res.end('not found')
  }
  const type = MIME[extname(file)] || 'application/octet-stream'
  const body = await readFile(file)
  const headers = { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-store' }
  if (extname(file) === '.html') headers['content-security-policy'] = contentSecurityPolicy(body.toString('utf8'))
  res.writeHead(200, headers)
  res.end(body)
}

// Any page open in another tab can POST to a loopback server without a
// preflight, and every route here writes. A browser always stamps Origin on
// a cross-site request, so refusing the ones that are not local is enough
// to keep a hostile page from rewriting or wiping your year. Requests with
// no Origin at all — the MCP adapter, the desktop shell, curl — are yours.
function foreignOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  try {
    return !LOCAL_HOSTS.has(new URL(origin).hostname)
  } catch {
    return true
  }
}

// Host is checked before every route, including reads and Pocket operations.
// This closes DNS rebinding: the server listens on loopback, while the Host
// header still identifies the name a browser used to reach it. Missing Host
// is refused because there is no name to validate; supported clients send it.
// The port has to be ours too — a name that resolves to loopback on some
// other port is somebody else's server borrowing our answers.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export function foreignHost(host, port = PORT) {
  if (!host) return true
  try {
    const parsed = new URL(`http://${host}`)
    if (!LOCAL_HOSTS.has(parsed.hostname)) return true
    return parsed.port !== '' && parsed.port !== String(port)
  } catch {
    return true
  }
}

// Browsers stamp Sec-Fetch-Site on every request they make. same-origin is
// December's own page, none is a person typing the address; anything else is
// another site reaching in and is refused whether or not it sends an Origin.
// Clients that are not browsers — the MCP adapter, the desktop shell, curl —
// send no such header and are yours.
const OWN_FETCH_SITES = new Set(['same-origin', 'none'])
export function foreignFetchSite(headers) {
  const site = headers['sec-fetch-site']
  if (!site) return false
  return !OWN_FETCH_SITES.has(String(site))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  if (req.method === 'POST') console.log(new Date().toISOString(), req.method, path)
  if (foreignHost(req.headers.host)) {
    return json(res, 403, { error: 'refused: December only answers to localhost' })
  }
  if (foreignFetchSite(req.headers)) {
    return json(res, 403, { error: 'refused: this request came from another site' })
  }
  if (req.method === 'POST' && foreignOrigin(req)) {
    return json(res, 403, { error: 'refused: this page did not come from December' })
  }
  // Pocket hands out the pairing secret and can revoke a phone, so the
  // routes that act want more than being local: they want the capability
  // only a page December itself served is able to read. Plain status stays
  // open — it holds nothing worth stealing.
  if (path.startsWith('/api/pocket/') && req.method === 'POST' && !capabilityMatches(req.headers['x-december-capability'])) {
    return json(res, 403, { error: 'refused: Pocket needs December\'s own page' })
  }
  try {
    if (path === '/api/state' && req.method === 'GET') {
      const fingerprint = stateFingerprint()
      if (url.searchParams.get('since') === fingerprint) {
        return json(res, 200, {
          unchanged: true,
          fingerprint,
          revision: stateRevision(),
          settle: settleStatus(),
          canUndo: undoIsFresh(),
          canUndoManual: canUndoManual(),
        })
      }
      return json(res, 200, { ...project(settleStatus()), fingerprint })
    }

    // Handed to December's own page and to nothing else. A cross-site page
    // may reach this route but cannot read what it says.
    if (path === '/api/pocket/capability' && req.method === 'GET') {
      return json(res, 200, { capability: POCKET_CAPABILITY })
    }
    if (path === '/api/pocket' && req.method === 'GET') {
      return json(res, 200, pocket.status())
    }
    if (path === '/api/pocket/pair' && req.method === 'POST') {
      try {
        const paired = await pocket.pair()
        const page = project(settleStatus())
        pocketUploads.schedule(page, page.revision)
        await pocketUploads.drain()
        return json(res, 201, { ...pocket.status(), pairingUrl: paired.pairingUrl })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }
    // The lost-phone door. A new key epoch opens, the relay drops what it
    // held, and the phone that walked away can read nothing more.
    if (path === '/api/pocket/rotate' && req.method === 'POST') {
      try {
        const rotated = await pocket.rotate({ reason: (await readBody(req)).reason || 'replace-device' })
        const page = project(settleStatus())
        pocketUploads.schedule(page, page.revision)
        await pocketUploads.drain()
        return json(res, 201, { ...pocket.status(), pairingUrl: rotated.pairingUrl })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }
    if (path === '/api/pocket/sync' && req.method === 'POST') {
      const page = project(settleStatus())
      pocketUploads.schedule(page, page.revision)
      const [, captures] = await Promise.all([pocketUploads.drain(), pullPocketCaptures()])
      const status = pocket.status()
      return json(res, 200, { ...status, imported: captures?.imported || 0 })
    }
    // Disconnect asks the relay to delete the space before this computer
    // forgets it. If the relay cannot be reached the request is kept and
    // retried; the pairing is already gone from here either way.
    if (path === '/api/pocket/disconnect' && req.method === 'POST') {
      return json(res, 200, await pocket.revoke())
    }
    if (path === '/api/pocket/revoke' && req.method === 'POST') {
      return json(res, 200, await pocket.revoke())
    }

    // Capture lands instantly; the settle pass runs behind you.
    // A brain dump — many lines pasted at once — splits into one capture
    // per line, so each thought settles and travels on its own.
    if (path === '/api/capture' && req.method === 'POST') {
      const body = await readBody(req)
      const text = String(body.text || '').trim()
      if (!text) return json(res, 400, { error: 'empty' })
      // every line a person actually wrote is kept: the old floor of three
      // characters silently swallowed "AC", "Rx", "gym" out of a dump
      const lines = text.includes('\n')
        ? text.split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter(Boolean).slice(0, 25)
        : [text]
      if (lines.length === 1) await addCapture(lines[0], body.hint)
      else await addCaptureBatch(lines, body.hint)
      scheduleSettle()
      return json(res, 200, project(settleStatus()))
    }

    // Manual, instant check from the page — no model involved.
    if (path === '/api/check' && req.method === 'POST') {
      const { blockId, itemId, done } = await readBody(req)
      try {
        await check(blockId, itemId, done)
        return json(res, 200, project(settleStatus()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    if (path === '/api/undo' && req.method === 'POST') {
      try {
        await undo()
        return json(res, 200, project(settleStatus()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // Answer (or dismiss) the ask. A chosen option files as if typed.
    if (path === '/api/answer' && req.method === 'POST') {
      const body = await readBody(req)
      const asked = project().ask?.question || ''
      await clearAsk()
      if (body.choice) {
        // a tapped option is a whole sentence already; a typed one is a
        // fragment, so it files with the question that gives it meaning
        const text = body.typed && asked ? `${asked} ${body.choice}` : String(body.choice)
        await addCapture(text)
        scheduleSettle()
      }
      return json(res, 200, project(settleStatus()))
    }

    // Retry a failed settle by hand.
    if (path === '/api/settle' && req.method === 'POST') {
      scheduleSettle(0)
      return json(res, 202, { scheduled: selectedEngineAvailable(), captureOnly: !selectedEngineAvailable() })
    }

    // Ask the page a question and get an answer, not a filed note.
    if (path === '/api/query' && req.method === 'POST') {
      const { question } = await readBody(req)
      if (!selectedEngineAvailable()) {
        return json(res, 503, { error: 'no engine connected, so nothing can read the page back to you' })
      }
      try {
        const answer = await settle.answerQuestion(String(question || ''))
        return json(res, 200, { answer })
      } catch (e) {
        return json(res, 502, { error: e.message })
      }
    }

    // What matters this year, and what is finished.
    if (path === '/api/pin' && req.method === 'POST') {
      const { spaceId, pinned } = await readBody(req)
      try {
        const out = await setPinned(spaceId, pinned)
        return json(res, 200, { ...out, state: project(settleStatus()) })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }
    if (path === '/api/finish' && req.method === 'POST') {
      const { spaceId, finished } = await readBody(req)
      try {
        const out = await setFinished(spaceId, finished)
        return json(res, 200, { ...out, state: project(settleStatus()) })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // Undo your own last action (agent batches use /api/undo).
    if (path === '/api/undo-mine' && req.method === 'POST') {
      try {
        const out = await undoManual()
        return json(res, 200, { ...out, state: project(settleStatus()) })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // Small fixes by hand: rename, reword, retire, restore.
    if (path === '/api/edit' && req.method === 'POST') {
      try {
        await editText(await readBody(req))
        return json(res, 200, project(settleStatus()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }
    if (path === '/api/retire' && req.method === 'POST') {
      try {
        const out = await retireSpace((await readBody(req)).spaceId)
        return json(res, 200, { ...out, state: project(settleStatus()) })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }
    if (path === '/api/restore' && req.method === 'POST') {
      try {
        const out = await restoreSpace((await readBody(req)).spaceId)
        return json(res, 200, { ...out, state: project(settleStatus()) })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // The January moment: bring chosen threads in, or let the year rest.
    if (path === '/api/carryover' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        if (body.dismiss) await dismissCarryover()
        else await applyCarryover(body.ids || [])
        return json(res, 200, project(settleStatus()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // One month, in full: what happened, grouped by the space it happened
    // in. Kept off /api/state on purpose — that payload is fetched every
    // ten seconds and this is only wanted when a month is opened.
    if (path.startsWith('/api/month/') && req.method === 'GET') {
      try {
        return json(res, 200, readMonth(path.slice('/api/month/'.length)))
      } catch (e) {
        return json(res, 404, { error: e.message })
      }
    }

    // Past years, read-only.
    if (path === '/api/years' && req.method === 'GET') {
      return json(res, 200, { years: listYears() })
    }
    if (path.startsWith('/api/year/') && req.method === 'GET') {
      try {
        return json(res, 200, readYear(path.slice('/api/year/'.length)))
      } catch (e) {
        return json(res, 404, { error: e.message })
      }
    }

    // The year as a markdown document.
    if (path === '/api/export.md' && req.method === 'GET') {
      const md = exportMarkdown()
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="december-${new Date().getFullYear()}.md"`,
      })
      return res.end(md)
    }

    // Run the surfacing sense on demand.
    if (path === '/api/surface' && req.method === 'POST') {
      if (selectedEngineAvailable()) settle.runSurface()
      return json(res, 202, { scheduled: selectedEngineAvailable() })
    }

    if (path === '/api/about' && req.method === 'GET') {
      return json(res, 200, project().about)
    }
    if (path === '/api/about' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        await writeAbout(body.markdown ?? body.text, body.mode || 'set', { manual: true })
        return json(res, 200, project(settleStatus()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // Engine and model for the organizing pass.
    if (path === '/api/settings' && req.method === 'GET') {
      return json(res, 200, {
        ...getSettings(),
        engines: engineAvailability,
        resolvedEngines: Object.fromEntries(Object.entries(ENGINES).map(([key, value]) => [key, value.bin])),
        version: APP_VERSION,
      })
    }
    if (path === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const saved = await updateSettings(body)
        engineAvailability = await detectEngines({ refresh: true })
        scheduleSurfacing()
        if (hasInbox()) scheduleSettle(0)
        return json(res, 200, {
          ...saved,
          engines: engineAvailability,
          resolvedEngines: Object.fromEntries(Object.entries(ENGINES).map(([key, value]) => [key, value.bin])),
        })
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // Connections are inspected without side effects. A write happens only
    // after a person chooses a client in onboarding, settings, or the CLI.
    if (path === '/api/connect' && req.method === 'GET') {
      return json(res, 200, { clients: await connectionStatuses() })
    }
    if (path === '/api/connect' && req.method === 'POST') {
      const { client } = await readBody(req)
      if (!CONNECT_CLIENTS.includes(client)) return json(res, 400, { error: `unknown client: ${client}` })
      try {
        const registration = await registerClient(client)
        const skills = await publishSkills()
        const status = await verifyClient(client)
        return json(res, 200, { client, status, registration, skills })
      } catch (e) {
        return json(res, 502, { error: e.message, client })
      }
    }

    // Dropped documents land as files; the capture carries the path and
    // the settle agent reads it like any other words the person wrote.
    if (path === '/api/upload' && req.method === 'POST') {
      const rawName = basename(String(url.searchParams.get('name') || 'file')).replace(/[^\w.\- ]/g, '_').slice(0, 120)
      const ext = extname(rawName).toLowerCase()
      if (!UPLOAD_TYPES.has(ext)) return json(res, 400, { error: `can't read ${ext || 'that'} files yet` })
      const buf = await readRaw(req, 15e6)
      if (!buf.length) return json(res, 400, { error: 'empty file' })
      mkdirSync(UPLOADS, { recursive: true })
      const file = join(UPLOADS, `${Date.now()}-${rawName}`)
      await writeFile(file, buf)
      // Word docs aren't natively readable by the settle agent; extract the
      // text into a sidecar the capture points at instead. The original stays.
      let readable = file
      if (ext === '.docx') {
        try {
          readable = `${file}.txt`
          await writeFile(readable, docxText(buf))
        } catch {
          readable = file
        }
      }
      await addCapture(`[attached file: ${readable}] ${rawName}`)
      scheduleSettle()
      return json(res, 200, project(settleStatus()))
    }

    // The assistant seam: MCP adapters (and anything else) call tools here.
    if (path === '/api/tools' && req.method === 'GET') {
      return json(res, 200, { tools: TOOLS })
    }
    // The manners that govern those tools, read live so a connected assistant
    // is never held to a copy older than the server it is writing to.
    if (path === '/api/manners' && req.method === 'GET') {
      return json(res, 200, await manners())
    }
    if (path === '/api/tool' && req.method === 'POST') {
      const { name, arguments: args } = await readBody(req)
      try {
        const result = await callTool(name, args || {}, settleStatus())
        if (process.env.DECEMBER_DEBUG) console.log('  tool', name)
        return json(res, 200, { result })
      } catch (e) {
        if (process.env.DECEMBER_DEBUG) console.log('  tool', name, 'FAILED:', e.message)
        return json(res, 400, { error: e.message })
      }
    }

    if (path === '/api/health') return json(res, 200, { ok: true, port: PORT })

    return serveStatic(res, path)
  } catch (err) {
    return json(res, err.statusCode || 500, { error: String(err.message || err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`december listening on http://localhost:${PORT}`)
  console.log(`assistant tool surface: connect Claude with  claude mcp add december -- node ${join(ROOT, 'mcp-server.mjs')}`)
})

let shuttingDown = false
export async function shutdown({ exit = true } = {}) {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(backupTimer)
  clearInterval(pocketTimer)
  clearInterval(newYearTimer)
  stopWatch()
  const closed = new Promise((resolveClose) => server.close(resolveClose))
  let timeoutId
  const timeout = new Promise((resolveTimeout) => { timeoutId = setTimeout(resolveTimeout, 3000) })
  await Promise.race([Promise.allSettled([closed, pocketUploads.drain()]), timeout])
  clearTimeout(timeoutId)
  if (exit) process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
