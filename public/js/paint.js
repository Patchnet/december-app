import { highlightCardChanges } from './card-changes.js'
import { $, page, hooks } from './session.js'
import { withFlip, celebrateDiffs } from './motion.js'
import {
  buildFocus, closeFocus, renderYearline, collectRun,
  renderInbox, renderActivity, renderSpaces, renderSuggestions,
  renderAsk, renderRail, releaseHeld,
} from './layout.js'
import { renderCarryover, renderCarryoverNudge } from './year.js'
import { renderGoals } from './goals.js'
import { paintLetter } from './about.js'
import { renderToday } from './attention.js'
import { cardHeld, completionPending } from './completion-motion.js'
import { paintBoard, paintBoardMoment } from './board.js'

export function renderStage() {
  const stage = $('#stage')
  if (!stage) return
  // the foot's help link is for the first days, like the enter hint;
  // after that it lives in Settings
  let early = true
  try { early = Number(localStorage.getItem('dec-files') || 0) < 5 } catch {}
  stage.querySelector('.stage-foot')?.toggleAttribute('hidden', !early)
  const composing = !!page.field.value.trim()
  // on a board a note is not filed by December: it waits for the agent at
  // the line's end, and the stage keeps showing the work
  const board = !!page.state.board
  const mode = composing
    ? 'composing'
    : page.state.ask
      ? 'asking'
      : !board && (page.retainingCaptures?.length || page.state.captures.length || page.queuedTexts.length || page.state.settle.running || page.flying > 0)
        ? 'settling'
        : 'idle'
  if (stage.dataset.mode !== mode) stage.dataset.mode = mode
  // Keep work in the same reserved slot while composing; moving it below
  // the moment used to push the entire grid down and back on every submission.
  const busy = !board && !!(page.retainingCaptures?.length || page.state.captures.length || page.queuedTexts.length || page.state.settle.running || page.flying)
  // A clarification owns this slot; its pending capture is not another
  // visible working pane. Keep compact progress only while composing.
  const compact = busy && mode === 'composing'
  const work = stage.querySelector('.pane-settling')
  const parent = stage.querySelector('.moment')
  // compact, it sits at the foot of the moment, the last thing in the stage
  if (work && work.parentElement !== parent) parent.append(work)
  const workChanged = stage.classList.contains('has-work') !== busy
  stage.classList.toggle('has-work', busy)
  work?.classList.toggle('compact', compact)
  const show = { ask: mode === 'asking', settling: mode === 'settling' || compact, idle: mode === 'idle' }
  for (const [name, on] of Object.entries(show)) {
    const pane = stage.querySelector(`.pane-${name}`)
    pane?.classList.toggle('off', !on)
    if (pane) pane.inert = !on
  }
  if (workChanged && composing) hooks.fitCapture()
}

import { measureCapturePaint } from './capture-timing.js'

export function render() {
  paintLetter()
  const board = paintBoard()
  if (!board) renderYearline()
  $('#shell').classList.toggle('settling', !board && page.state.captures.length > 0)
  // the run gathers this poll's destinations; their new content waits for
  // the one landing at the end of the pass
  const held = collectRun()
  withFlip(() => {
    if (!board) renderGoals()
    renderSpaces(held)
    renderInbox()
    renderActivity()
    // a completion changes the day's line in the same breath as its card;
    // a poll landing inside the moment must not say it first
    if (!board && !completionPending()) renderToday()
    renderCarryover()
    renderCarryoverNudge()
    renderSuggestions()
    renderAsk()
    if (board) paintBoardMoment()
    renderRail()
  })
  releaseHeld()
  renderStage()
  celebrateDiffs()
  if (page.focusId) {
    const space = page.state.spaces.find((s) => s.id === page.focusId)
    if (!space) closeFocus()
    // the opened card is held through a completion exactly as its grid card is
    else if (!held.has(space.id) && !cardHeld(space.id) && ($('#focus').dataset.u !== space.updatedAt || $('#focus').dataset.preview !== (space.previewKey || ''))) {
      buildFocus()
      if (!page.flying && !(page.state.settle.running && page.state.captures.length)) highlightCardChanges($('#focus .focus-card'), page.prev?.spaces.find(s=>s.id===space.id), space)
    }
  }
  if (page.booting) {
    setTimeout(() => document.documentElement.classList.remove('booting'), 1400)
    page.booting = false
  }
  page.prev = page.state
  measureCapturePaint(page.state, page.flying)
}

hooks.render = render
hooks.renderStage = renderStage
