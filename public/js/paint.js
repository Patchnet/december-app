import { highlightCardChanges } from './card-changes.js'
import { $, page, hooks } from './session.js'
import { withFlip, celebrateDiffs } from './motion.js'
import {
  buildFocus, closeFocus, renderYearline, travelTargets, heldSpaces,
  renderInbox, renderActivity, renderSpaces, renderToday, renderSuggestions,
  renderAsk, renderRail, releaseHeld,
} from './layout.js'
import { renderCarryover, renderCarryoverNudge } from './year.js'
import { renderGoals } from './goals.js'
import { paintLetter } from './about.js'
import { renderStageContext } from './stage-context.js'
import { showIntro, openStageCard } from './layout.js'

export function renderStage() {
  const stage = $('#stage')
  if (!stage) return
  renderStageContext({root:$('#stage-context'),state:page.state,count:page.attentionCount || 0,onToday:renderToday,onHelp:showIntro,onOpen:openStageCard})
  const composing = !!page.field.value.trim()
  const mode = composing
    ? 'composing'
    : page.state.ask
      ? 'asking'
      : page.state.captures.length || page.queuedTexts.length || page.state.settle.running || page.flying > 0
        ? 'settling'
        : 'idle'
  if (stage.dataset.mode !== mode) stage.dataset.mode = mode
  // Keep the existing work line reachable while the writing/question pane owns
  // the stage. Move its DOM, preserving the queue button, yarn, and focus.
  const busy = !!(page.state.captures.length || page.queuedTexts.length || page.state.settle.running || page.flying)
  const compact = busy && (mode === 'composing' || mode === 'asking')
  const work = stage.querySelector('.pane-settling')
  const parent = compact ? stage : stage.querySelector('.moment')
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

export function render() {
  paintLetter()
  renderYearline()
  $('#shell').classList.toggle('settling', page.state.captures.length > 0)
  const targets = travelTargets()
  const held = new Set([...targets.values(), ...heldSpaces()])
  withFlip(() => {
    renderGoals()
    renderSpaces(held)
    renderInbox(targets)
    renderActivity()
    renderToday()
    renderCarryover()
    renderCarryoverNudge()
    renderSuggestions()
    renderAsk()
    renderRail()
  })
  releaseHeld(targets)
  renderStage()
  celebrateDiffs()
  if (page.focusId) {
    const space = page.state.spaces.find((s) => s.id === page.focusId)
    if (!space) closeFocus()
    else if ($('#focus').dataset.u !== space.updatedAt || $('#focus').dataset.preview !== (space.previewKey || '')) {
      buildFocus()
      highlightCardChanges($('#focus .focus-card'), page.prev?.spaces.find(s=>s.id===space.id), space)
    }
  }
  if (page.booting) {
    setTimeout(() => document.documentElement.classList.remove('booting'), 1400)
    page.booting = false
  }
  page.prev = page.state
}

hooks.render = render
hooks.renderStage = renderStage
