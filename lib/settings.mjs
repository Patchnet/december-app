// December settings — the small dial behind the gear. One file,
// data/settings.json, holding the choices that change who does the
// organizing: which engine (claude | codex) and which model. Empty
// model means the engine's own default.

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, win32 } from 'node:path'
import { homedir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DATA_DIR } from './core.mjs'

const execFileAsync = promisify(execFile)
const SETTINGS_PATH = join(DATA_DIR, 'settings.json')

// Windows: execFile can't resolve npm .cmd shims and Node refuses to spawn
// .cmd files shell-less, so target each CLI's real executable.
export function resolveEngineBinary(engine, options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const home = options.home || homedir()
  const exists = options.exists || existsSync
  const override = String(env[engine === 'claude' ? 'DECEMBER_CLAUDE' : 'DECEMBER_CODEX'] || '').trim()
  if (override) return override

  const name = engine === 'claude' ? 'claude' : 'codex'

  if (platform === 'win32') {
    const pathDirectories = String(env.PATH || env.Path || env.path || '')
      .split(';')
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
    const candidates = pathDirectories.map((directory) => win32.join(directory, `${name}.exe`))

    // Older Claude Code npm installs exposed the native executable here.
    // Keep supporting them, but do not let this legacy location hide native,
    // WinGet, or standalone installs that correctly put `claude` on PATH.
    if (engine === 'claude' && env.APPDATA) {
      candidates.push(win32.join(
        env.APPDATA,
        'npm',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'bin',
        'claude.exe'
      ))
    }
    return candidates.find((candidate) => exists(candidate)) || name
  }

  const pathDirectories = String(env.PATH || '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
  const candidates = [
    ...pathDirectories.map((directory) => join(directory, name)),
    join(home, '.local', 'bin', name),
    join(home, '.npm-global', 'bin', name),
    join(home, '.bun', 'bin', name),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ]
  return candidates.find((candidate) => exists(candidate)) || name
}

export const CLAUDE_BIN = resolveEngineBinary('claude')
export const CODEX_BIN = resolveEngineBinary('codex')

const defaults = () => ({ engine: 'claude', model: '', enginePaths: { claude: '', codex: '' } })

function load() {
  if (!existsSync(SETTINGS_PATH)) return defaults()
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))
    const raw = {
      ...defaults(),
      ...parsed,
      enginePaths: { ...defaults().enginePaths, ...(parsed.enginePaths || {}) },
    }
    if (!['claude', 'codex'].includes(raw.engine)) raw.engine = 'claude'
    for (const key of ['claude', 'codex']) raw.enginePaths[key] = String(raw.enginePaths[key] || '').trim().slice(0, 500)
    return raw
  } catch {
    return defaults()
  }
}

const settings = load()

const configuredBinary = (engine) => {
  const envKey = engine === 'claude' ? 'DECEMBER_CLAUDE' : 'DECEMBER_CODEX'
  return String(process.env[envKey] || '').trim() || settings.enginePaths[engine] || (engine === 'claude' ? CLAUDE_BIN : CODEX_BIN)
}

export const ENGINES = {
  claude: { label: 'Claude Code', get bin() { return configuredBinary('claude') } },
  codex: { label: 'Codex', get bin() { return configuredBinary('codex') } },
}

export const getSettings = () => ({ ...settings, enginePaths: { ...settings.enginePaths } })

export async function updateSettings(patch) {
  if (patch.engine !== undefined) {
    if (!ENGINES[patch.engine]) throw new Error(`unknown engine: ${patch.engine}`)
    settings.engine = patch.engine
  }
  if (patch.model !== undefined) settings.model = String(patch.model).trim().slice(0, 80)
  if (patch.enginePaths !== undefined) {
    if (!patch.enginePaths || typeof patch.enginePaths !== 'object' || Array.isArray(patch.enginePaths)) {
      throw new Error('enginePaths must be an object')
    }
    for (const key of ['claude', 'codex']) {
      if (patch.enginePaths[key] !== undefined) settings.enginePaths[key] = String(patch.enginePaths[key]).trim().slice(0, 500)
    }
    availability = null
  }
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2))
  return getSettings()
}

// Which engines actually exist on this machine — probed once, cached.
let availability = null
export async function detectEngines({ refresh = false } = {}) {
  if (refresh) availability = null
  if (availability) return availability
  const probe = async (bin) => {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 15000 })
      return true
    } catch {
      return false
    }
  }
  const [claude, codex] = await Promise.all([probe(ENGINES.claude.bin), probe(ENGINES.codex.bin)])
  availability = { claude, codex }
  return availability
}
