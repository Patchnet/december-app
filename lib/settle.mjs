// The settle pass — a subscription-powered agent connected to December's
// own MCP tool surface. This module owns the debounce and the state
// machine, and its status() is honest: failures cross the interface
// instead of leaving captures shimmering forever.
//
// Two engines (the gear picks): Claude runs as a persistent agent — one
// long-running process holds the MCP connection and standing instructions,
// each settle is just another streamed turn. Codex runs one-shot per pass.

import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { ROOT, hasInbox } from './core.mjs'
import { getSettings, ENGINES } from './settings.mjs'

const execFileAsync = promisify(execFile)
// Port-suffixed so a second instance (another port, same checkout) can't
// repoint the running instance's settle agent at itself.
const MCP_CONFIG_PATH = join(ROOT, `mcp.${Number(process.env.PORT || 3008)}.json`)
// Filing into six block types is extraction, not reasoning: Haiku does it
// in a fraction of the time. Override with the gear or DECEMBER_MODEL.
const DEFAULT_MODEL = process.env.DECEMBER_MODEL || 'claude-haiku-4-5-20251001'
const baseUrl = () => `http://localhost:${Number(process.env.PORT || 3008)}`

const s = { running: false, pending: false, timer: null, lastError: null, lastRunAt: null }

export const status = () => ({
  running: s.running,
  pending: s.pending,
  lastError: s.lastError,
  lastRunAt: s.lastRunAt,
})

/** Written once at boot; the settle agent connects like any external client. */
export async function writeMcpConfig() {
  await writeFile(
    MCP_CONFIG_PATH,
    JSON.stringify(
      {
        mcpServers: {
          december: { command: 'node', args: [join(ROOT, 'mcp-server.mjs')], env: { DECEMBER_URL: baseUrl() } },
        },
      },
      null,
      2
    )
  )
}

const PROMPT = () => `You are the organizing engine of December: a personal page where a person writes raw text and it organizes itself. Today is ${new Date().toLocaleDateString('en-CA')}. These are your STANDING INSTRUCTIONS for this session.

Use only your december_* tools (plus file reading when a capture points at an attached file). Be fast: batch independent tool calls together and finish in as few turns as possible.

Each pass: call december_view. It shows EVERY space and block (with ids), the inbox captures, and the lessons (obey lessons always). Long content is condensed with markers (moreEntries, moreDone, textTruncated); when a capture depends on something elided, call december_read_block for the full block. Then organize ONLY the inbox captures:
- Everything you create must come from the captures. Prefer existing spaces and blocks; create only for clearly new territory. Space names are short, human, from the person's own words. One capture may touch several blocks.
- Extract numbers. Yearly goals get yearly targets. Reminders that imply a date get when (YYYY-MM-DD); ones that recur ("every month") also get repeat (daily|weekly|monthly|yearly). A capture's hint names the space the person was viewing: strongly prefer it.
- If a capture asks for something ("a progress bar for X"), build exactly that. If it corrects you, obey and december_learn so it sticks.
- Never invent content, never delete. Block titles only when they add information; never restate the space name; no em dashes.
- A capture beginning "[attached file: <path>]" is a document the person dropped onto the page: read that file (PDF, image, or text) and organize its contents as the person's own words; the filing summary names the document.
- Pass the capture's id as source on every create/update call.
- File EVERY capture exactly once (december_file_capture: best space + plain-words summary). Nothing stays unfiled.
- Then: december_suggest with up to three short follow-ups in the person's own words (or clear); december_ask ONE short question with 2-4 standalone-statement options only when genuinely ambiguous (file best guess anyway); december_surface ONLY items the person must ACT on within a day or two (a deadline arriving, a rhythm about to lapse). Never progress commentary, encouragement, or restating what a card shows. An empty list is the normal case.

Keep text output to one short line.`

const RESUME_PROMPT = () =>
  `New captures are in the inbox (today is ${new Date().toLocaleDateString('en-CA')}). Run one pass per your standing instructions, then stop.`

// The persistent agent: one long-running Claude process holds the MCP
// connection and the standing instructions; each settle is just another
// turn fed over stream-json. No per-settle boot, no re-reading the rules.
// Rotates every 20 turns so the transcript stays bounded.

const ALLOWED = ['view', 'read_block', 'create_space', 'create_block', 'update_block', 'file_capture', 'learn', 'suggest', 'ask', 'surface']
  .map((t) => `mcp__december__december_${t}`)
  .concat('Read') // attached-file captures
  .join(',')

const agent = { proc: null, turns: 0, waiting: null, stderrTail: '', model: null }

function killAgent() {
  try {
    agent.proc?.kill()
  } catch {}
  agent.proc = null
  agent.waiting = null
}

function ensureAgent(model) {
  if (agent.proc && agent.model !== model) killAgent() // gear changed: respawn on the new model
  if (agent.proc) return
  const proc = spawn(
    ENGINES.claude.bin,
    ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
     '--model', model, '--mcp-config', MCP_CONFIG_PATH, '--allowedTools', ALLOWED],
    { cwd: ROOT }
  )
  agent.proc = proc
  agent.turns = 0
  agent.stderrTail = ''
  agent.model = model
  const rl = createInterface({ input: proc.stdout })
  rl.on('line', (line) => {
    let ev
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (ev.type === 'result') {
      const w = agent.waiting
      agent.waiting = null
      w?.resolve(ev)
    }
  })
  proc.stderr.on('data', (d) => {
    agent.stderrTail = (agent.stderrTail + d).slice(-500)
  })
  proc.on('exit', () => {
    const w = agent.waiting
    const tail = agent.stderrTail.slice(-200)
    agent.proc = null
    agent.waiting = null
    w?.reject(new Error(`agent exited: ${tail}`))
  })
}

function turn(text, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      agent.waiting = null
      killAgent()
      reject(new Error('settle turn timed out'))
    }, timeoutMs)
    agent.waiting = {
      resolve: (v) => {
        clearTimeout(t)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(t)
        reject(e)
      },
    }
    agent.proc.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
    )
  })
}

// ---------------------------------------------------- one-shot codex runs

/** Codex has no persistent stream mode here; each pass is one codex exec
    against the same MCP surface. Model empty = the CLI's own default. */
async function runCodex(prompt, { timeout, maxBuffer }) {
  const { model } = getSettings()
  // forward slashes: backslash paths trip codex's TOML value parsing
  const mcpArgs = JSON.stringify(join(ROOT, 'mcp-server.mjs').replaceAll('\\', '/'))
  const args = [
    'exec',
    prompt,
    '--skip-git-repo-check',
    '-c', 'mcp_servers.december.command="node"',
    '-c', `mcp_servers.december.args=[${mcpArgs}]`,
    '-c', `mcp_servers.december.env={DECEMBER_URL="${baseUrl()}"}`,
    '-c', 'sandbox_mode="read-only"',
  ]
  if (model) args.push('--model', model)
  const p = execFileAsync(ENGINES.codex.bin, args, { timeout, maxBuffer, cwd: ROOT })
  p.child.stdin.end() // codex waits on a piped stdin; close it so it sees EOF
  return p
}

async function run() {
  if (s.running) {
    s.pending = true
    return
  }
  if (!hasInbox()) return
  s.running = true
  s.lastError = null
  const { engine, model } = getSettings()
  try {
    if (engine === 'codex') {
      await runCodex(`${PROMPT()}\n\nRun the pass now.`, { timeout: 240000, maxBuffer: 4 * 1024 * 1024 })
    } else {
      ensureAgent(model || DEFAULT_MODEL)
      const first = agent.turns === 0
      agent.turns++
      await turn(first ? PROMPT() + '\n\nRun the first pass now.' : RESUME_PROMPT(), 240000)
      if (agent.turns >= 20) killAgent() // rotate: next settle boots fresh
    }
    if (hasInbox()) s.lastError = 'some captures were left unfiled'
  } catch (err) {
    killAgent()
    // stderr tail over err.message: execFile's message leads with the whole
    // command line, which buries the actual failure.
    const detail = String(err.stderr || '').trim().slice(-300)
    s.lastError = detail || String(err.message || err).slice(0, 300)
  } finally {
    s.lastRunAt = new Date().toISOString()
    s.running = false
    if (s.pending) {
      s.pending = false
      schedule(400)
    }
  }
}

export function schedule(delay = 700) {
  clearTimeout(s.timer)
  s.timer = setTimeout(run, delay)
}

// ---------------------------------------------------- the surfacing sense
// Runs on its own clock, even when nothing was typed: what has quietly
// become relevant? Tomorrow's appointment rises tonight.

const SURFACE_PROMPT = () => {
  const now = new Date()
  return `You are December's surfacing sense. Today is ${now.toLocaleDateString('en-CA')} (${now.toLocaleString('en', { weekday: 'long' })}).

Call december_view, read the whole page, then call december_surface with AT MOST three things the person must ACT on within a day or two: an undated deadline arriving, a rhythm about to lapse (rent nearly due and not yet logged). NEVER progress commentary, encouragement, or anything a card already shows; dated reminders surface themselves, so do not repeat them. Each item: a short plain action label, a few-words reason, its space name, and until (YYYY-MM-DD).

An empty list is the NORMAL case; most days nothing qualifies. Keep your text output to one short line.`
}

let surfacing = false

export async function runSurface() {
  if (surfacing || s.running) return
  surfacing = true
  const { engine, model } = getSettings()
  try {
    if (engine === 'codex') {
      await runCodex(SURFACE_PROMPT(), { timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
    } else {
      const allowed = ['mcp__december__december_view', 'mcp__december__december_surface'].join(',')
      await execFileAsync(
        ENGINES.claude.bin,
        ['-p', SURFACE_PROMPT(), '--model', model || DEFAULT_MODEL, '--mcp-config', MCP_CONFIG_PATH, '--allowedTools', allowed],
        { timeout: 120000, maxBuffer: 2 * 1024 * 1024, cwd: ROOT }
      )
    }
  } catch {
    /* quiet: the next pass will try again */
  } finally {
    surfacing = false
  }
}

export function scheduleSurfacing() {
  setTimeout(runSurface, 15000) // shortly after boot
  setInterval(runSurface, 6 * 3600 * 1000) // and through the day
}
