import { captureAction, commitCaptureAction } from './capture-action.mjs'
import { createJevProvider } from './jev-provider.mjs'
// Optional bounded fast path. The ordinary organizer remains the fallback.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseChecklist, checklistRequest, checklistGate } from './jev-checklist.mjs'
import { MODEL, requestFor, gate, parseAppend, callJev } from './jev-router.mjs'

export function jevConfig(env = process.env) {
  const mode = ['shadow', 'fast'].includes(env.DECEMBER_JEV_MODE) ? env.DECEMBER_JEV_MODE : 'off'
  const fixture = env.DECEMBER_JEV_FIXTURE === '1' && !!env.DECEMBER_DATA_DIR &&
    existsSync(join(env.DECEMBER_DATA_DIR, '.jev-synthetic-preview'))
  let key = String(env.TYPESAFE_API_KEY || '').trim()
  if (!key && env.TYPESAFE_API_KEY_FILE) {
    try { key = readFileSync(env.TYPESAFE_API_KEY_FILE, 'utf8').trim() } catch {}
  }
  return { mode, fixture, key, ready: fixture || !!key }
}

export function candidateLists(view, readBlock, selectedId) {
  return view.spaces.flatMap(space => space.blocks.filter(b => b.type === 'list').map(block => ({
    id: block.id, name: block.title || space.name, spaceId: space.id,
    items: (readBlock && (!selectedId || block.id === selectedId) ? readBlock(block.id).block.items : block.items).map(i => i.text),
  })))
}

// Include closed and retired subjects: a fast creation must not reopen or
// duplicate something the person put away. Only names leave this path.
export function checklistNames(core, view) {
  const full = core.project ? core.project() : view
  return [...new Set([...(full.spaces || []), ...(full.retired || [])].flatMap(space =>
    [space.name, ...(space.blocks || []).map(block => block.title)]).filter(Boolean))]
}

function parseFast(text, lists, names) {
  return parseAppend(text, lists) || parseChecklist(text, names)
}

export function fastCaptureDelay(view, config, names = checklistNames({}, view)) {
  if (config.mode !== 'fast' || !config.ready || view.ask || view.lessons.length) return 700
  const lists = candidateLists(view)
  return view.captures.length > 0 && view.captures.length <= 8 && lists.length <= 20 && names.length <= 80 &&
    view.captures.every(c => !c.hint && !c.appliedOperations?.length && parseFast(c.text, lists, names)) ? 0 : 700
}

// A simulated provider for the isolated review page; never described as live Jev.
export async function fixtureDecision(request) {
  if (request.state.proposed?.action === 'create' || request.state.proposed?.name) {
    const accepted = request.state.capture === 'Make a Garden checklist: water herbs, repot basil, buy compost'
    return { data: { model: MODEL, answers: { action: {
      type: 'choice', choice: accepted ? 'create' : 'defer', confidence: .99,
      probabilities: { create: accepted ? 1 : 0, defer: accepted ? 0 : 1 },
    } } }, latencyMs: 0 }
  }
  const examples = new Map([
    ['Add oat milk to Groceries', 'Groceries'],
    ['Add a charging cable to Packing', 'Packing'],
    ['Add Piranesi to Books', 'Books'],
  ])
  const name = examples.get(request.state.capture)
  const target = request.state.lists.find(l => l.name === name)?.id || 'none'
  const choice = (value, ids) => ({ type: 'choice', choice: value, confidence: 0.99,
    probabilities: Object.fromEntries(ids.map(id => [id, id === value ? 1 : 0])) })
  return { data: { model: MODEL, answers: {
    action: choice(target === 'none' ? 'defer' : 'append', ['append', 'defer']),
    target: choice(target, [...request.state.lists.map(l => l.id), 'none']),
  } }, latencyMs: 0 }
}

const liveProvider = createJevProvider(callJev)

export async function tryJevCapture({ core, callTool, config, request = liveProvider }) {
  const base = { mode: config.mode, provider: config.fixture ? 'simulation' : 'live', model: MODEL }
  if (config.mode === 'off') return { ...base, outcome: 'off' }
  if (!config.ready) return { ...base, outcome: 'unconfigured' }
  const view = core.agentView()
  let lists = candidateLists(view)
  const names = checklistNames(core, view)
  // Let a new eligible example run even when the synthetic inbox holds an
  // earlier fallback. Real mode leaves ordering to the ordinary organizer.
  const capture = config.fixture ? view.captures.find(c =>
    !c.appliedOperations?.length && !core.agentOperationStatus?.(c.id, 'jev-append-v1') && !core.agentOperationStatus?.(c.id, 'jev-create-v1') && parseFast(c.text, lists, names)) || view.captures[0] : view.captures[0]
  if (!capture) return { ...base, outcome: 'idle' }
  // Existing lessons/questions and partial operations need the full organizer.
  if (view.lessons.length || view.ask || capture.hint || capture.appliedOperations?.length ||
    core.agentOperationStatus?.(capture.id, 'jev-append-v1') || core.agentOperationStatus?.(capture.id, 'jev-create-v1')) {
    return { ...base, outcome: 'fallback', reason: 'context-needs-organizer' }
  }
  let proposed = parseFast(capture.text, lists, names)
  if (proposed?.action === 'append') {
    lists = candidateLists(view, core.readBlock, proposed.target)
    proposed = parseFast(capture.text, lists, names)
  }
  if (lists.length > 20 || names.length > 80 || !proposed) {
    return { ...base, outcome: 'fallback', reason: 'outside-fast-path' }
  }
  // Resolve names locally; unrelated lists never enter the provider request.
  const relevantLists = proposed.action === 'append' ? lists.filter(l => l.id === proposed.target) : lists
  const revision = core.stateRevision()
  const started = performance.now()
  let answer
  try {
    answer = await (config.fixture ? fixtureDecision : request)(proposed.action === 'create' ? checklistRequest(capture.text, names, proposed) : requestFor(capture.text, relevantLists), {
      apiKey: config.key, timeoutMs: 1200,
    })
  } catch {
    return { ...base, outcome: 'fallback', reason: 'provider-unavailable', durationMs: Math.round(performance.now() - started) }
  }
  const timing = { durationMs: Math.round(performance.now() - started),
    requestMs: Math.round(answer.latencyMs), evaluationMs: answer.data?.evaluation_time_ms ?? null }
  if (answer?.data?.model !== MODEL) return { ...base, ...timing, outcome: 'fallback', reason: 'unexpected-model' }
  const decision = proposed.action === 'create' ? checklistGate(capture.text, names, answer.data) : gate(capture.text, relevantLists, answer.data)
  if (decision.action === 'defer') return { ...base, ...timing, outcome: 'fallback', reason: decision.reason }
  if (config.mode === 'shadow') return { ...base, ...timing, outcome: decision.action === 'create' ? 'would-create' : 'would-append' }
  // No await between freshness checks and entering the ordinary mutation API.
  if (core.stateRevision() !== revision) return { ...base, ...timing, outcome: 'fallback', reason: 'page-changed' }
  const current = core.agentView()
  const pending = current.captures.find(c => c.id === capture.id && c.text === capture.text)
  const currentLists = candidateLists(current, decision.action === 'append' ? core.readBlock : undefined, decision.target)
  const currentDecision = pending && parseFast(pending.text, currentLists, checklistNames(core, current))
  if (!currentDecision || JSON.stringify(currentDecision) !== JSON.stringify(decision)) {
    return { ...base, ...timing, outcome: 'fallback', reason: 'page-changed' }
  }
  // Creating a block also creates its named space in the same mutation.
  // Both routes keep the ordinary receipts and scoped undo. A failure after
  // the first save leaves a receipt for the full organizer to recover.
  const savingStarted = performance.now()
  const action = captureAction(decision, currentLists, capture.id)
  const {operationId} = await commitCaptureAction(action, callTool)
  return { ...base, ...timing, outcome: decision.action === 'create' ? 'created' : 'appended', captureId: capture.id, operationId,
    saveMs: Math.round(performance.now() - savingStarted),
    itemCount: decision.items?.length || (decision.item ? 1 : 0),
    captureToSavedMs: Number.isFinite(Date.parse(capture.at)) ? Date.now() - Date.parse(capture.at) : null,
    durationMs: Math.round(performance.now() - started) }
}
