import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQrMatrix } from '../public/js/qr-code.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const html = read('public/index.html')
const pocket = read('public/js/pocket.js')
const qrCode = read('public/js/qr-code.js')
const connections = read('public/js/connections.js')
const settingsCss = read('public/css/settings.css')

test('Pocket QR codes are constructed locally without a remote provider', () => {
  const pairingUrl = 'https://app.getdecember.me/#space=space_test&token=private_token&key=private_key'
  const first = createQrMatrix(pairingUrl)
  const second = createQrMatrix(pairingUrl)

  assert.deepEqual(first, second)
  assert.ok([57, 85, 97].includes(first.length), `unexpected QR size ${first.length}`)
  assert.ok(first.every((row) => row.length === first.length && row.every((cell) => typeof cell === 'boolean')))
  assert.match(pocket, /import \{ createQrSvg \} from '\.\/qr-code\.js'/)
  assert.doesNotMatch(qrCode, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/)
  assert.doesNotMatch(`${html}\n${pocket}\n${qrCode}`, /(?:api\.qrserver\.com|chart\.googleapis\.com|quickchart\.io|qrcode\.monkey)/i)
})

test('the sensitive pairing URL is separated from status and cleared on every exit path', () => {
  assert.match(pocket, /const \{ pairingUrl: sensitiveUrl, \.\.\.safeStatus \} = response\s+status = safeStatus/)
  assert.match(pocket, /function forgetPairingUrl\(\) \{\s+pairingUrl = null\s+qr\.replaceChildren\(\)\s+\}/)
  assert.match(pocket, /export function closePocketPairing[\s\S]*?pairingRequest\+\+[\s\S]*?forgetPairingUrl\(\)/)
  assert.match(pocket, /if \(pairingDialog\.hidden\) \{\s+forgetPairingUrl\(\)\s+return/)
  assert.match(pocket, /connectButton\.addEventListener\('click',[\s\S]*?forgetPairingUrl\(\)[\s\S]*?request !== pairingRequest/)
  assert.match(pocket, /catch \(error\) \{\s+errorMessage = error\.message\s+forgetPairingUrl\(\)/)
  assert.match(pocket, /pocket-pairing-close'\)\.addEventListener\('click', \(\) => closePocketPairing\(\)\)/)
  assert.match(pocket, /pagehide', \(\) => closePocketPairing\(false\)/)
  assert.match(connections, /function closeSettings[\s\S]*?closePocketPairing\(false\)/)
  assert.match(connections, /e\.key === 'Escape'\) closePocketPairing\(\)/)
  assert.match(pocket, /pocket-disconnect-confirm'\)\.addEventListener[\s\S]*?closePocketPairing\(false\)/)
})

test('Pocket status uses fixed copy and text-only DOM rendering', () => {
  assert.match(pocket, /replaceChildren\(\)/)
  assert.match(pocket, /document\.createElement\('strong'\)/)
  assert.match(pocket, /title\.textContent = view\.title/)
  assert.match(pocket, /detail\.textContent = view\.detail/)
  assert.doesNotMatch(pocket, /(?:innerHTML|outerHTML|insertAdjacentHTML)\s*(?:=|\()/)
  assert.doesNotMatch(pocket, /textContent\s*=\s*(?:errorMessage|status\.lastError)/)
  assert.match(pocket, /looksOffline\(status\.lastError\)/)
  assert.match(pocket, /Your changes are safe here\. Sync will try again\./)
})

test('Pocket controls are wired to their local API actions', () => {
  const actions = [
    ['connectButton', 'pair', '/api/pocket/pair'],
    ['syncButton', 'sync', '/api/pocket/sync'],
  ]
  for (const [button, action, path] of actions) {
    assert.match(pocket, new RegExp(`${button}\\.addEventListener\\('click',[\\s\\S]*?runAction\\('${action}', '${path}'\\)`))
  }
  assert.match(pocket, /pocket-disconnect-confirm'\)\.addEventListener[\s\S]*?runAction\('disconnect', '\/api\/pocket\/disconnect'\)/)
  assert.match(pocket, /export async function refreshPocket[\s\S]*?api\('\/api\/pocket'\)/)
  for (const id of ['pocket-connect', 'pocket-sync', 'pocket-disconnect', 'pocket-disconnect-confirm', 'pocket-disconnect-cancel']) {
    assert.match(html, new RegExp(`<button[^>]+id="${id}"`))
  }
})

test('Pocket settings and pairing dialog expose the required accessible markup', () => {
  assert.match(html, /<section class="pocket-settings"[^>]+aria-labelledby="pocket-title"/)
  assert.match(html, /id="pocket-status" role="status" aria-live="polite"/)
  assert.match(html, /id="pocket-confirm" hidden role="group" aria-label="Confirm disconnect"/)
  assert.match(html, /<section class="pocket-pairing"[^>]+role="dialog" aria-modal="true"[\s\S]*?aria-labelledby="pocket-pairing-title" aria-describedby="pocket-pairing-copy" tabindex="-1" hidden/)
  assert.match(html, /id="pocket-pairing-close" aria-label="Close phone pairing"/)
  assert.match(qrCode, /setAttribute\('role', 'img'\)/)
  assert.match(qrCode, /setAttribute\('aria-label', 'Scan to connect this phone to December'\)/)
  assert.match(connections, /if \(e\.key === 'Escape'\) closePocketPairing\(\)/)
  assert.match(connections, /else trapPocketFocus\(e\)/)
})

test('Pocket pairing stays within a 390px viewport', () => {
  assert.match(settingsCss, /@media \(max-width: 390px\)/)
  assert.match(settingsCss, /\.pocket-pairing \{ width: calc\(100vw - 24px\)/)
  assert.match(settingsCss, /\.pocket-qr \{ width: min\(232px, 72vw\)/)
  assert.match(settingsCss, /\.pocket-actions \{[^}]*flex-wrap: wrap/)
})
