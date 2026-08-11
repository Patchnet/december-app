// The settle pass — a subscription-powered agent (claude -p) connected to
// December's own MCP tool surface. This module owns the debounce and the
// state machine, and its status() is honest: failures cross the interface
// instead of leaving captures shimmering forever.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ROOT, hasInbox } from './core.mjs'

const execFileAsync = promisify(execFile)
const MCP_CONFIG_PATH = join(ROOT, 'mcp.json')
const MODEL = process.env.DECEMBER_MODEL || 'claude-sonnet-5'

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
    JSON.stringify({ mcpServers: { december: { command: 'node', args: [join(ROOT, 'mcp-server.mjs')] } } }, null, 2)
  )
}

const PROMPT = () => `You are the organizing engine of December: a personal page where a person writes raw text and it organizes itself. The frame is the year — what will they have done by December. Today is ${new Date().toISOString().slice(0, 10)}.

Use your december_* tools, nothing else. Work like this:

1. Call december_view. It gives you every space and block (with ids), the inbox of unfiled captures, and the lessons this person has taught you. Obey the lessons, always.
2. Organize ONLY the inbox captures, using the tools. Everything you create must come from the captures themselves: never invent a space, block, or entry the captures do not call for. Prefer existing spaces and blocks; create only for clearly new territory. Space names are short, human, and drawn from the person's own words. One capture may touch several blocks (a payment can be both a ledger entry and a tracker tick).
3. If a capture asks for something ("I'd like a progress bar for X this year"), build exactly that — a tracker with the target the capture implies (a monthly thing across a year means target 12).
4. If a capture corrects how you organize, obey it now and call december_learn so it sticks.
5. Extract the numbers captures contain. Yearly goals get yearly targets; be realistic about what remains of the year.
6. Never invent content the person did not write. Never delete anything.
7. Finish by calling december_file_capture EXACTLY ONCE per inbox capture, into its single best space, with a plain-words summary of what you did. Nothing may remain unfiled.
8. When a tracker's target is a by-December goal, set its period to "year" so the bar carries a today marker.
9. After filing, you may call december_suggest with up to three short follow-ups the person might naturally say next — complete sentences drawn from their own content, since a tap files one as if typed. Refresh or clear them every pass.
10. If a capture was genuinely ambiguous between concrete placements, file your best guess and then call december_ask once: a short question with 2 to 4 options, each a complete standalone statement that resolves it. Asks are rare; most passes need none.
11. A capture may carry a hint naming the space the person was looking at when they wrote it; strongly prefer that space.
12. When a reminder implies a date ("thursday", "sept 1"), set its when (YYYY-MM-DD, resolved from today's date).
13. Pass the capture's id as source on every december_create_block and december_update_block call, so each change can show which words it came from.
14. Block titles only when they add information the space name and unit do not already carry. Never restate the space name, never title a note "Notes", never use em dashes anywhere.
15. Last, call december_surface with up to three things that deserve attention today or tomorrow: an appointment or dated reminder coming up, a rhythm about to be missed (rent nearly due and not logged), a tracker today matters for. Each needs a short label, a few-words reason, its space, and until. If nothing genuinely qualifies, pass an empty list. Irrelevant surfacing is worse than none.

Keep your text output to a single short line; nobody reads it. The tools are the work.`

async function run() {
  if (s.running) {
    s.pending = true
    return
  }
  if (!hasInbox()) return
  s.running = true
  s.lastError = null
  try {
    // Deliberately NOT december_undo or december_capture: the settle engine
    // organizes; it never reverts the page or writes captures of its own.
    const allowed = ['view', 'create_space', 'create_block', 'update_block', 'file_capture', 'learn', 'suggest', 'ask', 'surface']
      .map((t) => `mcp__december__december_${t}`)
      .join(',')
    await execFileAsync(
      'claude',
      ['-p', PROMPT(), '--model', MODEL, '--mcp-config', MCP_CONFIG_PATH, '--allowedTools', allowed],
      { timeout: 240000, maxBuffer: 4 * 1024 * 1024, cwd: ROOT }
    )
    if (hasInbox()) s.lastError = 'some captures were left unfiled'
  } catch (err) {
    s.lastError = String(err.message || err).slice(0, 300)
  } finally {
    s.lastRunAt = new Date().toISOString()
    s.running = false
    if (s.pending) {
      s.pending = false
      schedule(500)
    }
  }
}

export function schedule(delay = 2500) {
  clearTimeout(s.timer)
  s.timer = setTimeout(run, delay)
}

// ---------------------------------------------------- the surfacing sense
// Runs on its own clock, even when nothing was typed: what has quietly
// become relevant? Tomorrow's appointment rises tonight.

const SURFACE_PROMPT = () => {
  const now = new Date()
  return `You are December's surfacing sense. Today is ${now.toISOString().slice(0, 10)} (${now.toLocaleString('en', { weekday: 'long' })}).

Call december_view, read the whole page, then call december_surface with AT MOST three things that deserve the person's attention today or tomorrow: a dated reminder or appointment coming up, a rhythm about to be missed (rent nearly due and not yet logged), a tracker or streak that today matters for. Each item: a short plain label, a few-words reason, its space name, and until (YYYY-MM-DD, the last day it stays relevant).

If nothing genuinely qualifies, call december_surface with an empty list. Surfacing something irrelevant is worse than surfacing nothing. Keep your text output to one short line.`
}

let surfacing = false

export async function runSurface() {
  if (surfacing || s.running) return
  surfacing = true
  try {
    const allowed = ['mcp__december__december_view', 'mcp__december__december_surface'].join(',')
    await execFileAsync(
      'claude',
      ['-p', SURFACE_PROMPT(), '--model', MODEL, '--mcp-config', MCP_CONFIG_PATH, '--allowedTools', allowed],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024, cwd: ROOT }
    )
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
