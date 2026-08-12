// December settings — the small dial behind the gear. One file,
// data/settings.json, holding the choices that change who does the
// organizing: which engine (claude | codex) and which model. Empty
// model means the engine's own default.

import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ROOT } from './core.mjs'

const execFileAsync = promisify(execFile)
const SETTINGS_PATH = join(ROOT, 'data', 'settings.json')

// Windows: execFile can't resolve npm .cmd shims and Node refuses to spawn
// .cmd files shell-less, so target each CLI's real executable.
export const CLAUDE_BIN =
  process.env.DECEMBER_CLAUDE ||
  (process.platform === 'win32'
    ? join(process.env.APPDATA || '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    : 'claude')
export const CODEX_BIN = process.env.DECEMBER_CODEX || 'codex' // native exe; resolves on all platforms

export const ENGINES = {
  claude: { label: 'Claude Code', bin: CLAUDE_BIN },
  codex: { label: 'Codex', bin: CODEX_BIN },
}

const defaults = () => ({ engine: 'claude', model: '' })

function load() {
  if (!existsSync(SETTINGS_PATH)) return defaults()
  try {
    const raw = { ...defaults(), ...JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) }
    if (!ENGINES[raw.engine]) raw.engine = 'claude'
    return raw
  } catch {
    return defaults()
  }
}

const settings = load()

export const getSettings = () => ({ ...settings })

export async function updateSettings(patch) {
  if (patch.engine !== undefined) {
    if (!ENGINES[patch.engine]) throw new Error(`unknown engine: ${patch.engine}`)
    settings.engine = patch.engine
  }
  if (patch.model !== undefined) settings.model = String(patch.model).trim().slice(0, 80)
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true })
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2))
  return getSettings()
}

// Which engines actually exist on this machine — probed once, cached.
let availability = null
export async function detectEngines() {
  if (availability) return availability
  const probe = async (bin) => {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 15000 })
      return true
    } catch {
      return false
    }
  }
  const [claude, codex] = await Promise.all([probe(CLAUDE_BIN), probe(CODEX_BIN)])
  availability = { claude, codex }
  return availability
}
