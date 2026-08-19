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

export function renderStage() {
  const stage = $('#stage')
  if (!stage) return
  const composing = !!page.field.value.trim()
  const mode = composing
    ? 'composing'
    : page.state.ask
      ? 'asking'
      : page.state.captures.length || page.queuedTexts.length || page.state.settle.running || page.flying > 0
        ? 'settling'
        : 'idle'
  if (stage.dataset.mode !== mode) stage.dataset.mode = mode
  const show = { ask: mode === 'asking', settling: mode === 'settling', idle: mode === 'idle' }
  for (const [name, on] of Object.entries(show)) {
    stage.querySelector(`.pane-${name}`)?.classList.toggle('off', !on)
  }
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
    else if ($('#focus').dataset.u !== space.updatedAt) buildFocus()
  }
  if (page.booting) {
    setTimeout(() => document.documentElement.classList.remove('booting'), 1400)
    page.booting = false
  }
  page.prev = page.state
}

hooks.render = render
hooks.renderStage = renderStage
