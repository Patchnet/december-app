#!/usr/bin/env node
// December MCP adapter — stdio, zero dependencies, and deliberately thin.
// It holds NO page state: every page tool call forwards over loopback HTTP
// to the running December server, the one writer. Inside a git repo it first
// starts (or finds) that repo's board server; see lib/board-host.mjs. The adapter
// contributes only the page's organization tools; retrieval belongs to the
// connected agent's native capabilities and configured permissions.
//
// Connect from Claude Code:    claude mcp add december -- node <this file>
// Connect from Claude Desktop: add the same command under mcpServers.

import { createInterface } from 'node:readline'
import { detectMode } from './lib/board-mode.mjs'
import { ensureBoard } from './lib/board-host.mjs'

// Started inside a git repo, the connection gets that repo's own board
// instead (see lib/board-mode.mjs), and BASE moves to the board's server.
let BASE = process.env.DECEMBER_URL || 'http://localhost:3008'
let boardError = null
let connected = null
const access=process.env.DECEMBER_ACCESS || 'external'
const accessHeaders={'x-december-access':access,'x-december-organizer-token':process.env.DECEMBER_ORGANIZER_TOKEN || ''}
const SERVER_INFO = { name: 'december', version: '0.1.0' }

let toolsCache = null
async function fetchTools() {
  if (toolsCache) return toolsCache
  if (boardError) throw new Error(boardError)
  const res = await fetch(`${BASE}/api/tools`,{headers:accessHeaders})
  toolsCache = (await res.json()).tools
  return toolsCache
}

// House manners travel with the connection. A client that knows nothing about
// skills still learns how to behave in someone's December, and it learns it
// from the running server rather than from a file copied months ago. December
// being down is not a handshake failure: connect without them and the tools,
// which carry their own guidance, still work.
async function fetchInstructions() {
  try {
    const res = await fetch(`${BASE}/api/manners`)
    if (!res.ok) return undefined
    const { manners } = await res.json()
    return manners || undefined
  } catch {
    return undefined
  }
}

async function forwardTool(name, args) {
  if (boardError) throw new Error(boardError)
  let res
  try {
    res = await fetch(`${BASE}/api/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json',...accessHeaders },
      body: JSON.stringify({ name, arguments: args }),
    })
  } catch {
    throw new Error(`December isn't running at ${BASE} — start it with: node server.mjs`)
  }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'tool call failed')
  return data.result
}

// A coding session: start or reuse the repo's board, then lead the
// instructions with its address so the agent opens it before anything else.
// A board that cannot start never falls back to the person's page.
const OPENER = { darwin: 'open', win32: 'start ""' }[process.platform] || 'xdg-open'
async function connect(params) {
  const info = detectMode({ cwd: process.cwd(), clientName: params?.clientInfo?.name })
  if (info.mode !== 'board') return fetchInstructions()
  const name = [info.repo, info.branch].filter(Boolean).join(' · ')
  try {
    BASE = (await ensureBoard(info)).url.replace(/\/$/, '')
  } catch (err) {
    boardError = `December's board for ${name} did not start: ${err.message}`
    return boardError
  }
  const url = `${BASE}/`
  const manners = await fetchInstructions()
  return [
    `December board for ${name}: ${url}`,
    `Open ${url} in your browser now, before anything else: the harness's built-in browser if it has one, otherwise run \`${OPENER} ${url}\`. The person watches this session's work there.`,
    manners,
  ].filter(Boolean).join('\n\n')
}

// ------------------------------------------------- JSON-RPC over stdio

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

const rl = createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  line = line.trim()
  if (!line) return
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = req
  try {
    // nothing is forwarded until the handshake has settled where BASE points
    if (method !== 'initialize' && connected) await connected
    if (method === 'initialize') {
      connected = connect(params)
      const instructions = await connected
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          ...(instructions ? { instructions } : {}),
        },
      })
    } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      // notifications get no response
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: await fetchTools() } })
    } else if (method === 'tools/call') {
      try {
        const args = params.arguments || {}
        const result = await forwardTool(params.name, args)
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } })
      } catch (err) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } })
      }
    } else if (id != null) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  } catch (err) {
    if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err.message || err) } })
  }
})
