import { $, api } from './session.js'
import { createQrSvg } from './qr-code.js'

const pairingDialog = $('#pocket-pairing')
const qr = $('#pocket-qr')
const pairingCodeOutput = $('#pocket-pairing-code')
const pairingExpiryOutput = $('#pocket-pairing-expiry')
const pairingRetryButton = $('#pocket-pairing-retry')
const pairingPrepare = $('#pocket-pairing-prepare')
const pairingOptions = $('#pocket-pairing-options')
const pairingBeginButton = $('#pocket-pairing-begin')
const connectButton = $('#pocket-connect')
const reconnectButton = $('#pocket-reconnect')
const moveButton = $('#pocket-move')
const lostButton = $('#pocket-lost')
const syncButton = $('#pocket-sync')
const disconnectButton = $('#pocket-disconnect')
const retryButton = $('#pocket-retry')
const confirmRow = $('#pocket-confirm')
const confirmButton = $('#pocket-disconnect-confirm')
const cancelButton = $('#pocket-disconnect-cancel')

const intents = Object.freeze({
  connect: {
    name: 'pair',
    path: '/api/pocket/pair',
    body: {},
    pairing: true,
    mode: 'connect',
    buttonId: 'pocket-connect',
  },
  reconnect: {
    name: 'reconnect',
    path: '/api/pocket/rotate',
    body: { reason: 'protocol-repair' },
    pairing: true,
    mode: 'reconnect',
    buttonId: 'pocket-reconnect',
    confirmCopy: 'Create a fresh pairing code? This repairs Pocket security and replaces the old phone connection.',
    confirmLabel: 'Create fresh code',
  },
  move: {
    name: 'move',
    path: '/api/pocket/rotate',
    body: { reason: 'move-device' },
    pairing: true,
    mode: 'move',
    buttonId: 'pocket-move',
    confirmCopy: 'Move to a new phone? Keep the old phone nearby. It stays connected until the new phone claims the connection when that is safe; otherwise December stops the move.',
    confirmLabel: 'Prepare new phone',
  },
  lost: {
    name: 'lost',
    path: '/api/pocket/rotate',
    body: { reason: 'lost-phone' },
    pairing: true,
    mode: 'lost',
    buttonId: 'pocket-lost',
    confirmCopy: 'Phone lost or stolen? December immediately revokes that phone and rotates the encryption key. This cannot be undone.',
    confirmLabel: 'Revoke phone now',
  },
  sync: {
    name: 'sync',
    path: '/api/pocket/sync',
    body: {},
    buttonId: 'pocket-sync',
  },
  disconnect: {
    name: 'disconnect',
    path: '/api/pocket/disconnect',
    body: {},
    buttonId: 'pocket-disconnect',
    confirmCopy: 'Disconnect this phone? It will stop receiving this page and sending notes to this computer.',
    confirmLabel: 'Yes, disconnect',
  },
  refresh: { name: 'refresh', buttonId: 'pocket-retry' },
})

const pairingTitles = Object.freeze({
  connect: 'Connect your phone',
  reconnect: 'Reconnect your phone',
  move: 'Move to your new phone',
  lost: 'Connect a replacement phone',
})

let status = null
let pairingUrl = null
let pairingCode = null
let pairingExpiresAt = null
let pairingTimer = null
let pairingPollTimer = null
let pairingMode = null
let preparedIntent = null
let action = null
let errorMessage = ''
let restorePairingFocus = null
let pairingRequest = 0
let pairingPollBusy = false
let capability = null
let pendingIntent = null
let lastFailedIntent = null

// Pocket's acting routes ask for a capability December only gives to a page
// it served itself. The capability is minted per run and never written down.
async function claimCapability() {
  const response = await fetch('/api/pocket/capability')
  if (!response.ok) throw new Error('request failed')
  capability = (await response.json()).capability
}

async function pocketPost(path, body = {}) {
  const send = async () => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-december-capability': capability || '' },
      body: JSON.stringify(body),
    })
    return { response, data: await response.json().catch(() => ({})) }
  }
  if (!capability) await claimCapability()
  let { response, data } = await send()
  if (response.status === 403) {
    await claimCapability()
    ;({ response, data } = await send())
  }
  if (!response.ok) throw new Error(data.error || 'request failed')
  return data
}

const pairingFocusables = () =>
  [...pairingDialog.querySelectorAll('button:not(:disabled), a[href]')]
    .filter((element) => !element.closest('[hidden]'))
const looksOffline = (message) => /offline|fetch failed|network|timed?\s*out|timeout|unreachable|econn|enotfound/i.test(message || '')

function relativeTime(value) {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return 'Sync time unavailable'
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 45) return 'Synced just now'
  if (seconds < 3600) return `Synced ${Math.round(seconds / 60)} minutes ago`
  if (seconds < 86400) return `Synced ${Math.round(seconds / 3600)} hours ago`
  return `Last synced ${new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

function viewState() {
  if (action === 'pair') return { key: 'pairing', title: 'Getting your pairing options ready…', detail: 'December is creating a private five-minute connection.' }
  if (action === 'reconnect') return { key: 'pairing', title: 'Preparing a secure reconnection…', detail: 'The phone action is in progress.' }
  if (action === 'move') return { key: 'pairing', title: 'Preparing your new phone…', detail: 'The old phone stays connected while December prepares the move.' }
  if (action === 'lost') return { key: 'pairing', title: 'Revoking the missing phone now…', detail: 'December is rotating the encryption key before showing a new code.' }
  if (action === 'sync') return { key: 'syncing', title: 'Syncing now…', detail: 'Your local page is still available.' }
  if (action === 'disconnect') return { key: 'pairing', title: 'Disconnecting phone…', detail: 'December is removing this phone connection.' }
  if (action === 'refresh') return { key: 'pairing', title: 'Checking Pocket again…', detail: 'December is refreshing the phone connection status.' }
  if (status?.secretsPersisted === false) return {
    key: 'unavailable',
    title: 'Pocket is unavailable on this computer',
    detail: 'There is no secure key store here, so December will not save a phone connection. Everything else works.',
  }
  if (errorMessage) return {
    key: looksOffline(errorMessage) ? 'offline' : 'error',
    title: looksOffline(errorMessage) ? 'Pocket is offline' : 'Pocket needs attention',
    detail: looksOffline(errorMessage) ? 'Check your connection, then retry.' : 'December could not finish that request. Retry when you are ready.',
  }
  if (status?.repairReset) return {
    key: 'disconnected',
    title: 'Connect your phone again',
    detail: 'December repaired an incomplete Pocket upgrade. Create a fresh code to reconnect.',
  }
  if (status?.requiresRepair) return {
    key: 'repair',
    title: 'Reconnect phone',
    detail: 'December improved how it protects Pocket. Reconnect this paired device with a fresh code.',
  }
  if (status?.revokePending) return {
    key: 'offline',
    title: 'Finishing the disconnect',
    detail: 'Your phone is off this computer. December is still asking the relay to delete its copy.',
  }
  if (!status?.paired) return { key: 'disconnected', title: 'No phone paired', detail: 'Pair a device with a private, one-time code.' }
  if (status.lastError) return {
    key: looksOffline(status.lastError) ? 'offline' : 'error',
    title: looksOffline(status.lastError) ? 'Pocket is offline' : 'Pocket needs attention',
    detail: looksOffline(status.lastError) ? 'Your changes are safe here. Sync will try again.' : 'December could not finish the last sync. Try again.',
  }
  if (status.pendingRevision != null) return { key: 'offline', title: 'Waiting to sync', detail: 'Your changes are safe here and will retry.' }
  if (!status.phoneReady) return { key: 'pairing', title: 'Waiting for your phone', detail: 'Open the installed December Pocket app and scan the QR code.' }
  return { key: 'connected', title: 'Phone paired', detail: status.lastSyncedAt ? relativeTime(status.lastSyncedAt) : 'Ready for the first phone sync.' }
}

function render() {
  const view = viewState()
  $('#pocket-settings').dataset.state = view.key
  $('#pocket-status').replaceChildren()
  const title = document.createElement('strong')
  const detail = document.createElement('span')
  title.textContent = view.title
  detail.textContent = view.detail
  $('#pocket-status').append(title, detail)

  const paired = !!status?.paired
  const repairing = !!status?.requiresRepair
  const usable = status?.secretsPersisted !== false
  const busy = action !== null
  const confirming = pendingIntent !== null
  const controlsLocked = busy || confirming
  connectButton.hidden = !usable || paired || repairing || confirming
  reconnectButton.hidden = !usable || !repairing || confirming
  moveButton.hidden = !usable || !paired || confirming
  lostButton.hidden = !usable || !paired || confirming
  syncButton.hidden = !paired || confirming
  disconnectButton.hidden = !(paired || repairing) || confirming
  retryButton.hidden = !lastFailedIntent || busy || confirming
  $('#pocket-status').setAttribute('aria-busy', String(busy))

  for (const button of [connectButton, reconnectButton, moveButton, lostButton, syncButton, disconnectButton, retryButton]) {
    button.disabled = controlsLocked
  }
  confirmButton.disabled = busy
  cancelButton.disabled = busy
  connectButton.textContent = action === 'pair' ? 'Preparing…' : 'Connect phone'
  reconnectButton.textContent = action === 'reconnect' ? 'Reconnecting…' : 'Reconnect phone'
  moveButton.textContent = action === 'move' ? 'Preparing move…' : 'Move to a new phone'
  lostButton.textContent = action === 'lost' ? 'Revoking phone…' : 'Phone lost or stolen'
  syncButton.textContent = action === 'sync' ? 'Syncing…' : 'Sync now'
  disconnectButton.textContent = action === 'disconnect' ? 'Disconnecting…' : 'Disconnect'
}

function clearPairingTimer() {
  if (pairingTimer != null) window.clearInterval(pairingTimer)
  if (pairingPollTimer != null) window.clearInterval(pairingPollTimer)
  pairingTimer = null
  pairingPollTimer = null
}

function forgetPairingSecrets() {
  pairingUrl = null
  pairingCode = null
  pairingExpiresAt = null
  clearPairingTimer()
  qr.replaceChildren()
  pairingCodeOutput.textContent = ''
  pairingExpiryOutput.textContent = ''
  pairingExpiryOutput.removeAttribute('role')
  pairingExpiryOutput.setAttribute('aria-live', 'off')
  pairingRetryButton.hidden = true
}

function updatePairingCountdown() {
  if (pairingDialog.hidden || pairingExpiresAt == null) return
  const seconds = Math.max(0, Math.ceil((pairingExpiresAt - Date.now()) / 1000))
  if (seconds === 0) {
    pairingUrl = null
    pairingCode = null
    pairingExpiresAt = null
    clearPairingTimer()
    qr.replaceChildren()
    pairingCodeOutput.textContent = ''
    pairingExpiryOutput.setAttribute('role', 'status')
    pairingExpiryOutput.setAttribute('aria-live', 'polite')
    pairingExpiryOutput.textContent = 'This pairing code has expired.'
    pairingRetryButton.hidden = false
    return
  }
  const minutes = Math.floor(seconds / 60)
  pairingExpiryOutput.textContent = `Expires in ${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function isPocketPairingOpen() {
  return !pairingDialog.hidden
}

export function closePocketPairing(restoreFocus = true) {
  pairingRequest++
  const target = restoreFocus ? restorePairingFocus : null
  pairingDialog.hidden = true
  forgetPairingSecrets()
  pairingMode = null
  preparedIntent = null
  restorePairingFocus = null
  $('#settings-pop').inert = false
  $('#settings-pop').removeAttribute('aria-hidden')
  target?.focus()
}

function preparePairing(intent) {
  if (action || !intent?.pairing) return
  pairingMode = intent.mode
  preparedIntent = intent
  restorePairingFocus = returnTargetFor(intent.mode)
  pairingDialog.hidden = true
  forgetPairingSecrets()
  pairingPrepare.hidden = false
  pairingOptions.hidden = true
  pairingBeginButton.disabled = false
  $('#pocket-pairing-title').textContent = pairingTitles[intent.mode] || pairingTitles.connect
  $('#pocket-pairing-copy').textContent = 'Install December Pocket first. Open it from your Home Screen before creating the five-minute QR code.'
  $('#settings-pop').inert = true
  $('#settings-pop').setAttribute('aria-hidden', 'true')
  pairingDialog.hidden = false
  pairingBeginButton.focus()
}

async function pollPairingStatus() {
  if (pairingDialog.hidden || !pairingUrl || action || pairingPollBusy) return
  const request = pairingRequest
  pairingPollBusy = true
  try {
    const next = await pocketPost('/api/pocket/pairing-status')
    if (pairingDialog.hidden || request !== pairingRequest) return
    status = next
    render()
    if (status.phoneReady) {
      pairingExpiryOutput.textContent = 'Phone connected.'
      closePocketPairing(false)
    }
  } catch { /* the normal status surface reports relay connectivity */ }
  finally { pairingPollBusy = false }
}

function returnTargetFor(mode) {
  const preferred = {
    reconnect: reconnectButton,
    move: moveButton,
    lost: lostButton,
  }[mode]
  return preferred && !preferred.hidden ? preferred : syncButton
}

function openPairing({ pairingUrl: url, pairingCode: code, pairingExpiresAt: expiry, mode }) {
  pairingDialog.hidden = true
  forgetPairingSecrets()
  const expiresAt = Date.parse(expiry)
  if (typeof url !== 'string' || !url || typeof code !== 'string' || !code || !Number.isFinite(expiresAt)) {
    throw new Error('pairing options unavailable')
  }
  try {
    pairingUrl = url
    pairingCode = code
    pairingExpiresAt = expiresAt
    pairingMode = mode
    preparedIntent = null
    qr.replaceChildren(createQrSvg(pairingUrl))
    pairingCodeOutput.textContent = pairingCode
    $('#pocket-pairing-title').textContent = pairingTitles[mode] || pairingTitles.connect
    $('#pocket-pairing-copy').textContent = 'In the installed December Pocket app, choose Scan QR code and point your phone at this code.'
    pairingPrepare.hidden = true
    pairingOptions.hidden = false
    restorePairingFocus = returnTargetFor(mode)
    $('#settings-pop').inert = true
    $('#settings-pop').setAttribute('aria-hidden', 'true')
    pairingDialog.hidden = false
    updatePairingCountdown()
    if (pairingExpiresAt != null) pairingTimer = window.setInterval(updatePairingCountdown, 1000)
    pairingPollTimer = window.setInterval(() => void pollPairingStatus(), 2000)
    $('#pocket-pairing-close').focus()
  } catch (error) {
    pairingDialog.hidden = true
    forgetPairingSecrets()
    $('#settings-pop').inert = false
    $('#settings-pop').removeAttribute('aria-hidden')
    throw error
  }
}

export function trapPocketFocus(event) {
  if (!isPocketPairingOpen() || event.key !== 'Tab') return false
  const items = pairingFocusables()
  if (!items.length) return false
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
  return true
}

function hideConfirmation(restoreFocus = false) {
  const target = restoreFocus && pendingIntent ? $(`#${pendingIntent.buttonId}`) : null
  pendingIntent = null
  confirmRow.hidden = true
  render()
  target?.focus()
}

function showConfirmation(intent) {
  if (action || pendingIntent) return
  pendingIntent = intent
  $('#pocket-confirm-copy').textContent = intent.confirmCopy
  confirmButton.textContent = intent.confirmLabel
  confirmRow.hidden = false
  render()
  confirmButton.focus()
}

export async function refreshPocket() {
  errorMessage = ''
  lastFailedIntent = null
  hideConfirmation()
  action = 'refresh'
  render()
  try {
    status = await api('/api/pocket')
  } catch (error) {
    errorMessage = error.message
    lastFailedIntent = intents.refresh
  } finally {
    action = null
    render()
  }
}

async function runAction(intent) {
  if (action) return null
  action = intent.name
  errorMessage = ''
  lastFailedIntent = null
  render()
  try {
    const response = await pocketPost(intent.path, intent.body)
    if (intent.pairing) {
      const { pairingUrl: sensitiveUrl, pairingCode: sensitiveCode, ...safeStatus } = response
      status = safeStatus
      return {
        pairingUrl: sensitiveUrl,
        pairingCode: sensitiveCode,
        pairingExpiresAt: safeStatus.pairingExpiresAt,
        mode: intent.mode,
      }
    }
    status = response
    return response
  } catch (error) {
    errorMessage = error.message
    lastFailedIntent = intent
    return null
  } finally {
    action = null
    render()
  }
}

async function executePairing(intent) {
  forgetPairingSecrets()
  const request = ++pairingRequest
  const result = await runAction(intent)
  if (!result || request !== pairingRequest) {
    if (request !== pairingRequest) forgetPairingSecrets()
    if (!result) closePocketPairing(false)
    return
  }
  try {
    openPairing(result)
  } catch (error) {
    errorMessage = error.message
    lastFailedIntent = intent
    forgetPairingSecrets()
    render()
  }
}

async function executeIntent(intent) {
  if (!intent) return
  if (intent.name === 'refresh') {
    await refreshPocket()
    return
  }
  if (intent.pairing) {
    await executePairing(intent)
    return
  }
  const result = await runAction(intent)
  if (!result) return
  if (intent.name === 'sync') {
    const imported = Number(result.imported) || 0
    if (imported && !result.lastError) {
      $('#pocket-status span').textContent = `${imported} phone ${imported === 1 ? 'note' : 'notes'} added. ${relativeTime(result.lastSyncedAt)}`
    }
    return
  }
  if (intent.name === 'disconnect') {
    if (result.revoked === false) {
      $('#pocket-status span').textContent = 'Your phone is off this computer. December will finish deleting the relay copy when it can reach it.'
    }
    connectButton.focus()
  }
}

connectButton.addEventListener('click', () => preparePairing(intents.connect))
reconnectButton.addEventListener('click', () => showConfirmation(intents.reconnect))
moveButton.addEventListener('click', () => showConfirmation(intents.move))
lostButton.addEventListener('click', () => showConfirmation(intents.lost))
syncButton.addEventListener('click', () => executeIntent(intents.sync))
disconnectButton.addEventListener('click', () => showConfirmation(intents.disconnect))
retryButton.addEventListener('click', () => executeIntent(lastFailedIntent))

cancelButton.addEventListener('click', () => hideConfirmation(true))
confirmButton.addEventListener('click', async () => {
  const intent = pendingIntent
  hideConfirmation()
  if (intent?.name === 'disconnect') closePocketPairing(false)
  if (intent?.pairing) preparePairing(intent)
  else await executeIntent(intent)
})

pairingBeginButton.addEventListener('click', async () => {
  const intent = preparedIntent
  if (!intent) return
  pairingBeginButton.disabled = true
  await executePairing(intent)
})

pairingRetryButton.addEventListener('click', async () => {
  const intent = intents[pairingMode] || intents.connect
  closePocketPairing(false)
  await executePairing(intent)
})

$('#pocket-pairing-close').addEventListener('click', () => closePocketPairing())
window.addEventListener('pagehide', () => closePocketPairing(false))

render()
