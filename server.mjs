#!/usr/bin/env node
// December web server — the one writer. Serves the page, the thin HTTP
// API, and the /api/tool seam every assistant reaches December through.
// Intelligence lives outside: the settle pass is a subscription-powered
// agent connected to the same tools your own Claude uses.

import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, extname, normalize, basename } from 'node:path'
import { copyFileSync, mkdirSync, readdirSync, unlinkSync, existsSync as fsExists } from 'node:fs'
import { ROOT, DATA_DIR, project, addCapture, addCaptureBatch, check, undo, undoManual, clearAsk, hasInbox, editText, retireSpace, restoreSpace, setPinned, setFinished, writeAbout, rolloverIfNeeded, watchForNewYear, applyCarryover, dismissCarryover, readYear, readMonth, listYears, observePersists, stateFingerprint, undoIsFresh, canUndoManual } from './lib/core.mjs'
import { TOOLS, callTool } from './lib/tools.mjs'
import { manners } from './lib/manners.mjs'
import * as settle from './lib/settle.mjs'
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
// Each queuePage projects and encrypts the WHOLE page, and a settle batch
// persists a dozen times in a few seconds. Only the last state of a burst
// ever reaches the phone anyway, so the observer coalesces: one encryption,
// half a second after the writes go quiet.
let pocketQueueTimer = null
observePersists(() => {
  clearTimeout(pocketQueueTimer)
  pocketQueueTimer = setTimeout(() => void pocket.queuePage(project()), 500)
})
watchForNewYear((y) => console.log(`the page turned: ${y} archived`))
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

async function pullPocketCaptures() {
  const result = await pocket.pullCaptures(({ id, text, at }) => addCapture(text, undefined, { id, at }))
  if (result.imported) scheduleSettle()
  return result
}

if (pocket.status().paired) void pocket.queuePage(project())
void pullPocketCaptures()
const pocketTimer = setInterval(() => void pullPocketCaptures(), 10_000)

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

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function readRaw(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > cap) reject(new Error('file too large (15 MB cap)'))
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const file = join(PUBLIC, normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC) || !existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    return res.end('not found')
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(await readFile(file))
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
    const host = new URL(origin).hostname
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]'
  } catch {
    return true
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  if (req.method === 'POST') console.log(new Date().toISOString(), req.method, path)
  if (req.method === 'POST' && foreignOrigin(req)) {
    return json(res, 403, { error: 'refused: this page did not come from December' })
  }
  try {
    if (path === '/api/state' && req.method === 'GET') {
      // the poll echoes the fingerprint it last saw; a match means nothing
      // the page draws has moved, so the whole year is not serialized again
      const fingerprint = stateFingerprint()
      if (url.searchParams.get('since') === fingerprint) {
        return json(res, 200, {
          unchanged: true,
          fingerprint,
          settle: settleStatus(),
          canUndo: undoIsFresh(),
          canUndoManual: canUndoManual(),
        })
      }
      return json(res, 200, { ...project(settleStatus()), fingerprint })
    }

    if (path === '/api/pocket' && req.method === 'GET') {
      return json(res, 200, pocket.status())
    }
    if (path === '/api/pocket/pair' && req.method === 'POST') {
      const paired = await pocket.pair()
      await pocket.queuePage(project(settleStatus()))
      await pocket.flush()
      return json(res, 201, { ...paired, ...pocket.status() })
    }
    if (path === '/api/pocket/sync' && req.method === 'POST') {
      await pocket.queuePage(project(settleStatus()))
      const [status, captures] = await Promise.all([pocket.flush(), pullPocketCaptures()])
      return json(res, 200, { ...status, imported: captures?.imported || 0 })
    }
    if (path === '/api/pocket/disconnect' && req.method === 'POST') {
      return json(res, 200, await pocket.disconnect())
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
      else await addCaptureBatch(lines, body.hint) // one write for the whole dump
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
    return json(res, 500, { error: String(err.message || err) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`december listening on http://localhost:${PORT}`)
  console.log(`assistant tool surface: connect Claude with  claude mcp add december -- node ${join(ROOT, 'mcp-server.mjs')}`)
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(backupTimer)
  clearInterval(pocketTimer)
  clearTimeout(pocketQueueTimer)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
