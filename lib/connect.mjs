// December connections: one zero-dependency engine for the page and CLI.
// Detection is read-only. Files are changed only by explicit register() and
// publishSkills() calls, and every path can be injected for isolated tests.

import { constants as fsConstants } from 'node:fs'
import { access, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENGINES } from './settings.mjs'

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLIENTS = ['claude-code', 'claude-desktop', 'codex', 'cursor']

const labels = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
}

const exists = async (path) => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function options(raw = {}) {
  const env = raw.env || process.env
  const home = resolve(raw.home || env.DECEMBER_CONNECT_HOME || homedir())
  const root = resolve(raw.root || env.DECEMBER_CONNECT_ROOT || DEFAULT_ROOT)
  const platform = raw.platform || process.platform
  const appData = raw.appData || env.DECEMBER_CONNECT_APPDATA ||
    (platform === 'win32' ? join(home, 'AppData', 'Roaming') : join(home, 'Library', 'Application Support'))
  const url = raw.url || env.DECEMBER_CONNECT_URL || `http://localhost:${Number(env.PORT || 3008)}`
  return {
    ...raw,
    env,
    home,
    root,
    platform,
    appData,
    url,
    adapter: resolve(raw.adapter || join(root, 'mcp-server.mjs')),
    binaries: {
      claude: raw.binaries?.claude || ENGINES.claude.bin,
      codex: raw.binaries?.codex || ENGINES.codex.bin,
    },
  }
}

export function connectionPaths(raw = {}) {
  const o = options(raw)
  return {
    adapter: o.adapter,
    sourceSkill: join(o.root, 'skills', 'december'),
    packagedSkill: join(o.root, 'public', 'skills', 'december'),
    claudeDesktop: join(o.appData, 'Claude', 'claude_desktop_config.json'),
    claudeDesktopBackup: join(o.appData, 'Claude', 'claude_desktop_config.json.bak'),
    codex: join(o.home, '.codex', 'config.toml'),
    cursor: join(o.home, '.cursor', 'mcp.json'),
    skillTargets: {
      claude: join(o.home, '.claude', 'skills', 'december'),
      codex: join(o.home, '.codex', 'skills', 'december'),
      cursor: join(o.home, '.cursor', 'skills', 'december'),
    },
  }
}

function run(bin, args, raw = {}) {
  if (raw.run) return raw.run(bin, args, raw)
  return new Promise((resolveRun, reject) => {
    execFile(bin, args, { timeout: raw.timeout || 15000, maxBuffer: 1024 * 1024, env: raw.env }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolveRun({ stdout: String(stdout || ''), stderr: String(stderr || '') })
      }
    })
  })
}

async function probe(bin, o) {
  try {
    await run(bin, ['--version'], o)
    return true
  } catch {
    return false
  }
}

async function readJson(path, fallback = null) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('the top level must be an object')
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`could not read ${path}: ${error.message}`)
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return ''
    throw error
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

function claudeListHasDecember(output) {
  return String(output || '').split(/\r?\n/).some((line) => /^\s*december\s*(?::|\s)/i.test(line))
}

function tomlDecemberRange(text) {
  const header = /^\s*\[mcp_servers\.december\]\s*(?:\r?\n|$)/m.exec(text)
  if (!header) return null
  const afterHeader = header.index + header[0].length
  const nextHeader = /^\s*\[[^\]]+\]\s*$/gm
  nextHeader.lastIndex = afterHeader
  const next = nextHeader.exec(text)
  return { start: header.index, end: next ? next.index : text.length }
}

export function hasCodexRegistration(text) {
  return !!tomlDecemberRange(String(text || ''))
}

function baseDetection(client, installed, registered, detail = '') {
  return { client, label: labels[client], installed, registered, detail }
}

export async function detect(raw = {}) {
  const o = options(raw)
  const paths = connectionPaths(o)
  const [claudeInstalled, codexInstalled, desktopConfig, codexText, cursorConfig] = await Promise.all([
    probe(o.binaries.claude, o),
    probe(o.binaries.codex, o),
    readJson(paths.claudeDesktop, null),
    readText(paths.codex),
    readJson(paths.cursor, null),
  ])

  let claudeRegistered = false
  let claudeDetail = ''
  if (claudeInstalled) {
    try {
      const listed = await run(o.binaries.claude, ['mcp', 'list'], o)
      claudeRegistered = claudeListHasDecember(listed.stdout)
    } catch (error) {
      claudeRegistered = null
      claudeDetail = `could not read Claude Code's MCP list: ${String(error.stderr || error.message || error).trim().slice(-180)}`
    }
  }

  return {
    'claude-code': baseDetection('claude-code', claudeInstalled, claudeRegistered, claudeDetail),
    'claude-desktop': baseDetection(
      'claude-desktop',
      desktopConfig !== null,
      !!desktopConfig?.mcpServers?.december
    ),
    codex: baseDetection('codex', codexInstalled, hasCodexRegistration(codexText)),
    cursor: baseDetection('cursor', cursorConfig !== null, !!cursorConfig?.mcpServers?.december),
  }
}

function desiredJsonRegistration(o) {
  return { command: 'node', args: [o.adapter], env: { DECEMBER_URL: o.url } }
}

function sameRegistration(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b)
}

async function registerClaudeCode(o) {
  // Claude does not replace a same-name user registration consistently
  // across versions. Remove only December, then add the current instance.
  try {
    await run(o.binaries.claude, ['mcp', 'remove', 'december', '--scope', 'user'], o)
  } catch {}
  await run(o.binaries.claude, [
    'mcp', 'add', '--scope', 'user', '--env', `DECEMBER_URL=${o.url}`,
    'december', '--', 'node', o.adapter,
  ], o)
  return { client: 'claude-code', files: [] }
}

async function registerJson(client, path, o, { backup = '' } = {}) {
  const current = await readJson(path, {})
  const desired = desiredJsonRegistration(o)
  if (sameRegistration(current.mcpServers?.december, desired)) return { client, files: [path], changed: false }
  if (backup && await exists(path) && !await exists(backup)) {
    await mkdir(dirname(backup), { recursive: true })
    try {
      await copyFile(path, backup, fsConstants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  current.mcpServers = { ...(current.mcpServers || {}), december: desired }
  await atomicWrite(path, `${JSON.stringify(current, null, 2)}\n`)
  return { client, files: [path], changed: true, backup: backup || undefined }
}

function tomlString(value) {
  return JSON.stringify(String(value))
}

export function writeCodexRegistration(text, { adapter, url }) {
  const forwardAdapter = String(adapter).replaceAll('\\', '/')
  const block = [
    '[mcp_servers.december]',
    'command = "node"',
    `args = [${tomlString(forwardAdapter)}]`,
    `env = { DECEMBER_URL = ${tomlString(url)} }`,
    '',
  ].join('\n')
  const source = String(text || '')
  const range = tomlDecemberRange(source)
  if (!range) return `${source.trimEnd()}${source.trim() ? '\n\n' : ''}${block}`
  const before = source.slice(0, range.start).trimEnd()
  const after = source.slice(range.end).trimStart()
  return `${before}${before ? '\n\n' : ''}${block}${after}`
}

async function registerCodex(o, path) {
  const current = await readText(path)
  const next = writeCodexRegistration(current, o)
  if (next !== current) await atomicWrite(path, next)
  return { client: 'codex', files: [path], changed: next !== current }
}

export async function register(client, raw = {}) {
  if (!CLIENTS.includes(client)) throw new Error(`unknown client: ${client}`)
  const o = options(raw)
  const paths = connectionPaths(o)
  if (client === 'claude-code') return registerClaudeCode(o)
  if (client === 'claude-desktop') {
    return registerJson(client, paths.claudeDesktop, o, { backup: paths.claudeDesktopBackup })
  }
  if (client === 'codex') return registerCodex(o, paths.codex)
  return registerJson(client, paths.cursor, o)
}

function skillVersion(text) {
  const match = /^---\s*[\s\S]*?^version:\s*["']?([^\s"']+)/m.exec(String(text || ''))
  return match?.[1] || '0.0.0'
}

function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const right = String(b).split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0)
  }
  return 0
}

export async function publishSkills(raw = {}) {
  const o = options(raw)
  const paths = connectionPaths(o)
  // Electron runs the unpacked server beside unpacked public assets. The
  // canonical root skill is used in source checkouts; its packaged mirror is
  // the fallback when the installer did not copy root-level skills.
  const sourceSkill = await exists(paths.sourceSkill) ? paths.sourceSkill : paths.packagedSkill
  const sourceManifest = join(sourceSkill, 'SKILL.md')
  const sourceVersion = skillVersion(await readFile(sourceManifest, 'utf8'))
  const result = {}
  for (const [harness, target] of Object.entries(paths.skillTargets)) {
    let targetVersion = '0.0.0'
    try {
      targetVersion = skillVersion(await readFile(join(target, 'SKILL.md'), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (!await exists(target) || compareVersions(sourceVersion, targetVersion) > 0) {
      await rm(target, { recursive: true, force: true })
      await mkdir(dirname(target), { recursive: true })
      await cp(sourceSkill, target, { recursive: true })
      result[harness] = { status: 'published', version: sourceVersion, path: target }
    } else {
      result[harness] = { status: 'kept', version: targetVersion, path: target }
    }
  }
  return result
}

async function serverAnswers(o) {
  let timer
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), o.fetchTimeout || 3000)
    const response = await (o.fetch || globalThis.fetch)(`${o.url}/api/tools`, { signal: controller.signal })
    if (!response.ok) return { ok: false, detail: `December answered ${response.status}` }
    const body = await response.json()
    return Array.isArray(body.tools)
      ? { ok: true }
      : { ok: false, detail: 'December did not return its tool list' }
  } catch (error) {
    return { ok: false, detail: `December is not answering at ${o.url}: ${error.message}` }
  } finally {
    clearTimeout(timer)
  }
}

export async function verify(client, raw = {}) {
  if (!CLIENTS.includes(client)) return { client, state: 'error', detail: `unknown client: ${client}` }
  const o = options(raw)
  let found
  try {
    found = raw.detected?.[client] || (await detect(o))[client]
  } catch (error) {
    return { client, label: labels[client], state: 'error', detail: error.message }
  }
  if (!found.installed) return { ...found, state: 'not-installed' }
  if (found.registered === null) return { ...found, state: 'error', detail: found.detail || 'registration is unknown' }
  if (!found.registered) return { ...found, state: 'available' }
  if (!await exists(o.adapter)) return { ...found, state: 'error', detail: `adapter not found: ${o.adapter}` }
  const server = await serverAnswers(o)
  return server.ok
    ? { ...found, state: 'connected', url: o.url }
    : { ...found, state: 'error', detail: server.detail, url: o.url }
}

export async function statuses(raw = {}) {
  let detected
  try {
    detected = await detect(raw)
  } catch (error) {
    return Object.fromEntries(CLIENTS.map((client) => [client, {
      client,
      label: labels[client],
      installed: false,
      registered: false,
      state: 'error',
      detail: error.message,
    }]))
  }
  const entries = await Promise.all(CLIENTS.map(async (client) => [client, await verify(client, { ...raw, detected })]))
  return Object.fromEntries(entries)
}
