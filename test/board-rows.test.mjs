// Board cards through the real renderer: a board row says its state and its
// proof; the person's page renders exactly as it did.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const rows = [
  { id: 'a', text: 'Read the git root', done: true, state: 'done', proof: { tests: '8 pass', commit: 'd548be9', ok: true } },
  { id: 'b', text: 'Mirror the todo list', done: true, state: 'done', proof: { tests: '5 pass', ok: false } },
  { id: 'c', text: 'Hand back the URL', done: false, state: 'doing' },
  { id: 'd', text: 'Poll the todo file', done: false, state: 'cancelled', reason: 'replaced by the hook' },
  { id: 'e', text: "Mirror Codex's plan", done: false, state: 'blocked', reason: 'Codex hooks unconfirmed' },
  { id: 'f', text: 'Push the branch', done: false, state: 'waiting' },
  { id: 'g', text: 'Let DECEMBER_MODE override', done: false, state: 'queued' },
]
const space = () => ({ id: 's', name: 'Mode detection', updatedAt: new Date().toISOString(), scope: ['lib/board-*.mjs'], session: 'claude',
  blocks: [{ id: 'l', type: 'list', title: 'Mode detection', items: rows.map((r) => ({ ...r })), entities: [] }] })

async function renderer(board) {
  const prior = globalThis.window
  globalThis.window = { matchMedia: () => ({ matches: true }) }
  const { spaceInner } = await import('../public/js/blocks.js')
  const { page } = await import('../public/js/session.js')
  const sp = space()
  page.state = { sources: {}, spaces: [sp], ...(board ? { board } : {}) }
  return { html: (full) => spaceInner(sp, full), restore: () => { if (prior === undefined) delete globalThis.window; else globalThis.window = prior } }
}

test('a board card: one line of head with its count, each row its state, proof under the closed ones', async () => {
  const r = await renderer({ files: [{ path: 'lib/board-a.mjs', card: 's' }, { path: 'package-lock.json', card: null, outside: true }], drift: [{ path: 'package-lock.json', near: null }], sessions: [{ tag: 'claude' }, { tag: 'codex' }] })
  try {
    const html = r.html()
    assert.match(html, /<h2 class="space-name board-head"><span class="board-name">Mode detection<\/span><span class="board-count" aria-label="2 of 6 tasks done"><b>2<\/b> of 6<\/span><\/h2>/, 'a dropped task leaves the count')
    assert.match(html, /class="row is-done done no-anim"[^>]*aria-checked="true"/)
    assert.match(html, /8 pass · <span class="hash">d548be9<\/span>/)
    assert.match(html, /class="row is-done done no-anim held"[^>]*aria-checked="mixed"/, 'a claim without checked proof is held')
    assert.match(html, /class="row is-doing"[\s\S]*?tick-wind/)
    assert.match(html, /aria-label="Hand back the URL, in progress"/)
    assert.match(html, /aria-disabled="true"[\s\S]*?dropped/)
    assert.match(html, /blocked · Codex hooks unconfirmed/)
    assert.match(html, /when-sub urgent">needs you/)
    assert.match(html, /<span class="board-k">scope<\/span> <span class="board-path">lib\/board-\*\.mjs<\/span>/)
    assert.match(html, /<span class="board-facts">claude · 1 file<\/span>/, 'the agent is named once the board has two')
    assert.match(html, /board-drift-say">outside any card[\s\S]*package-lock\.json/)
    assert.doesNotMatch(html, /line-through|<s>/)
    assert.doesNotMatch(r.html(true), /board-drift/, 'the open card leaves the stray note to the grid')
  } finally { r.restore() }
})

test('a long plan folds its closed tasks; one agent is not named; a card with no bounds has no foot', async () => {
  const r = await renderer({ files: [], drift: [], sessions: [{ tag: 'claude' }] })
  try {
    const { page } = await import('../public/js/session.js')
    const sp = page.state.spaces[0]
    sp.scope = []
    sp.blocks[0].items.push(...[1, 2, 3].map((n) => ({ id: `q${n}`, text: `Later ${n}`, done: false, state: 'queued' })))
    const html = r.html()
    assert.match(html, /3 closed · 1 proven/)
    assert.ok(html.indexOf('Later 3') < html.indexOf('3 closed'), 'the open plan comes first')
    assert.doesNotMatch(html, /board-foot|board-facts/)
    assert.doesNotMatch(r.html(true), /3 closed/, 'opened, the card shows every task in order')
  } finally { r.restore() }
})

test("on the person's page the same list renders as it always has", async () => {
  const r = await renderer(null)
  try {
    const html = r.html()
    assert.doesNotMatch(html, /board-|is-doing|held|proofline/)
    assert.match(html, /role="checkbox"/)
  } finally { r.restore() }
})
