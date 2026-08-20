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
import { ROOT, hasInbox, agentView, setSurfaced } from './core.mjs'
import { getSettings, ENGINES } from './settings.mjs'

const execFileAsync = promisify(execFile)
// Port-suffixed so a second instance (another port, same checkout) can't
// repoint the running instance's settle agent at itself.
const MCP_CONFIG_PATH = join(ROOT, `mcp.${Number(process.env.PORT || 3008)}.json`)
// Organizing is judgment, not extraction: which space this belongs in, what
// shape it wants, what the person actually meant. Haiku was measurably
// faster and measurably worse at exactly that, so quality wins here.
// Override with the gear or DECEMBER_MODEL.
const DEFAULT_MODEL = process.env.DECEMBER_MODEL || 'claude-sonnet-5'
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

const PROMPT = () => `You are the organizing engine of December: a personal page where a person writes raw text and it organizes itself. Today is ${new Date().toLocaleDateString('en-CA')} and the local time is ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}. These are your STANDING INSTRUCTIONS for this session.

Use only your december_* tools (plus file reading when a capture points at an attached file). Be fast: batch independent tool calls together and finish in as few turns as possible.

Each pass: call december_view. It shows About Me, EVERY space and block (with ids), the inbox captures, and the lessons (obey lessons always). Read About Me first. Long content is condensed with markers (moreEntries, moreDone, textTruncated); when a capture depends on something elided, call december_read_block for the full block. Then organize ONLY the inbox captures:
- Standing facts about the person — family, likes, birthdays, schools, addresses, who they are — go in About Me via december_write_about (append). Do not turn those into list items. Lessons stay lessons: they are how to file, not who they are. Use append; never overwrite the whole profile unless they asked to replace it. Never invent.
- Actions go on a list or reminder. Standing facts, addresses, people, and likes go in a note or About Me.
- Everything you create must come from the captures. Prefer existing spaces and blocks; create only for clearly new territory. Space names are short, human, from the person's own words. One capture may touch several blocks.
- Extract numbers. A tracker is for something counted toward a target the person actually named; when there is no target, a ledger or a list says it better than a bar stuck at zero. Count in the unit they used, and set period 'year' only for a total that builds steadily across the year. Reminders that imply a date get when (YYYY-MM-DD); ones that name a clock time ("9am", "at 3:30", "dentist tuesday morning" is NOT a time) also get at (HH:MM, 24h); ones that recur ("every month") also get repeat (daily|weekly|monthly|yearly). A capture's hint names the space the person was viewing: strongly prefer it.
- If a capture asks for something ("a progress bar for X"), build exactly that. If it corrects you, obey and december_learn so it sticks.
- Never invent content, never delete. Block titles only when they add information; never restate the space name; no em dashes.
- A compound sentence files as the actions it contains, each one complete and self-contained. Connective and filler clauses ("let's get that done", "and then also") are never items — fold them into the action they refer to.
- A capture beginning "[attached file: <path>]" is a document the person dropped onto the page: read that file (PDF, image, or text) and organize its contents as the person's own words; the filing summary names the document.
- Each block type has its own small verb: add_or_check (list), move_tracker, log_amount (ledger), mark_day (streak), write_note, set_reminder. Pass the capture's id as source on every create and verb call.
- When a capture names people, organizations, places, or distinct things, set entities with normalized names: short, human, and in the person's own words. A reminder's place is its place entity. Never invent entities the words do not name.
- File EVERY capture exactly once (december_file_capture: best space + plain-words summary). Nothing stays unfiled. When something lands more than a week out, the summary names its month plainly ("dinner with Ana, filed to October") — the person finds it later by flipping the year to that month.
- Give every space you create or touch an area with december_set_area (Money, Health, Work, Home, Learning, People...), and also fix up any space in the view whose area is empty — those fall into an "other" pile on the page. Reuse existing area names; keep the set small.
- Whenever you had to GUESS at a detail to file something, ask about it: december_ask ONE short question naming the thing ("what time is lunch with your sister on Friday?", "how much was the deposit?"). Give NO options when the answer is a time, an amount, or a date — they type it. Give 2-4 standalone-statement options only when the answer is a choice between things you can name ("Groceries go under Food"). One question per pass at most, never about something the capture already answered, and never a yes/no. File your best guess regardless — the question refines what you filed, it never blocks it.
- december_suggest up to three short follow-ups in the person's own words, when they add something and an obvious next line exists. Clear them otherwise.
- Then december_surface. The view's surfaced list is what is on the page right now: SEND BACK every one of those that still stands, or it disappears. Add to it, up to three total, things that need doing SOON but that the page does not already show: someone to call back, someone coming over, a commitment going stale, a rhythm about to lapse, something dated a few days out that needs preparing first. Never surface a dated reminder that falls inside the next seven days: the page now lists a whole week of them itself, so repeating one says it twice. The PREPARATION for such a thing is still worth surfacing, because that is a different job with no date on it ("get quotes from three movers" while "moving day" sits on the 17th). Never surface something you are already asking about with december_ask — the question is on the page already, and saying it twice reads as a glitch. Drop one only when it is done or no longer true. Pass an empty list only when nothing at all qualifies; surfacing something irrelevant is worse than surfacing nothing. These are things to ACT on — never put them in december_suggest instead.
- GOALS are counts, tasks are finish lines. A goal is a total the person accumulates toward (200 miles, 24 books, $10k); "my goal is to launch the site", "goal for today: clean the garage" name finish lines crossed once — those are tasks (a reminder or list item, dated if they said when), NEVER a 1-of-1 tracker or a goal. Goal-flavoured words do not make something a goal; a number they are counting toward does. When the person names a total they want to reach ("my goal this year is 200 miles", "read 24 books by December", "$10k saved by October"), that is a goal, and it MUST be marked as one: create the tracker with goal: true (and by, if they named a nearer date), or call december_set_goal on the block that already counts it (a tracker, ledger, streak, or list). A bare tracker is not a goal. The view lists goals first, each with where it stands and quietDays since it last moved. Progress in a goal's unit or space goes into THAT goal's block with the block's own verb; never create a second block for what a goal already counts. When they say a goal no longer matters ("drop the running goal", "stop tracking that", "that's not a goal anymore"), lift it with december_set_goal target 0 — the block and its history stay; never archive the space for this unless they say so. When the person starts counting a goal in a new shape (logging individual runs against a mileage tracker), create the right block and december_move_goal onto it — where it stands never changes. A goal quiet for weeks is worth a gentle december_surface line, not a question.
- When the person says something matters most, december_pin it; when they say something is done, december_finish it; when they ask for different wording, december_rename it. Never pin or finish as tidying.

Keep text output to one short line.`

const RESUME_PROMPT = () =>
  `New captures are in the inbox (today is ${new Date().toLocaleDateString('en-CA')}, local time ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}). Run one pass per your standing instructions, then stop.`

// The persistent agent: one long-running Claude process holds the MCP
// connection and the standing instructions; each settle is just another
// turn fed over stream-json. No per-settle boot, no re-reading the rules.
// Rotates every 20 turns so the transcript stays bounded.

const ALLOWED = [
  'view', 'read_block', 'create_space', 'create_block', 'file_capture', 'learn',
  'add_or_check', 'move_tracker', 'log_amount', 'mark_day', 'write_note', 'set_reminder',
  'retitle', 'rename', 'suggest', 'ask', 'set_area', 'pin', 'finish', 'surface', 'write_about', 'set_goal', 'move_goal',
]
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
  // A binary that moved (a CLI upgrade rewriting its symlink) makes spawn
  // emit 'error'. Unhandled, that is an uncaught exception and the server
  // dies holding the person's page. It must degrade, never crash.
  proc.on('error', (err) => {
    const w = agent.waiting
    agent.proc = null
    agent.waiting = null
    w?.reject(new Error(`could not start ${ENGINES.claude.bin}: ${err.code || err.message}`))
  })
  proc.stdin.on('error', () => {}) // the far end can close mid-write
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
    try {
      agent.proc.stdin.write(
        JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n'
      )
    } catch (err) {
      agent.waiting = null
      killAgent()
      reject(new Error(`agent write failed: ${err.message}`))
    }
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

// ------------------------------------------------------ asking the page
// The search field routes a question here instead of filing it. This
// existed on the page — the field, the thinking state, the answer slot —
// and called a function that was never written, so every question came
// back "settle.answerQuestion is not a function".

const ASK_PROMPT = (page, question) => `You answer questions about one person's December page: the place they write things down so they do not have to hold them in their head. Today is ${new Date().toLocaleDateString('en-CA')}.

Their page, as JSON:
${page.slice(0, 60000)}

Their question: ${question}

Answer from the page and nothing else. One or two short sentences, plain words, no preamble and no markdown. Give the number when they asked for a number, and say where it came from ("$1,240 on the car, across 4 entries since March"). If the page does not say, tell them that plainly rather than guessing. Never invent an entry, a total, or a date.`

/** Ask the page a question and get a sentence back, not a filed note. */
export async function answerQuestion(question) {
  const q = String(question || '').trim().slice(0, 300)
  if (!q) throw new Error('ask something')
  const { engine, model } = getSettings()
  const prompt = ASK_PROMPT(JSON.stringify(agentView()), q)
  let raw
  if (engine === 'codex') {
    const out = await runCodex(prompt, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
    raw = String(out?.stdout || '')
  } else {
    const { stdout } = await execFileAsync(
      ENGINES.claude.bin,
      ['-p', prompt, '--model', model || DEFAULT_MODEL],
      { timeout: 120000, maxBuffer: 2 * 1024 * 1024, cwd: ROOT }
    )
    raw = stdout
  }
  const answer = raw.trim()
  if (!answer) throw new Error('nothing came back')
  return answer.slice(0, 600)
}

// ---------------------------------------------------- the surfacing sense
// Runs on its own clock, even when nothing was typed: what has quietly
// become relevant? Tomorrow's appointment rises tonight.

/** The surfacing sense: what has quietly become pressing. Like the
    question path, this hands over the page as context and takes back a
    small list — no one-shot MCP round trip to fail silently. */
const SURFACE_PROMPT = (page) => {
  const now = new Date()
  // Known debt: this cap can cut off a very large page. Do not widen the
  // storage or prompt shape in the event-log/entities slice.
  return `You watch a person's December page for things that have quietly become pressing. Today is ${now.toLocaleDateString('en-CA')} (${now.toLocaleString('en', { weekday: 'long' })}), local time ${now.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}.

Their page, as JSON:
${page.slice(0, 60000)}

Return AT MOST three things they should act on soon. What belongs here:
- a commitment to another person going stale (someone to call back, someone coming over, something owed)
- an undated thing that has quietly become time-sensitive
- a rhythm about to lapse (a streak, a monthly payment, a recurring thing they usually keep up)
- something dated 3 to 10 days out that needs doing BEFORE the day itself (book it, buy it, prepare it)

What does NOT belong: any reminder dated inside the next seven days (the page lists a full week of those itself), progress commentary, encouragement, and anything a card already states plainly. Prefer the concrete and actionable — "call the landlord back" over "review housing".

Reply with ONLY a JSON array, no prose and no code fence:
[{"label":"short action in their own words","reason":"a few words why now","space":"the space name it lives in","until":"YYYY-MM-DD"}]

An empty array [] is the normal answer on most days.`
}

let surfacing = false

const dateLike = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Find a balanced JSON array even when a CLI wraps it in prose or a fence,
    then reject malformed items before they can replace the live surface. */
export function parseSurfaceReply(raw) {
  raw = String(raw || '')
  for (let start = raw.indexOf('['); start >= 0; start = raw.indexOf('[', start + 1)) {
    let depth = 0
    let quoted = false
    let escaped = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') quoted = false
        continue
      }
      if (ch === '"') quoted = true
      else if (ch === '[') depth++
      else if (ch === ']' && --depth === 0) {
        let list
        try {
          list = JSON.parse(raw.slice(start, i + 1))
        } catch {
          break
        }
        if (!Array.isArray(list)) break
        const valid = list.every((item) =>
          item && !Array.isArray(item) && typeof item === 'object' &&
          typeof item.label === 'string' && !!item.label.trim() &&
          typeof item.space === 'string' && !!item.space.trim() &&
          (item.reason == null || typeof item.reason === 'string') &&
          (item.until == null || item.until === '' || (typeof item.until === 'string' && dateLike(item.until)))
        )
        if (valid) return list
        break
      }
    }
  }
  throw new Error('no valid surface list returned')
}

export async function runSurface() {
  if (surfacing || s.running) return
  surfacing = true
  try {
    const { engine, model } = getSettings()
    const prompt = SURFACE_PROMPT(JSON.stringify(agentView()))
    let raw
    if (engine === 'codex') {
      const out = await runCodex(prompt, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 })
      raw = String(out?.stdout || out || '')
    } else {
      const { stdout } = await execFileAsync(
        ENGINES.claude.bin,
        ['-p', prompt, '--model', model || DEFAULT_MODEL],
        { timeout: 120000, maxBuffer: 2 * 1024 * 1024, cwd: ROOT }
      )
      raw = stdout
    }
    const list = parseSurfaceReply(raw)
    if (process.env.DECEMBER_DEBUG) console.log('surface returned', list.length, JSON.stringify(list).slice(0, 200))
    await setSurfaced(list)
  } catch (err) {
    // quiet for the page, but never invisible to the log
    console.log('surface failed:', String(err.message || err).slice(0, 200))
  } finally {
    surfacing = false
  }
}

export function scheduleSurfacing() {
  setTimeout(runSurface, 15000) // shortly after boot
  setInterval(runSurface, 6 * 3600 * 1000) // and through the day
}
