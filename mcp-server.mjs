#!/usr/bin/env node
// December MCP adapter — stdio, zero dependencies, and deliberately thin.
// It holds NO state and touches no files: every page tool call forwards over
// loopback HTTP to the running December server, the one writer. Two
// adapters share that seam: the page's routes and this one.
//
// The two lookup tools are the exception, and answered here: they write
// nothing, so they need no writer, and living in this process is what makes
// them harness-neutral — every engine that speaks MCP gets the same two.
//
// Connect from Claude Code:    claude mcp add december -- node <this file>
// Connect from Claude Desktop: add the same command under mcpServers.

import { createInterface } from 'node:readline'
import { WEB_TOOLS, isWebTool, callWebTool } from './lib/web-lookup.mjs'

const BASE = process.env.DECEMBER_URL || 'http://localhost:3008'
const SERVER_INFO = { name: 'december', version: '0.1.0' }

let toolsCache = null
async function fetchTools() {
  if (toolsCache) return toolsCache
  const res = await fetch(`${BASE}/api/tools`)
  toolsCache = [...(await res.json()).tools, ...WEB_TOOLS]
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
  let res
  try {
    res = await fetch(`${BASE}/api/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args }),
    })
  } catch {
    throw new Error(`December isn't running at ${BASE} — start it with: node server.mjs`)
  }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'tool call failed')
  return data.result
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
    if (method === 'initialize') {
      const instructions = await fetchInstructions()
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
        const result = isWebTool(params.name) ? await callWebTool(params.name, args) : await forwardTool(params.name, args)
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
