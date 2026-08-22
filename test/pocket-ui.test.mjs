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
const server = read('server.mjs')
const desktop = read('electron/main.mjs')

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

test('every Pocket action carries the capability the page alone can read', () => {
  assert.match(pocket, /fetch\('\/api\/pocket\/capability'\)/)
  assert.match(pocket, /'x-december-capability': capability \|\| ''/)
  assert.match(pocket, /if \(response\.status === 403\) \{\s+await claimCapability\(\)/)
  // Every acting route goes through the capability wrapper, never bare api().
  assert.match(pocket, /const response = await pocketPost\(path\)/)
  assert.doesNotMatch(pocket, /api\('\/api\/pocket\/(?:pair|rotate|sync|disconnect|revoke)'/)
  // The capability is never written down anywhere it could outlive the run.
  assert.doesNotMatch(pocket, /(?:localStorage|sessionStorage|document\.cookie)/)
})

test('replacing a phone rotates the key instead of adding a second device', () => {
  assert.match(pocket, /connectButton\.addEventListener\('click',[\s\S]*?runAction\('pair', '\/api\/pocket\/rotate'\)/)
  assert.match(pocket, /const replacing = !!status\?\.paired \|\| !!status\?\.requiresRepair/)
  assert.match(pocket, /connectButton\.textContent = action === 'pair' \? 'Connecting…' : \(paired \|\| repairing\) \? 'Replace phone' : 'Connect phone'/)
  assert.match(pocket, /disconnectButton\.hidden = !\(paired \|\| repairing\)/)
})

test('Pocket says plainly when this computer has no key store, and stays out of the way', () => {
  assert.match(pocket, /status\?\.secretsPersisted === false/)
  assert.match(pocket, /Pocket is unavailable on this computer/)
  assert.match(pocket, /There is no secure key store here, so December will not save a phone connection\. Everything else works\./)
  assert.match(pocket, /Reconnect your phone/)
  assert.match(pocket, /December will finish deleting the relay copy when it can reach it\./)
})

test('the local server refuses anything that is not December reaching itself', () => {
  // Loopback name and our own port; a name pointed at some other port is
  // another server borrowing these answers.
  assert.match(server, /if \(!LOCAL_HOSTS\.has\(parsed\.hostname\)\) return true\s+return parsed\.port !== '' && parsed\.port !== String\(port\)/)
  assert.match(server, /const OWN_FETCH_SITES = new Set\(\['same-origin', 'none'\]\)/)
  assert.match(server, /if \(foreignFetchSite\(req\.headers\)\) \{/)
  // Acting on Pocket needs the capability; plain status does not.
  assert.match(server, /path\.startsWith\('\/api\/pocket\/'\) && req\.method === 'POST' && !capabilityMatches\(req\.headers\['x-december-capability'\]\)/)
  assert.match(server, /const POCKET_CAPABILITY = randomBytes\(32\)\.toString\('base64url'\)/)
  assert.match(server, /timingSafeEqual/)
  assert.match(server, /path === '\/api\/pocket\/rotate' && req\.method === 'POST'/)
  assert.match(server, /path === '\/api\/pocket\/disconnect' && req\.method === 'POST'\) \{\s+return json\(res, 200, await pocket\.revoke\(\)\)/)
})

test('every answer carries the same refusals, and the page carries a computed policy', () => {
  for (const header of [
    "'x-content-type-options': 'nosniff'",
    "'referrer-policy': 'no-referrer'",
    "'cross-origin-opener-policy': 'same-origin'",
    "'cross-origin-resource-policy': 'same-origin'",
    "'x-frame-options': 'DENY'",
  ]) {
    assert.ok(server.includes(header), `server is missing ${header}`)
  }
  for (const directive of [
    "default-src 'none'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(server.includes(directive), `content security policy is missing ${directive}`)
  }
  // Inline scripts are allowed by hash, so an injected one is still refused.
  assert.match(server, /sha256-\$\{createHash\('sha256'\)\.update\(match\[1\], 'utf8'\)\.digest\('base64'\)\}/)
  assert.match(server, /headers\['content-security-policy'\] = contentSecurityPolicy/)
  assert.doesNotMatch(server, /script-src[^;\n]*'unsafe-inline'/)
  assert.doesNotMatch(server, /script-src[^;\n]*'unsafe-eval'/)
})

test('the desktop shell wraps the Pocket key and pins the window to December', () => {
  assert.match(desktop, /const pocketSecret = await preparePocketSecret\(\{ userDataDir: app\.getPath\('userData'\), safeStorage \}\)/)
  assert.match(desktop, /DECEMBER_POCKET_SECRET_BACKEND: pocketSecret\.backend/)
  assert.match(desktop, /if \(pocketSecret\.key\) env\.DECEMBER_POCKET_SECRET_KEY = pocketSecret\.key\s+else delete env\.DECEMBER_POCKET_SECRET_KEY/)
  assert.match(desktop, /app\.on\('web-contents-created', \(_event, contents\) => guardContents\(contents\)\)/)
  for (const guard of ['will-navigate', 'will-redirect', 'will-attach-webview']) {
    assert.ok(desktop.includes(`contents.on('${guard}'`), `desktop is missing the ${guard} guard`)
  }
  assert.match(desktop, /setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/)
  assert.match(desktop, /setPermissionCheckHandler\(\(\) => false\)/)
  for (const preference of ['webviewTag: false', 'nodeIntegrationInSubFrames: false', 'allowRunningInsecureContent: false', 'sandbox: true']) {
    assert.ok(desktop.includes(preference), `desktop is missing ${preference}`)
  }
})
