import { $, esc, toast, api } from './session.js'
import { showIntro } from './layout.js'
import { closePocketPairing, isPocketPairingOpen, refreshPocket, trapPocketFocus } from './pocket.js'

export const launchParams = new URLSearchParams(location.search)
export const shouldOnboard = launchParams.has('firstrun') || (launchParams.has('desktop') && !localStorage.getItem('dec-onboarding'))
export const onboarding = $('#onboarding')

// ------------------------------------------------------------- settings
// Engine + model live server-side (data/settings.json): they belong to
// the settle pass, not this browser. The corner letter opens this.

const settingsPop = $('#settings-pop')
const settingsBackdrop = $('#settings-backdrop')
let currentConnections = null
let currentSettings = null

const organizingEngines = [
  { key: 'claude', label: 'Claude Code', logo: 'claude-code.png' },
  { key: 'codex', label: 'Codex', logo: 'codex.png' },
]

const connectionClients = [
  { key: 'claude-code', label: 'Claude Code', logo: 'claude-code.png', guidance: 'Install Claude Code and sign in once.' },
  { key: 'claude-desktop', label: 'Claude Desktop', logo: 'claude.png', guidance: 'Open Claude Desktop once so its local config exists.' },
  { key: 'codex', label: 'Codex', logo: 'codex.png', guidance: 'Install Codex and finish its sign-in flow.' },
  { key: 'cursor', label: 'Cursor', logo: 'cursor.png', guidance: 'Open Cursor once so its local config exists.' },
]

function connectionCopy(status) {
  if (!status) return { line: 'checking this machine', action: '', disabled: true }
  if (status.state === 'connected') return { line: 'connected to this December', action: 'reconnect', disabled: false }
  if (status.state === 'available') return { line: 'available on this machine', action: 'connect', disabled: false }
  if (status.state === 'error') return { line: status.detail || 'connection needs attention', action: 'reconnect', disabled: false }
  return { line: 'not installed', action: '', disabled: true }
}

function providerMark(client) {
  // a mask, not an image: the PNGs are drawn in four different inks (white,
  // black, orange), so as images two of them vanished in one theme or the
  // other. Painted in currentColor they all read in both.
  return `<span class="provider-logo" style="--logo: url(/providers/${client.logo})" aria-hidden="true"></span>`
}

function renderConnectionSettings() {
  const target = $('#connection-list')
  target.innerHTML = connectionClients.map((client) => {
    const status = currentConnections?.[client.key]
    const copy = connectionCopy(status)
    const guidance = status?.state === 'not-installed' ? client.guidance : copy.line
    return `<div class="connection-row ${status?.state || 'checking'}">
      ${providerMark(client)}
      <span class="connection-name"><b>${client.label}</b><small>${esc(guidance)}</small></span>
      ${copy.action ? `<button type="button" data-connect-client="${client.key}">${copy.action}</button>` : '<span class="connection-state">' + (status?.state === 'connected' ? '&#10003;' : '') + '</span>'}
    </div>`
  }).join('') + `<div class="connection-row unavailable">
    ${providerMark({ logo: 'chatgpt.png' })}
    <span class="connection-name"><b>ChatGPT</b><small>needs a remote connection — arrives with sync</small></span>
    <button type="button" disabled>later</button>
  </div>`
}

async function loadConnections() {
  try {
    currentConnections = (await api('/api/connect')).clients
    renderConnectionSettings()
    renderOnboarding()
  } catch (error) {
    currentConnections = null
    renderConnectionSettings()
    if (!onboarding.hidden) $('#onboarding-note').textContent = error.message
  }
}

async function connectClient(client, button) {
  if (button) {
    button.disabled = true
    button.textContent = 'connecting…'
  }
  try {
    const result = await api('/api/connect', { client })
    const label = connectionClients.find((item) => item.key === client)?.label || client
    toast(result.status?.state === 'connected' ? `${label} connected` : (result.status?.detail || `${label} needs attention`))
  } catch (error) {
    toast(error.message)
  } finally {
    await loadConnections()
  }
}

const settingsFocusables = () =>
  [...settingsPop.querySelectorAll('button:not(:disabled), input:not(:disabled), a[href]')]
    .filter((element) => !element.closest('[hidden]'))

function closeSettings(restoreFocus = true) {
  closePocketPairing(false)
  if (settingsPop.hidden) return
  settingsPop.hidden = true
  settingsBackdrop.hidden = true
  document.documentElement.classList.remove('modal-open')
  if (restoreFocus) $('#letter-toggle')?.focus()
}

function renderSettings(s) {
  currentSettings = s
  $('#about-version').textContent = s.version ? `v${s.version}` : ''
  const seg = $('#engine-seg')
  seg.innerHTML = ''
  for (const [key, label] of [['claude', 'Claude Code'], ['codex', 'Codex']]) {
    const b = document.createElement('button')
    b.type = 'button'
    b.role = 'radio'
    b.textContent = label
    b.setAttribute('aria-checked', String(s.engine === key))
    b.disabled = !s.engines[key]
    b.title = s.engines[key] ? '' : `${label} CLI not found on this machine`
    b.addEventListener('click', () => saveSettings({ engine: key }))
    seg.appendChild(b)
  }
  const input = $('#model-input')
  if (document.activeElement !== input) input.value = s.model || ''
  for (const key of ['claude', 'codex']) {
    const pathInput = $(`#${key}-path`)
    if (document.activeElement !== pathInput) pathInput.value = s.enginePaths?.[key] || ''
    pathInput.placeholder = s.resolvedEngines?.[key] || 'auto-detect'
    pathInput.title = s.resolvedEngines?.[key] || ''
  }
  renderConnectionSettings()
  renderOnboarding()
}

async function saveSettings(patch) {
  try {
    renderSettings(await api('/api/settings', patch))
    toast('settings saved')
  } catch (e) {
    toast(e.message)
  }
}

export async function openSettings() {
  if (!settingsPop.hidden) return
  settingsBackdrop.hidden = false
  settingsPop.hidden = false
  document.documentElement.classList.add('modal-open')
  try {
    renderSettings(await api('/api/settings'))
    await Promise.all([loadConnections(), refreshPocket()])
  } catch (e) {
    toast(e.message)
  }
  const first = settingsPop.querySelector('#theme-seg button[aria-checked="true"]') || settingsFocusables()[0]
  first?.focus()
}

// the reference has a permanent home now, instead of one appearance on a
// page you had not written anything on yet
$('#open-can').addEventListener('click', () => {
  closeSettings(false)
  showIntro()
})

$('#model-input').addEventListener('change', (e) => saveSettings({ model: e.target.value }))
$('#model-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur()
})

for (const key of ['claude', 'codex']) {
  const input = $(`#${key}-path`)
  input.addEventListener('change', (e) => saveSettings({ enginePaths: { [key]: e.target.value } }))
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur()
  })
}

$('#connection-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-connect-client]')
  if (button) connectClient(button.dataset.connectClient, button)
})

document.addEventListener('mousedown', (e) => {
  if (!settingsPop.hidden && e.target === settingsBackdrop) closeSettings()
})

document.addEventListener('keydown', (e) => {
  if (settingsPop.hidden) return
  if (isPocketPairingOpen()) {
    if (e.key === 'Escape') closePocketPairing()
    else trapPocketFocus(e)
    return
  }
  if (e.key === 'Escape') return closeSettings()
  if (e.key !== 'Tab') return
  const items = settingsFocusables()
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
})


/** Appearance lives in settings now, as a choice rather than a toggle: the
    corner stays for finding things. */
function markTheme() {
  const now = document.documentElement.dataset.theme || 'light'
  for (const b of $('#theme-seg').querySelectorAll('[data-theme-set]')) {
    b.setAttribute('aria-checked', String(b.dataset.themeSet === now))
  }
}

$('#theme-seg').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-set]')
  if (!btn) return
  const root = document.documentElement
  const next = btn.dataset.themeSet
  if (root.dataset.theme === next) return
  root.classList.add('theming')
  root.dataset.theme = next
  localStorage.setItem('dec-theme', next)
  markTheme()
  setTimeout(() => root.classList.remove('theming'), 320)
})
markTheme()

function renderOnboarding() {
  if (onboarding.hidden) return
  $('#onboarding-engines').innerHTML = organizingEngines.map((engine) => {
    const available = Boolean(currentSettings?.engines?.[engine.key])
    const selected = currentSettings?.engine === engine.key
    const action = selected ? (available ? 'selected' : 'selected · not found') : (available ? 'choose' : 'not found')
    return `<button type="button" class="onboarding-engine ${selected ? 'selected' : ''}" data-engine-select="${engine.key}" role="radio" aria-checked="${selected}" ${available && !selected ? '' : 'disabled'}>
      ${providerMark(engine)}
      <span class="provider-copy"><b>${engine.label}</b><small>${available ? 'installed on this machine' : 'CLI not found on this machine'}</small></span>
      <span class="provider-action">${action}</span>
    </button>`
  }).join('')

  const selectedEngine = organizingEngines.find((engine) => engine.key === currentSettings?.engine) || organizingEngines[0]
  const selectedAvailable = Boolean(currentSettings?.engines?.[selectedEngine.key])
  const availableEngine = organizingEngines.find((engine) => currentSettings?.engines?.[engine.key])
  $('#onboarding-engine-note').textContent = selectedAvailable
    ? `${selectedEngine.label} is ready to organize new captures.`
    : availableEngine
      ? `${selectedEngine.label} is selected but not found. Choose ${availableEngine.label}, or set a CLI path in Settings.`
      : 'Capture-only mode: every line is saved, but nothing will organize it until you install and sign in to Claude Code or Codex.'

  $('#onboarding-connections').innerHTML = connectionClients.map((client) => {
    const status = currentConnections?.[client.key]
    const copy = connectionCopy(status)
    const guidance = status?.state === 'not-installed' ? client.guidance : copy.line
    const connected = status?.state === 'connected'
    return `<button class="onboarding-engine ${connected ? 'connected' : ''}" data-connect-client="${copy.action ? client.key : ''}" ${copy.disabled || connected ? 'disabled' : ''}>
      ${providerMark(client)}
      <span class="provider-copy"><b>${client.label}</b><small>${esc(guidance)}</small></span>
      <span class="provider-action">${connected ? '&#10003;' : copy.action}</span>
    </button>`
  }).join('') + `<button class="onboarding-engine unavailable" disabled>
    ${providerMark({ logo: 'chatgpt.png' })}
    <span class="provider-copy"><b>ChatGPT</b><small>needs a remote connection — arrives with sync</small></span>
    <span class="provider-action">later</span>
  </button>`
  const connected = Object.values(currentConnections || {}).filter((status) => status.state === 'connected').length
  $('#onboarding-note').textContent = connected
    ? `${connected} assistant${connected === 1 ? '' : 's'} connected. You can reconnect any time from Settings.`
    : 'Connections are optional. You can add them any time from Settings.'
}

$('#onboarding').addEventListener('click', async (event) => {
  const engineButton = event.target.closest('[data-engine-select]')
  if (engineButton?.dataset.engineSelect) {
    await saveSettings({ engine: engineButton.dataset.engineSelect })
    return
  }
  const button = event.target.closest('[data-connect-client]')
  if (button?.dataset.connectClient) await connectClient(button.dataset.connectClient, button)
})

$('#onboarding-close').addEventListener('click', () => {
  onboarding.hidden = true
  localStorage.setItem('dec-onboarding', '1')
  launchParams.delete('firstrun')
  history.replaceState(null, '', `${location.pathname}${launchParams.size ? `?${launchParams}` : ''}`)
  $('#capture').focus()
})
export { loadConnections, renderSettings, closeSettings }
