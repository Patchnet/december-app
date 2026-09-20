import { page, hooks, $, api, adoptState, toast } from './session.js'

export function renderJevStatus() {
  const status = page.state?.settle?.jev
  let panel = document.querySelector('.jev-preview')
  if (!status) { panel?.remove(); return }
  if (!panel) {
    panel = document.createElement('details')
    panel.className = 'jev-preview'
    panel.name = 'settings-detail'
    panel.setAttribute('aria-label', 'Jev preview diagnostics')
    const summary = document.createElement('summary')
    const heading = document.createElement('strong')
    const description = document.createElement('p')
    description.className = 'jev-description'
    const result = document.createElement('p')
    result.className = 'jev-result'
    result.setAttribute('role', 'status')
    summary.append(heading)
    panel.append(summary, description, result)
    const setup = document.createElement('p')
    setup.className = 'jev-setup'
    setup.textContent = 'Configure TYPESAFE_API_KEY or TYPESAFE_API_KEY_FILE on the December server, then restart it and check setup. The key stays on the server; this page never displays it.'
    panel.append(setup)
    const requestTime = document.createElement('p')
    requestTime.className = 'jev-request-time'
    const paintTime = document.createElement('p')
    paintTime.className = 'jev-paint-time'
    panel.append(requestTime, paintTime)
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'btn-quiet jev-undo'
    undo.textContent = 'Undo last change'
    undo.addEventListener('click', async () => {
      undo.disabled = true
      try { adoptState(await api('/api/undo', {})); hooks.render() }
      catch { toast('Could not undo. Your saved work is still here.') }
      finally { undo.disabled = false }
    })
    panel.append(undo)
    const settings = $('#settings-pop')
    if (settings) ($('#settings-jev') || settings).append(panel)
    else $('#shell').append(panel)
    if (status.provider === 'simulation') {
      const examples = document.createElement('div')
      examples.className = 'jev-examples'
      for (const [label, text] of [['Try a list addition', 'Add oat milk to Groceries'], ['Try Packing', 'Add a charging cable to Packing'], ['Try a question', 'Is my passport on the travel list?']]) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'btn-quiet'
        button.textContent = label
        button.addEventListener('click', () => {
          const capture = $('#capture')
          capture.value = text
          capture.dispatchEvent(new Event('input', { bubbles: true }))
          capture.focus()
          hooks.fitCapture()
        })
        examples.append(button)
      }
      panel.append(examples)
    }
  }
  panel.querySelector('.jev-setup').hidden = !!status.ready && status.mode !== 'off'
  panel.querySelector('strong').textContent = status.mode === 'off' ? 'Jev · disabled' : status.provider === 'simulation' ? 'Jev integration · simulated model' : `Jev · ${status.ready ? 'live API' : 'API key needed'}`
  panel.querySelector('.jev-description').textContent = status.provider === 'simulation'
    ? 'A separate sample page. List additions use December’s real save and undo flow. Other captures stay here for review.'
    : 'Fast routing for explicit list additions and named checklists. The existing organizer handles everything else.'
  const outcomes = {
    undone: 'Change undone. Your original capture is back in the inbox.',
    routing: 'Routing your capture…',
    created: 'Created your checklist.',
    'would-create': 'Shadow check matched a new checklist. The existing organizer still performs the action.',
    appended: page.state.canUndo ? 'Added to your list.' : 'The last list change is no longer available to undo.',
    fallback: status.provider === 'simulation' ? 'Kept in the inbox. The full organizer would handle this capture.' : 'Passed to the existing organizer.',
    'would-append': 'Shadow check matched. The existing organizer still performs the action.',
    unconfigured: 'No requests are sent to TypeSafe until a server-side key is configured.',
    idle: status.provider === 'simulation' ? 'Choose an example below, then send it from the capture field.' : 'Ready. Write a capture below—for example, “Add rice to Groceries”.',
  }
  panel.querySelector('.jev-result').textContent = outcomes[status.outcome] || ''
  panel.querySelector('.jev-undo').hidden = !page.state.canUndo
  panel.querySelector('.jev-request-time').textContent = status.provider === 'live' && Number.isFinite(status.last?.requestMs)
    ? `Jev request: ${status.last.requestMs} ms${Number.isFinite(status.last.captureToSavedMs) ? ` · capture → saved: ${status.last.captureToSavedMs} ms` : ''}` : ''
}
