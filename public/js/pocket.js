import { $, api } from './session.js'
import { createQrSvg } from './qr-code.js'

const pairingDialog = $('#pocket-pairing')
const qr = $('#pocket-qr')
const connectButton = $('#pocket-connect')
const syncButton = $('#pocket-sync')
const disconnectButton = $('#pocket-disconnect')
const confirmRow = $('#pocket-confirm')
let status = null
let pairingUrl = null
let action = null
let errorMessage = ''
let restorePairingFocus = null
let pairingRequest = 0

const pairingFocusables = () => [...pairingDialog.querySelectorAll('button:not(:disabled)')]
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
  if (action === 'pair') return { key: 'pairing', title: 'Getting your code ready…', detail: 'December is making a private connection.' }
  if (action === 'sync') return { key: 'syncing', title: 'Syncing now…', detail: 'Your local page is still available.' }
  if (errorMessage) return {
    key: looksOffline(errorMessage) ? 'offline' : 'error',
    title: looksOffline(errorMessage) ? 'Pocket is offline' : 'Pocket needs attention',
    detail: looksOffline(errorMessage) ? 'Check your connection and try again.' : 'December could not finish that. Try again.',
  }
  if (!status?.paired) return { key: 'disconnected', title: 'Your phone is not connected', detail: 'Connect it with a private, one-time code.' }
  if (status.lastError) return {
    key: looksOffline(status.lastError) ? 'offline' : 'error',
    title: looksOffline(status.lastError) ? 'Pocket is offline' : 'Pocket needs attention',
    detail: looksOffline(status.lastError) ? 'Your changes are safe here. Sync will try again.' : 'December could not finish the last sync. Try again.',
  }
  if (status.pendingRevision != null) return { key: 'offline', title: 'Waiting to sync', detail: 'Your changes are safe here and will retry.' }
  return { key: 'connected', title: 'Your phone is connected', detail: status.lastSyncedAt ? relativeTime(status.lastSyncedAt) : 'Ready for your first phone sync.' }
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
  connectButton.hidden = paired
  syncButton.hidden = !paired
  disconnectButton.hidden = !paired
  const busy = action !== null
  $('#pocket-status').setAttribute('aria-busy', String(busy))
  connectButton.disabled = busy
  syncButton.disabled = busy
  disconnectButton.disabled = busy
  $('#pocket-disconnect-confirm').disabled = busy
  $('#pocket-disconnect-cancel').disabled = busy
  connectButton.textContent = action === 'pair' ? 'Connecting…' : 'Connect phone'
  syncButton.textContent = action === 'sync' ? 'Syncing…' : 'Sync now'
}

function forgetPairingUrl() {
  pairingUrl = null
  qr.replaceChildren()
}

export function isPocketPairingOpen() {
  return !pairingDialog.hidden
}

export function closePocketPairing(restoreFocus = true) {
  pairingRequest++
  if (pairingDialog.hidden) {
    forgetPairingUrl()
    return
  }
  pairingDialog.hidden = true
  forgetPairingUrl()
  $('#settings-pop').inert = false
  $('#settings-pop').removeAttribute('aria-hidden')
  const target = restorePairingFocus ? restorePairingFocus : null
  restorePairingFocus = null
  target?.focus()
}

function openPairing(url) {
  pairingDialog.hidden = true
  forgetPairingUrl()
  pairingUrl = url
  qr.replaceChildren(createQrSvg(pairingUrl))
  restorePairingFocus = syncButton.hidden ? connectButton : syncButton
  $('#settings-pop').inert = true
  $('#settings-pop').setAttribute('aria-hidden', 'true')
  pairingDialog.hidden = false
  $('#pocket-pairing-close').focus()
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

export async function refreshPocket() {
  errorMessage = ''
  confirmRow.hidden = true
  try {
    status = await api('/api/pocket')
  } catch (error) {
    errorMessage = error.message
  }
  render()
}

async function runAction(name, path) {
  if (action) return null
  action = name
  errorMessage = ''
  render()
  try {
    const response = await api(path, {})
    if (name === 'pair') {
      const { pairingUrl: sensitiveUrl, ...safeStatus } = response
      status = safeStatus
      return { pairingUrl: sensitiveUrl }
    }
    status = response
    return response
  } catch (error) {
    errorMessage = error.message
    return null
  } finally {
    action = null
    render()
  }
}

connectButton.addEventListener('click', async () => {
  forgetPairingUrl()
  const request = ++pairingRequest
  const result = await runAction('pair', '/api/pocket/pair')
  if (!result?.pairingUrl || request !== pairingRequest) return
  try {
    openPairing(result.pairingUrl)
  } catch (error) {
    errorMessage = error.message
    forgetPairingUrl()
    render()
  }
})

syncButton.addEventListener('click', async () => {
  const result = await runAction('sync', '/api/pocket/sync')
  if (!result) return
  const imported = Number(result.imported) || 0
  if (imported && !result.lastError) {
    errorMessage = ''
    $('#pocket-status span').textContent = `${imported} phone ${imported === 1 ? 'note' : 'notes'} added. ${relativeTime(result.lastSyncedAt)}`
  }
})

disconnectButton.addEventListener('click', () => {
  if (action) return
  confirmRow.hidden = false
  disconnectButton.hidden = true
  syncButton.disabled = true
  $('#pocket-disconnect-confirm').focus()
})

$('#pocket-disconnect-cancel').addEventListener('click', () => {
  confirmRow.hidden = true
  disconnectButton.hidden = false
  syncButton.disabled = false
  disconnectButton.focus()
})

$('#pocket-disconnect-confirm').addEventListener('click', async () => {
  closePocketPairing(false)
  const result = await runAction('disconnect', '/api/pocket/disconnect')
  confirmRow.hidden = true
  if (result) connectButton.focus()
})

$('#pocket-pairing-close').addEventListener('click', () => closePocketPairing())
window.addEventListener('pagehide', () => closePocketPairing(false))

render()
