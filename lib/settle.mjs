import { harnessMetrics } from './harness-metrics.mjs'
import {createAgentScheduler, createCaptureDebounce} from './agent-scheduler.mjs'
import {boundedRecords} from './agent-context.mjs'
import {randomUUID} from 'node:crypto'
// The settle pass — a subscription-powered agent connected to December's
// own MCP tool surface. This module owns the debounce and the state
// machine, and its status() is honest: failures cross the interface
// instead of leaving captures shimmering forever.
//
// Two engines (the gear picks): Claude runs as a persistent agent — one
// long-running process holds the MCP connection and standing instructions,
// each settle is just another streamed turn. Codex runs one-shot per pass.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { createAgentProcess } from './agent-process.mjs'
import { ROOT, hasInbox, setSurfaced, beginAgentRun, readJournal, setJournal, setJournalYear, setJournalLetter, journalMaterial } from './core.mjs'
import { getSettings, ENGINES } from './settings.mjs'
import * as core from './core.mjs'

let settledObserver = () => {}
let statusSequence=0
const changed=()=>{statusSequence++;settledObserver()}
export function observeSettled(observer) { settledObserver = observer }
// Inert compatibility for the existing Settings presentation. No credentials,
// provider modules, environment variables, or network requests are consulted.
export const jevStatus=()=>({mode:'off',provider:'live',ready:false,outcome:'off',last:null,metrics:{}})
export const organizerToken=randomUUID()
const scheduler=createAgentScheduler({onChange:changed,onTiming:(kind,ms)=>harnessMetrics.record(`queue:${kind}`,ms)})
const fixture=()=>process.env.DECEMBER_AGENT_FIXTURE==='1'

const execFileAsync = promisify(execFile)
// Port-suffixed so a second instance (another port, same checkout) can't
// repoint the running instance's settle agent at itself.
const MCP_CONFIG_PATH = join(ROOT, `mcp.${Number(process.env.PORT || 3008)}.json`)
const READ_CONFIG_PATH = join(ROOT, `mcp.read.${Number(process.env.PORT || 3008)}.json`)
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
  sequence:statusSequence,
  jobs:scheduler.status(),
  lastError: s.lastError,
  lastRunAt: s.lastRunAt,
  jev: jevStatus(),
  timings: harnessMetrics.snapshot(),
})

/** Written once at boot; the settle agent connects like any external client. */
export async function writeMcpConfig() {
  for(const [path,access] of [[MCP_CONFIG_PATH,'organizer'],[READ_CONFIG_PATH,'read']]) {
    await writeFile(path,JSON.stringify({mcpServers:{december:{command:'node',args:[join(ROOT,'mcp-server.mjs')],env:{DECEMBER_URL:baseUrl(),DECEMBER_ACCESS:access,DECEMBER_ORGANIZER_TOKEN:access==='organizer'?organizerToken:''}}}},null,2))
  }
}

/** The standing instructions. Exported so the suite can hold the rules that
    must not drift (retrieval only on an explicit ask, never invent) to account. */
export const PROMPT = () => `You are the organizing engine of December: a personal page where a person writes raw text and it organizes itself. Today is ${new Date().toLocaleDateString('en-CA')} and the local time is ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}. These are your STANDING INSTRUCTIONS for this session.

Use your december_* tools only to organize and update the page. Use the selected local agent's native capabilities under the person's configured permissions when a capture calls for retrieval or points at an attached file. Be fast: batch independent reads and changes to different blocks together. Changes to the same block must stay ordered. Await durable mutation results before filing their capture; never file in parallel with its writes. Finish in as few turns as possible.

PASS SCOPE: complete only the capture IDs in the current batch envelope, not a page-wide housekeeping review. After december_view, make only the changes required by those captures and any necessary clarification. Reuse the returned IDs; read a block only when the condensed view omits information needed for this capture. Do not re-read the whole page after every successful write; re-read on a conflict, uncertain result, or a new dependency. When required writes and filing are complete, stop.

Each pass: call december_view. It shows About Me, a paged compact space/block catalog with versions, the assigned inbox captures, and the lessons (obey lessons always). Explicit names and capture hints rank first. Use december_query to find named subjects or content beyond the catalog. Follow coverage.nextOffset until you have located the relevant destination; december_read_space expands omitted block catalogs. Read candidate blocks with december_read_block before editing. Pass the returned version as expectedVersion on every existing-block mutation. Goal changes must name the exact blockId; moving a goal also requires expectedTargetVersion from reading its destination. A VERSION_CONFLICT means reread that target, preserve applied receipts, and replan only the remaining work. Never infer that content is absent from a catalog summary. Results with coverage.complete false are incomplete. Read About Me first. Long content is condensed with markers (moreEntries, moreDone, textTruncated); when a capture depends on something elided, call december_read_block for the full block. Then organize ONLY the inbox captures:
- Standing facts about the person — family, likes, birthdays, schools, addresses, who they are — go in About Me via december_write_about (append). Do not turn those into list items. Lessons stay lessons: they are how to file, not who they are. Use append; never overwrite the whole profile unless they asked to replace it. Never invent.
- Actions go on a list or reminder. Standing facts, addresses, people, and likes go in a note or About Me.
- Everything you create must come from the captures. Prefer existing spaces and blocks; create only for clearly new territory. Space names are short, human, from the person's own words. One capture may touch several blocks.
- A SPACE IS A SUBJECT, NOT A TASK. A space is somewhere a person will put more things later — an apartment, a course, a trip, a person. A single dated thing is not a subject: "test at 3:30", "call the bank tomorrow", "haircut friday" are rows, and a card named "Test" holding one row named "Test" says nothing twice. Never create a space whose name merely restates its only block. File such a capture on the space it actually belongs to (the bank call under Money, the haircut wherever errands already live); when nothing existing fits, put it in a plain "Reminders" space and let it sit there with the others. Create the subject's own space later, when the person gives it a second thing.
- Extract numbers. A tracker is for something counted toward a target the person actually named; when there is no target, a ledger or a list says it better than a bar stuck at zero. Count in the unit they used, and set period 'year' only for a total that builds steadily across the year. Reminders that imply a date get when (YYYY-MM-DD); ones that name a clock time ("9am", "at 3:30", "dentist tuesday morning" is NOT a time) also get at (HH:MM, 24h); ones that recur ("every month") also get repeat (daily|weekly|monthly|yearly). A capture's hint names the space the person was viewing: strongly prefer it.
- A follow-up inside a space can EDIT an existing task. Resolve pronouns and corrections against its existing blocks before adding anything. For an existing reminder, update its blockId with december_set_reminder. When an existing list item gains a date, use december_set_reminder with its list blockId and exact itemId, when, and optional revised text; this moves the same task with its history, rather than leaving two checkboxes. For wording alone use december_rename. Never mark a superseded task done: a correction is not completion. If multiple tasks fit, ask which one and keep the clarification as a note without inventing another action. A one-off date or wording correction is not a standing preference to learn.
- If a capture asks for something ("a progress bar for X"), build exactly that. If it corrects you, update the referenced content; use december_learn only for an enduring organizing preference.
- Never invent content, never delete. Scheduling an existing list item with set_reminder is a history-preserving move, not deletion. Block titles only when they add information; never restate the space name; no em dashes.
- A compound sentence files as the actions it contains, each one complete and self-contained. Connective and filler clauses ("let's get that done", "and then also") are never items — fold them into the action they refer to.
- A ROW IS A NAME, NOT A SENTENCE. A reminder's or list item's text is the thing itself in a few words ("Exam 1", "Book the Testing Center", "Renew the registration"); its date goes in when, its place in entities, and any instruction, condition or consequence the person wrote around it ("two weeks ahead or it's a zero", "recheck the bill first") goes in a note on the same space, once, in their words. Never file a whole sentence as a row's text when a name and a note say it better. Never begin a row with the space's own name — under SPM 4014 the row is "Quiz due", not "SPM 4014 quiz due".
- ONE THING LIVES IN ONE PLACE. When a capture belongs to a course, a project or a person that has its own space, it files there and only there; a parent or umbrella space (the school, the company, the family) never gets a copy. If the person asks for per-class or per-project spaces, MOVE what belongs to each (set_reminder with the existing blockId, rename, or recreate and finish the old) rather than copying, and say so in the summary. A duplicate on two cards is a mistake, not thoroughness.
- A capture beginning "[attached file: <path>]" is a document the person dropped onto the page: use the selected local agent's native file, PDF, image, or document access to read it, then organize its contents as the person's own words; the filing summary names the document.
- LOOKING SOMETHING UP happens only when a capture explicitly asks for it: "look up", "pull", "get the latest", "find out when", "what's the schedule for", "track" a public fact. Then, for that capture only, use the selected local agent's native retrieval capabilities under the person's configured permissions. File only what the retrieved source actually supports with the ordinary verbs, naming the source in the block or the filing summary. Milk stays milk: an ordinary capture is never looked up, and you never look something up to decorate a capture that did not ask. Never invent a date, a time, a score, a price, or a name the source does not state. When retrieval is unavailable or fails, or the source does not say, file a look-up task instead (a reminder when they named a day, otherwise a list item) naming what to check and where, and say so in the filing summary.
- WATCHING is that same ask, standing: "keep track of", "keep an eye on", "check every week" a public fact. File the capture the ordinary way, then set watch true on the block that holds it (a field on december_create_block and on every block verb) — that block's own text becomes the query, so it must read like the thing to look up. December then re-reads it on its own clock and drops what the source said into the inbox as a capture beginning "[watch: ...]": those are the source's own words and its url, so update the block that capture names with the ordinary verbs, name the url in the block or the filing summary, and add NOTHING the excerpt does not state. When the excerpt does not say, or the capture reports that the refreshes failed, file a look-up task instead. Set watch false the moment they say to stop, and never tag a block the person did not ask to keep current.
- Each block type has its own small verb: add_or_check (list), move_tracker, log_amount (ledger), mark_day (streak), write_note, set_reminder. Pass the capture's id as source on every create and verb call. The view includes appliedOperations for interrupted captures: keep those results and do only the remaining work. Reuse the same operationId when retrying an action; give distinct IDs to separate identical actions within one capture. Without a capture source, additions require a stable operationId.
- When a capture names people, organizations, places, or distinct things, set entities with normalized names: short, human, and in the person's own words. A reminder's place is its place entity. Never invent entities the words do not name.
- File EVERY capture exactly once (december_file_capture: best space + plain-words summary). Nothing stays unfiled. When something lands more than a week out, the summary names its month plainly ("dinner with Ana, filed to October") — the person finds it later by flipping the year to that month.
- Give a newly created space, or a space this capture touches whose area is empty, an area with december_set_area (Money, Health, Work, Home, Learning, People...). Keep an existing area unless the capture asks to change it. Do not repair unrelated spaces. Reuse existing area names; keep the set small.
- Whenever you had to GUESS at a detail to file something, ask about it: december_ask ONE short question naming the thing ("what time is lunch with your sister on Friday?", "how much was the deposit?"). Give NO options when the answer is a time or an amount — they type it. When the answer is a DAY, offer the 2-3 likeliest days as options, each a plain day the person can tap ("this Thursday, Sep 24", "next Thursday, Oct 1"); they can still type another. Otherwise give 2-4 standalone-statement options only when the answer is a choice between things you can name ("Groceries go under Food"). One question per pass at most, never about something the capture already answered, and never a yes/no. File your best guess regardless — the question refines what you filed, it never blocks it.
- Suggestions are optional: call december_suggest only when this capture supplies an obvious useful follow-up, or makes an existing suggestion stale. If neither applies, leave suggestions unchanged and skip the tool. Do not call it just to repeat or clear an already empty list.
- Surfacing is maintained separately through the day. During a capture pass, call december_surface only if this capture creates a concrete urgent follow-up or makes an existing surfaced item done or no longer true; otherwise skip it. The view's surfaced list is what is on the page right now: SEND BACK every one of those that still stands, or it disappears. Add to it, up to three total, things that need doing SOON but that the page does not already show: someone to call back, someone coming over, a commitment going stale, a rhythm about to lapse, something dated a few days out that needs preparing first. Never surface a dated reminder that falls inside the next seven days: the page now lists a whole week of them itself, so repeating one says it twice. The PREPARATION for such a thing is still worth surfacing, because that is a different job with no date on it ("get quotes from three movers" while "moving day" sits on the 17th). Never surface something you are already asking about with december_ask — the question is on the page already, and saying it twice reads as a glitch. Drop one only when it is done or no longer true. Pass an empty list only when nothing at all qualifies; surfacing something irrelevant is worse than surfacing nothing. These are things to ACT on — never put them in december_suggest instead.
- GOALS are counts, tasks are finish lines. A goal is a total the person accumulates toward (200 miles, 24 books, $10k); "my goal is to launch the site", "goal for today: clean the garage" name finish lines crossed once — those are tasks (a reminder or list item, dated if they said when), NEVER a 1-of-1 tracker or a goal. Goal-flavoured words do not make something a goal; a number they are counting toward does. When the person names a total they want to reach ("my goal this year is 200 miles", "read 24 books by December", "$10k saved by October"), that is a goal, and it MUST be marked as one: create the tracker with goal: true (and by, if they named a nearer date), or call december_set_goal on the block that already counts it (a tracker, ledger, streak, or list). A bare tracker is not a goal. The view lists goals first, each with where it stands and quietDays since it last moved. Progress in a goal's unit or space goes into THAT goal's block with the block's own verb; never create a second block for what a goal already counts. When they say a goal no longer matters ("drop the running goal", "stop tracking that", "that's not a goal anymore"), lift it with december_set_goal target 0 — the block and its history stay; never archive the space for this unless they say so. When the person starts counting a goal in a new shape (logging individual runs against a mileage tracker), create the right block and december_move_goal onto it — where it stands never changes. A goal quiet for weeks is worth a gentle december_surface line, not a question.
- When the person says something matters most, december_pin it; when they say something is done, december_finish it; when they ask for different wording, december_rename it. Never pin or finish as tidying.

Keep text output to one short line.`

const RESUME_PROMPT = () =>
  `New captures are in the inbox (today is ${new Date().toLocaleDateString('en-CA')}, local time ${new Date().toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false })}). Run one pass per your standing instructions, then stop.`

// The persistent agent: one long-running Claude process holds the MCP
// connection and the standing instructions; each settle is just another
// turn fed over stream-json. No per-settle boot, no re-reading the rules.
// Rotates every 20 turns so the transcript stays bounded.

// December organization tools are pre-approved so a headless settle never
// waits on an interactive MCP permission prompt. Claude's --allowedTools is
// additive to its supported user configuration: native retrieval and document
// capabilities remain governed by the person's own settings and permissions.
// Exported so the suite can hold December's contributed surface to organization.
export const ALLOWED = [
  'view', 'read_block', 'read_space', 'query', 'create_space', 'create_block', 'file_capture', 'learn',
  'add_or_check', 'move_tracker', 'log_amount', 'mark_day', 'write_note', 'set_reminder',
  'retitle', 'rename', 'suggest', 'ask', 'set_area', 'pin', 'finish', 'surface', 'write_about', 'set_goal', 'move_goal',
]
  .map((t) => `mcp__december__december_${t}`)
  .join(',')

const processRunner=createAgentProcess({
  binary:()=>ENGINES.claude.bin,cwd:ROOT,
  args:model=>[...(ENGINES.claude.prefixArgs||[]),'-p','--input-format','stream-json','--output-format','stream-json','--verbose',
    '--model',model,'--mcp-config',MCP_CONFIG_PATH,'--allowedTools',ALLOWED],
})
const agent=processRunner.state
const ensureAgent=processRunner.ensure
const killAgent=processRunner.stop
const turn=processRunner.turn

// ---------------------------------------------------- one-shot codex runs

/** Codex has no persistent stream mode here; each pass is one codex exec
    against the same MCP surface. Model empty = the CLI's own default. */
function feedStdin(child, prompt) {
  // A CLI may reject its arguments and close before the write reaches it.
  // The exec result remains the authoritative success or failure signal.
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
}

/** Run either supported one-shot CLI. Page content always travels over stdin:
    command lines are observable by other local processes and are sharply
    bounded on Windows. Exported so disposable CLI fixtures can verify the
    process boundary without touching a real engine configuration. */
export function runEnginePrompt(
  engine,
  prompt,
  { timeout, maxBuffer, signal, readOnly=false, env = process.env, binary = ENGINES[engine]?.bin, prefixArgs = [] } = {}
) {
  const { model } = getSettings()
  let args
  if (engine === 'codex') {
    // forward slashes: backslash paths trip codex's TOML value parsing
    const mcpArgs = JSON.stringify(join(ROOT, 'mcp-server.mjs').replaceAll('\\', '/'))
    args = [
      'exec',
      '-',
      '--skip-git-repo-check',
      '-c', 'mcp_servers.december.command="node"',
      '-c', `mcp_servers.december.args=[${mcpArgs}]`,
      '-c', `mcp_servers.december.env={DECEMBER_URL="${baseUrl()}",DECEMBER_ACCESS="${readOnly?'read':'organizer'}",DECEMBER_ORGANIZER_TOKEN="${readOnly?'':organizerToken}"}`,
    ]
    if (model) args.push('--model', model)
  } else if (engine === 'claude') {
    args = ['-p', '--model', model || DEFAULT_MODEL]
    if(readOnly)args.push('--mcp-config',READ_CONFIG_PATH,'--allowedTools',['view','read_block','read_space','query'].map(t=>`mcp__december__december_${t}`).join(','))
  } else {
    throw new Error(`unknown engine: ${engine}`)
  }
  const p = execFileAsync(binary, [...prefixArgs, ...args], { timeout, maxBuffer, signal, cwd: ROOT, env })
  feedStdin(p.child, prompt)
  return p
}

let idleTimer=null,stopped=false
async function run(signal) {
  if(stopped || fixture() || !hasInbox())return
  const batch=core.beginOrganizerBatch()
  const endPass=harnessMetrics.start('pass')
  s.running=true;s.pending=false;s.lastError=null
  beginAgentRun();changed();clearTimeout(idleTimer)
  signal.addEventListener('abort',killAgent,{once:true})
  const {engine,model}=getSettings()
  const envelope=`\nAssigned capture IDs for this pass: ${JSON.stringify(batch)}. Do not process captures outside this batch.`
  try {
    await harnessMetrics.measure(`organizer:${engine}`,async()=>{
      if(engine==='codex')await runEnginePrompt(engine,PROMPT()+'\nRun the pass now.'+envelope,{timeout:240000,maxBuffer:4*1024*1024,signal})
      else {
        ensureAgent(model||DEFAULT_MODEL)
        const first=agent.turns++===0
        await turn((first?PROMPT()+'\nRun the first pass now.':RESUME_PROMPT())+envelope,240000)
        if(agent.turns>=20)killAgent()
      }
    })
    if(core.pendingCaptureIds().some(id=>batch.includes(id)))s.lastError='some captures were left unfiled'
  } catch(err) {
    killAgent()
    s.lastError=String(err.stderr||err.message||err).slice(-300)
  } finally {
    signal.removeEventListener('abort',killAgent)
    core.endOrganizerBatch()
    await core.compactOperations().catch(error=>console.log('receipt compaction deferred:',error.message))
    endPass(!!s.lastError);s.lastRunAt=new Date().toISOString();s.running=false
    // Failed captures stay durable for an explicit retry, without a hot loop.
    s.pending=hasInbox();changed()
    if(s.pending && !s.lastError)setTimeout(()=>schedule(0),0)
    idleTimer=setTimeout(killAgent,5*60*1000);idleTimer.unref?.()
  }
}
const debounce=createCaptureDebounce(()=>{
  void scheduler.enqueue('organize',run).catch(error=>{s.lastError=error.message;changed()})
})
export function schedule(delay) {
  if(stopped || fixture())return
  s.pending=hasInbox();changed()
  debounce.schedule(delay)
}

// ------------------------------------------------------ asking the page
// The search field routes a question here instead of filing it. This
// existed on the page — the field, the thinking state, the answer slot —
// and called a function that was never written, so every question came
// back "settle.answerQuestion is not a function".

const ASK_PROMPT = (page, question) => `You answer questions about one person's December page: the place they write things down so they do not have to hold them in their head. Today is ${new Date().toLocaleDateString('en-CA')}.

Their page, as JSON:
${page}

Their question: ${question}

Answer from the page and nothing else. One or two short sentences, plain words, no preamble and no markdown. Give the number when they asked for a number, and say where it came from ("$1,240 on the car, across 4 entries since March"). If the page does not say, tell them that plainly rather than guessing. Never invent an entry, a total, or a date.`

/** Ask the page a question and get a sentence back, not a filed note. */
const answerCache=new Map()
export async function answerQuestion(question,{signal}={}) {
  const q=String(question||'').trim().slice(0,300)
  if(!q)throw new Error('ask something')
  const fact=core.answerPageFact(q)
  if(fact)return fact.answer
  if(fixture())throw new Error('Synthetic preview: engine calls are disabled')
  const cacheKey=JSON.stringify([core.stateRevision(),Math.floor(Date.now()/60000),getSettings(),q])
  if(answerCache.has(cacheKey))return answerCache.get(cacheKey)
  return scheduler.enqueue(`question:${randomUUID()}`,async jobSignal=>{
    const revision=core.stateRevision()
    const prompt=ASK_PROMPT(JSON.stringify(core.queryPageContext(q)),q)+'\nUse december_query with nextOffset for more matching records when coverage is incomplete. This December MCP connection is read-only.'
    const out=await runEnginePrompt(getSettings().engine,prompt,{timeout:120000,maxBuffer:2*1024*1024,signal:jobSignal,readOnly:true})
    if(jobSignal.aborted)throw new Error('question cancelled')
    if(core.stateRevision()!==revision)throw new Error('The page changed while answering. Ask again for the current answer.')
    const answer=String(out?.stdout||'').trim()
    if(!answer)throw new Error('nothing came back')
    const text=answer.slice(0,600)
    answerCache.set(cacheKey,text)
    if(answerCache.size>64)answerCache.delete(answerCache.keys().next().value)
    return text
  },{signal})
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
${page}

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
  if(fixture())return
  return scheduler.enqueue('surface',async signal=>{
    const fingerprint=core.stateFingerprint()
    const prompt=SURFACE_PROMPT(JSON.stringify(core.queryPageContext('')))+'\nUse december_query to read more records when coverage is incomplete.'
    const out=await runEnginePrompt(getSettings().engine,prompt,{timeout:120000,maxBuffer:2*1024*1024,signal,readOnly:true})
    if(signal.aborted)return
    if(core.stateFingerprint()!==fingerprint){surfaceRetry=setTimeout(runSurface,1000);return}
    await setSurfaced(parseSurfaceReply(String(out?.stdout||'')))
  },{background:true}).catch(err=>{if(err.name!=='AbortError')console.log('surface failed:',String(err.message).slice(0,200))})
}

// ------------------------------------------------------------ the journal
// One paragraph per month, in the person's own words, from what the month
// held. Written once, kept with the month's fingerprint, rewritten only
// when the month has moved on. Never a chat, never about the page.

const JOURNAL_PROMPT = (month, captures, about) => `You write one short paragraph about a month of a person's year, for their own private journal. Use ONLY the facts below. Write in the second person ("you"), plainly, in the words the person used themselves where they gave any. Past tense for a month that is over; present tense for the month that is underway. Never mention December, the page, an app, an assistant, or yourself. No encouragement, no advice, no lists, no headings. At most 70 words. If the month held almost nothing, say so in one sentence.

About the person (may be empty):
${String(about || '').slice(0, 1500)}

The month, as JSON:
${JSON.stringify(month)}

What they wrote down during the month, in their own words:
${JSON.stringify(boundedRecords(captures,{maxBytes:12000}))}

Reply with ONLY a JSON object, no prose and no code fence:
{"text":"the paragraph"}`

const YEAR_PROMPT = (months, about) => `You write ONE sentence, at most 40 words, that says what a person's year has been so far, for their own private journal. Use ONLY the month notes below, in the second person, plainly. Never mention December, the page, an app, an assistant, or yourself. No encouragement.

About the person (may be empty):
${String(about || '').slice(0, 1200)}

The months so far, as JSON:
${JSON.stringify(boundedRecords(months,{maxBytes:16000}))}

Reply with ONLY a JSON object, no prose and no code fence:
{"text":"the sentence"}`

const LETTER_PROMPT = (months, line, about) => `You write a short letter, at most 180 words, that a person's year writes back to them on its last day, for their own private journal. Use ONLY the month notes below. Second person, plain, warm but unsentimental, in the words they used themselves where they gave any: what they recorded, what they finished, what they let go. Never mention December, the page, an app, an assistant, or yourself. No advice for next year, no lists, no headings, no sign-off.

About the person (may be empty):
${String(about || '').slice(0, 1200)}

The year in one line: ${String(line || '')}

The months, as JSON:
${JSON.stringify(boundedRecords(months,{maxBytes:20000}))}

Reply with ONLY a JSON object, no prose and no code fence:
{"text":"the letter"}`

/** The first balanced {"text": ...} object in a reply, whatever wraps it. */
export function parseJournalReply(raw) {
  raw = String(raw || '')
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') quoted = false
        continue
      }
      if (ch === '"') quoted = true
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1))
          if (obj && typeof obj.text === 'string' && obj.text.trim()) return obj.text.trim()
        } catch {}
        break
      }
    }
  }
  throw new Error('no paragraph returned')
}


const journalTried = new Map() // month -> when we last asked; one ask an hour

/** Write what is missing or stale: past months first, the current month,
    then the year line. One run at a time, one month per run, so a page
    with a long year never blocks its own settling. */
export async function runJournal() {
  if(fixture())return
  return scheduler.enqueue('journal',async signal=>{
  const revision=core.stateRevision()
  let triedKey=null
  const fresh=()=>{
    if(signal.aborted || core.stateRevision()!==revision){
      if(triedKey)journalTried.delete(triedKey)
      if(!signal.aborted)scheduleJournal(1000)
      return false
    }
    return true
  }
  try {
    const { engine } = getSettings()
    const j = readJournal()
    const due = j.months.filter((m) => (m.past || m.current) && (m.recorded || m.overdue || m.ahead) && (!m.text || m.stale))
    const now = Date.now()
    const next = due.find((m) => (journalTried.get(m.month) || 0) < now - 3600000)
    if (next) {
      triedKey=next.month;journalTried.set(triedKey,now)
      const { captures, about } = journalMaterial(next.month)
      const facts = { ...next }
      for (const k of ['text', 'at', 'stale', 'key']) delete facts[k]
      const out = await runEnginePrompt(engine, JOURNAL_PROMPT(facts, captures, about), { timeout: 120000, maxBuffer: 2 * 1024 * 1024, signal, readOnly:true })
      if(!fresh())return
      journalTried.set(next.month,now)
      await setJournal(next.month, parseJournalReply(String(out?.stdout || '')), next.key)
      return
    }
    // the letter, on the year's last days, once
    const today = new Date()
    if (today.getMonth() === 11 && today.getDate() >= 28 && !j.letter && j.months.some((m) => m.text) && (journalTried.get('letter') || 0) < now - 3600000) {

      triedKey='letter';journalTried.set(triedKey,now)
      const told = j.months.filter((m) => m.text).map((m) => ({ month: m.month, text: m.text }))
      const out = await runEnginePrompt(engine, LETTER_PROMPT(told, j.line?.text, journalMaterial(told[0].month).about), { timeout: 120000, maxBuffer: 1024 * 1024, signal, readOnly:true })
      if(!fresh())return
      journalTried.set('letter',now)
      await setJournalLetter(parseJournalReply(String(out?.stdout || '')))
      return
    }
    // the year line, once the months have their words
    const told = j.months.filter((m) => m.text)
    const yearKey = told.map((m) => m.month + m.key).join()
    if (told.length && (!j.line || j.line.key !== yearKey) && (journalTried.get('year') || 0) < now - 3600000) {

      triedKey='year';journalTried.set(triedKey,now)
      const out = await runEnginePrompt(engine, YEAR_PROMPT(told.map((m) => ({ month: m.month, text: m.text })), journalMaterial(told[0].month).about), { timeout: 90000, maxBuffer: 1024 * 1024, signal, readOnly:true })
      if(!fresh())return
      journalTried.set('year',now)
      await setJournalYear(parseJournalReply(String(out?.stdout || '')), yearKey)
    }
  } catch (err) {
    if(signal.aborted && triedKey)journalTried.delete(triedKey)
    if(!signal.aborted)console.log('journal failed:', String(err.message || err).slice(0, 200))
  }
  },{background:true}).catch(error=>{if(!stopped)console.log('journal deferred:',error.message)})
}

/** Anything left to write for this year? The page asks when the year opens. */
export function journalPending() {
  const j = readJournal()
  const today = new Date()
  const told = j.months.filter((m) => m.text)
  const letterDue = today.getMonth() === 11 && today.getDate() >= 28 && !j.letter && told.length > 0
  const lineDue = told.length > 0 && (!j.line || j.line.key !== told.map((m) => m.month + m.key).join())
  return letterDue || lineDue || j.months.some((m) => (m.past || m.current) && (m.recorded || m.overdue || m.ahead) && (!m.text || m.stale))
}

export function scheduleJournal(delay = 300) {
  clearTimeout(scheduleJournal._t)
  scheduleJournal._t = setTimeout(runJournal, delay)
}

let surfaceFirst,surfaceInterval,surfaceRetry
export function scheduleSurfacing() {
  surfaceFirst=setTimeout(runSurface, 15000) // shortly after boot
  surfaceInterval=setInterval(runSurface, 6 * 3600 * 1000) // and through the day
}

export function stop() {
  stopped=true
  debounce.cancel();scheduler.close();killAgent()
  clearTimeout(idleTimer);clearTimeout(scheduleJournal._t)
  clearTimeout(surfaceFirst);clearInterval(surfaceInterval);clearTimeout(surfaceRetry)
}
