#!/usr/bin/env node
// December web server — the one writer. Serves the page, the thin HTTP
// API, and the /api/tool seam every assistant reaches December through.
// Intelligence lives outside: the settle pass is a subscription-powered
// agent connected to the same tools your own Claude uses.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { ROOT, project, addCapture, check, undo, clearAsk, hasInbox } from './lib/core.mjs'
import { TOOLS, callTool } from './lib/tools.mjs'
import * as settle from './lib/settle.mjs'

const PUBLIC = join(ROOT, 'public')
const PORT = Number(process.env.PORT || 3008)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

await settle.writeMcpConfig()
settle.scheduleSurfacing()
// captures caught mid-restart must not strand: settle whatever waited
if (hasInbox()) settle.schedule(5000)

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname
  if (req.method === 'POST') console.log(new Date().toISOString(), req.method, path)
  try {
    if (path === '/api/state' && req.method === 'GET') {
      return json(res, 200, project(settle.status()))
    }

    // Capture lands instantly; the settle pass runs behind you.
    // A brain dump — many lines pasted at once — splits into one capture
    // per line, so each thought settles and travels on its own.
    if (path === '/api/capture' && req.method === 'POST') {
      const body = await readBody(req)
      const text = String(body.text || '').trim()
      if (!text) return json(res, 400, { error: 'empty' })
      const lines = text.includes('\n')
        ? text.split('\n').map((l) => l.replace(/^[-*•]\s*/, '').trim()).filter((l) => l.length > 2).slice(0, 25)
        : [text]
      for (const line of lines) await addCapture(line, body.hint)
      settle.schedule()
      return json(res, 200, project(settle.status()))
    }

    // Manual, instant check from the page — no model involved.
    if (path === '/api/check' && req.method === 'POST') {
      const { blockId, itemId, done } = await readBody(req)
      try {
        await check(blockId, itemId, done)
        return json(res, 200, project(settle.status()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    if (path === '/api/undo' && req.method === 'POST') {
      try {
        await undo()
        return json(res, 200, project(settle.status()))
      } catch (e) {
        return json(res, 400, { error: e.message })
      }
    }

    // Answer (or dismiss) the ask. A chosen option files as if typed.
    if (path === '/api/answer' && req.method === 'POST') {
      const body = await readBody(req)
      await clearAsk()
      if (body.choice) {
        await addCapture(String(body.choice))
        settle.schedule()
      }
      return json(res, 200, project(settle.status()))
    }

    // Retry a failed settle by hand.
    if (path === '/api/settle' && req.method === 'POST') {
      settle.schedule(0)
      return json(res, 202, { scheduled: true })
    }

    // Run the surfacing sense on demand.
    if (path === '/api/surface' && req.method === 'POST') {
      settle.runSurface()
      return json(res, 202, { scheduled: true })
    }

    // The assistant seam: MCP adapters (and anything else) call tools here.
    if (path === '/api/tools' && req.method === 'GET') {
      return json(res, 200, { tools: TOOLS })
    }
    if (path === '/api/tool' && req.method === 'POST') {
      const { name, arguments: args } = await readBody(req)
      try {
        const result = await callTool(name, args || {}, settle.status())
        return json(res, 200, { result })
      } catch (e) {
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
