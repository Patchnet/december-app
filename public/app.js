// December — client. No framework, no build step.
// Boot, poll, and the session live here. Everything else is a module
// under public/js/: a new surface gets a new file.

import { $, api, page, hooks, reduced } from './js/session.js'
import './js/motion.js'
import './js/blocks.js'
import './js/layout.js'
import './js/year.js'
import './js/capture.js'
import './js/search.js'
import './js/actions.js'
import './js/connections.js'
import './js/about.js'
import './js/receipt.js'
import './js/demo.js'
import { render } from './js/paint.js'
import { fitCapture } from './js/capture.js'
import { renderSuggestions } from './js/layout.js'
import { jumpToSpace } from './js/actions.js'
import { buildYear } from './js/year.js'
import { closeFocus } from './js/layout.js'
import { loadConnections, renderSettings, shouldOnboard, launchParams, onboarding } from './js/connections.js'
import { firstRunDemo } from './js/demo.js'
import { showIntro } from './js/layout.js'

document.documentElement.classList.add('booting')

hooks.fitCapture = fitCapture
hooks.renderSuggestions = renderSuggestions
hooks.jumpToSpace = jumpToSpace

function schedulePoll() {
  clearTimeout(page.pollTimer)
  const busy = page.state && ((page.state.captures?.length || 0) || page.state.settle?.running)
  page.pollTimer = setTimeout(poll, busy ? 1500 : 10000)
}
let pollRequest = 0
const LIVE_FIELDS = ['settle', 'canUndo', 'canUndoManual']
function reconcileState(current, incoming) {
  if (!incoming || typeof incoming !== 'object') return current
  if (
    Number.isSafeInteger(current?.revision) &&
    (!Number.isSafeInteger(incoming.revision) || incoming.revision < current.revision)
  ) return current
  if (incoming.unchanged) {
    if (!current) return current
    const next = { ...current }
    for (const field of ['fingerprint', ...LIVE_FIELDS]) {
      if (Object.hasOwn(incoming, field)) next[field] = incoming[field]
    }
    return next
  }
  // An interrupted or proxy-truncated response must not erase the page.
  if (!Array.isArray(incoming.spaces) || !Array.isArray(incoming.captures)) return current
  const next = { ...incoming }
  for (const field of LIVE_FIELDS) {
    if (!Object.hasOwn(incoming, field) && Object.hasOwn(current || {}, field)) next[field] = current[field]
  }
  return next
}

async function poll() {
  const request = ++pollRequest
  try {
    const since = page.state?.fingerprint
    const incoming = await api(`/api/state${since ? `?since=${encodeURIComponent(since)}` : ''}`)
    if (request !== pollRequest) return
    const next = reconcileState(page.state, incoming)
    if (next !== page.state) {
      page.state = next
      render()
    }
  } catch {
    /* transient */
  }
  if (request === pollRequest) schedulePoll()
}

hooks.schedulePoll = schedulePoll

$('#dateline').addEventListener('click', () => (page.yearOpen ? closeFocus() : buildYear()))

setInterval(() => {
  if (page.state && !document.hidden) render()
}, 60000)

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    clearTimeout(page.pollTimer)
    poll()
  }
})

async function boot() {
  try {
    page.state = await api('/api/state')
    render()
    if (shouldOnboard) {
      onboarding.hidden = false
      renderSettings(await api('/api/settings'))
      await loadConnections()
    }
    if (launchParams.has('capture')) $('#capture').focus()
    schedulePoll()
    if (!page.state.spaces.length && !page.state.captures.length && !page.state.carryover) {
      if (!reduced) firstRunDemo()
      else if (!localStorage.getItem('dec-intro')) {
        localStorage.setItem('dec-intro', '1')
        setTimeout(showIntro, 400)
      }
    }
  } catch (e) {
    document.body.innerHTML = `<pre style="padding:40px;font-family:monospace">could not load: ${e.message}</pre>`
  }
}

boot()
