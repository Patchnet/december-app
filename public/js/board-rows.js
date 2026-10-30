import { esc, page } from './session.js'
// Board rows and cards. A row says its state the way December already says
// "overdue": a small word on the right, red only for what needs the person.
// The tick is the truth: painted only once the board checked the proof (or
// the person ticked it themselves), held and dashed while it is a claim.
// The card's head is one line, its name and its count; the paths it may
// touch and how much moved sit at its foot.

export const onBoard = () => !!page.state?.board

const TICK = '<span class="tick"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.2 L4.8 9 L10 3.4" /></svg></span>'
const stateOf = (i) => i.state || (i.done ? 'done' : 'queued')
const proven = (i) => stateOf(i) === 'done' && !!i.proof?.ok
const counted = (items) => items.filter((i) => stateOf(i) !== 'cancelled')

/** The proof line under a closed task: what backs it, in the meta voice. */
function proofLine(i) {
  const p = i.proof
  if (!p) return '<span class="proofline">no proof</span>'
  if (p.by === 'you') return '<span class="proofline">ticked by you</span>'
  const bits = [
    p.tests ? esc(p.tests) : '',
    p.commit ? `<span class="hash">${esc(p.commit)}</span>` : '',
    p.file ? `<span class="path">${esc(p.file.split('/').pop())}</span>` : '',
    p.shot ? '<span class="path">shot</span>' : '',
  ].filter(Boolean)
  return `<span class="proofline${p.ok ? ' proof' : ''}">${bits.join(' · ') || 'no proof'}</span>`
}

/** One task row. `text` is already linkified by blocks.js. */
export function boardRowMarkup(b, i, text) {
  const state = stateOf(i)
  const done = state === 'done'
  const held = done && !proven(i)
  const meta = state === 'waiting' ? `<span class="row-meta"><span class="when-sub urgent">needs you${i.reason ? ` · ${esc(i.reason)}` : ''}</span></span>`
    : state === 'blocked' ? `<span class="row-meta"><span class="when-sub">blocked${i.reason ? ` · ${esc(i.reason)}` : ''}</span></span>`
      : state === 'cancelled' ? `<span class="row-meta"><span class="when-sub">dropped</span></span>`
        : ''
  const slot = state === 'doing' ? '<span class="tick tick-wind" aria-hidden="true"></span>'
    : state === 'cancelled' ? '<span class="tick tick-none" aria-hidden="true"></span>' : TICK
  const cls = ['row', `is-${state}`, done ? 'done no-anim' : '', held ? 'held' : ''].filter(Boolean).join(' ')
  const checked = held ? 'mixed' : String(done)
  const said = { doing: 'in progress', waiting: 'needs you', blocked: 'blocked', cancelled: 'dropped' }[state]
  const sub = done ? `<span class="row-sub">${proofLine(i)}</span>` : ''
  return `
      <button class="${cls}" data-block="${b.id}" data-item="${i.id}" data-state="${state}"
        role="checkbox" aria-checked="${checked}" aria-label="${esc(i.text)}${said ? `, ${said}` : ''}"${state === 'cancelled' ? ' aria-disabled="true"' : ''}>
        ${slot}<span class="row-text">${text}</span>${meta}${sub}
      </button>`
}

/** A board list keeps plan order. Past eight tasks, the closed ones fold
    away under one door so the open plan stays in view. */
export function boardListMarkup(b, full, row) {
  const items = b.items
  if (full || items.length <= 8) return items.map(row).join('')
  const done = items.filter((i) => stateOf(i) === 'done' || stateOf(i) === 'cancelled')
  const open = items.filter((i) => !done.includes(i))
  const key = `completed:${b.id}`
  const ok = done.filter(proven).length
  return `${open.map(row).join('')}${done.length ? `<details class="list-preview completed-list" data-list-preview="${esc(key)}"${page.expandedLists.has(key) ? ' open' : ''}>
      <summary class="done-count"><span>${done.length} closed${ok ? ` · ${ok} proven` : ''}</span><span class="list-chevron" aria-hidden="true">⌄</span></summary>
      <div class="completed-rows">${done.map(row).join('')}</div>
    </details>` : ''}`
}

/** The card: one line of head (name, count), the rows, then the foot. */
export function boardCardMarkup(space, { corner, body, full }) {
  const items = counted(space.blocks.filter((x) => x.type === 'list').flatMap((x) => x.items))
  const done = items.filter((i) => stateOf(i) === 'done').length
  const count = items.length
    ? `<span class="board-count${done === items.length ? ' all' : ''}" aria-label="${done} of ${items.length} tasks done"><b>${done}</b> of ${items.length}</span>`
    : ''
  const board = page.state.board
  const files = (board.files || []).filter((f) => f.card === space.id).length
  // who is on it, only once the board has more than one agent
  const who = new Set((board.sessions || []).map((s) => s.tag)).size > 1 && space.session ? space.session : ''
  const facts = [who, files ? `${files} ${files === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(' · ')
  const scope = (space.scope || []).length
    ? `<span class="board-scope"><span class="board-k">scope</span> ${space.scope.map((p) => `<span class="board-path">${esc(p)}</span>`).join(' · ')}</span>` : '<span class="board-scope"></span>'
  const foot = space.scope?.length || facts ? `<div class="board-foot">${scope}${facts ? `<span class="board-facts">${esc(facts)}</span>` : ''}</div>` : ''
  // a stray file with no card near it is noted on the first card with bounds
  const first = page.state.spaces.find((s) => !s.finished && s.scope?.length)?.id
  const drift = (board.drift || []).filter((d) => (d.near || first) === space.id)
  const note = drift.length ? `<aside class="board-drift" aria-label="${drift.length} ${drift.length === 1 ? 'file' : 'files'} outside any card"><p class="board-drift-say">outside any card</p>${drift.map((d) => `<p class="board-drift-path">${esc(d.path)}</p>`).join('')}</aside>` : ''
  return `
    ${corner}
    <h2 class="space-name board-head"><span class="board-name">${esc(space.name)}</span>${count}</h2>
    ${body}
    ${foot}${full ? '' : note}`
}
