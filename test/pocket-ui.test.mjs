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

test('the sensitive pairing URL and human code are separated from status and cleared on every exit path', () => {
  assert.match(pocket, /const \{ pairingUrl: sensitiveUrl, pairingCode: sensitiveCode, \.\.\.safeStatus \} = response\s+status = safeStatus/)
  assert.match(pocket, /function forgetPairingSecrets\(\) \{[\s\S]*?pairingUrl = null[\s\S]*?pairingCode = null[\s\S]*?pairingExpiresAt = null[\s\S]*?qr\.replaceChildren\(\)[\s\S]*?pairingCodeOutput\.textContent = ''/)
  assert.match(pocket, /export function closePocketPairing[\s\S]*?pairingRequest\+\+[\s\S]*?forgetPairingSecrets\(\)/)
  assert.match(pocket, /async function executePairing[\s\S]*?forgetPairingSecrets\(\)[\s\S]*?request !== pairingRequest[\s\S]*?forgetPairingSecrets\(\)/)
  assert.match(pocket, /function openPairing[\s\S]*?catch \(error\) \{[\s\S]*?forgetPairingSecrets\(\)/)
  assert.match(pocket, /This pairing code has expired[\s\S]*?pairingRetryButton\.hidden = false/)
  assert.match(pocket, /pocket-pairing-close'\)\.addEventListener\('click', \(\) => closePocketPairing\(\)\)/)
  assert.match(pocket, /pagehide', \(\) => closePocketPairing\(false\)/)
  assert.match(connections, /function closeSettings[\s\S]*?closePocketPairing\(false\)/)
  assert.match(connections, /e\.key === 'Escape'\) closePocketPairing\(\)/)
  assert.match(pocket, /confirmButton\.addEventListener[\s\S]*?intent\?\.name === 'disconnect'\) closePocketPairing\(false\)/)
  assert.doesNotMatch(pocket, /(?:localStorage|sessionStorage|document\.cookie|navigator\.clipboard)/)
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
  for (const [name, path] of [
    ['connect', '/api/pocket/pair'],
    ['reconnect', '/api/pocket/rotate'],
    ['move', '/api/pocket/rotate'],
    ['lost', '/api/pocket/rotate'],
    ['sync', '/api/pocket/sync'],
    ['disconnect', '/api/pocket/disconnect'],
  ]) {
    assert.match(pocket, new RegExp(`${name}: \\{[\\s\\S]*?path: '${path.replaceAll('/', '\\/')}'`))
  }
  assert.match(pocket, /export async function refreshPocket[\s\S]*?api\('\/api\/pocket'\)/)
  for (const id of ['pocket-connect', 'pocket-reconnect', 'pocket-move', 'pocket-lost', 'pocket-sync', 'pocket-disconnect', 'pocket-retry', 'pocket-disconnect-confirm', 'pocket-disconnect-cancel']) {
    assert.match(html, new RegExp(`<button[^>]+id="${id}"`))
  }
})

test('Pocket settings and pairing dialog expose the required accessible markup', () => {
  assert.match(html, /<section class="pocket-settings"[^>]+aria-labelledby="pocket-title"/)
  assert.match(html, /id="pocket-status" role="status" aria-live="polite"/)
  assert.match(html, /id="pocket-confirm" hidden role="group" aria-labelledby="pocket-confirm-copy"/)
  assert.match(html, /<section class="pocket-pairing"[^>]+role="dialog" aria-modal="true"[\s\S]*?aria-labelledby="pocket-pairing-title" aria-describedby="pocket-pairing-copy" tabindex="-1" hidden/)
  assert.match(html, /id="pocket-pairing-close" aria-label="Close phone pairing"/)
  assert.match(html, /href="https:\/\/app\.getdecember\.me"/)
  assert.match(html, /Choose <strong>Add to Home Screen<\/strong> or <strong>Install app<\/strong>/)
  assert.match(html, /id="pocket-pairing-begin">The installed app is open/)
  assert.match(html, /id="pocket-pairing-code" aria-label="Pairing recovery code"/)
  assert.match(html, /id="pocket-pairing-expiry" aria-live="off"/)
  assert.match(pocket, /pairingExpiryOutput\.setAttribute\('role', 'status'\)[\s\S]*?pairingExpiryOutput\.setAttribute\('aria-live', 'polite'\)/)
  assert.match(html, /The relay cannot read your page/)
  assert.match(qrCode, /setAttribute\('role', 'img'\)/)
  assert.match(qrCode, /setAttribute\('aria-label', 'Scan to connect this phone to December'\)/)
  assert.match(connections, /if \(e\.key === 'Escape'\) closePocketPairing\(\)/)
  assert.match(connections, /else trapPocketFocus\(e\)/)
})

test('Pocket pairing stays within a 390px viewport', () => {
  assert.match(settingsCss, /@media \(max-width: 390px\)/)
  assert.match(settingsCss, /\.pocket-pairing \{ width: calc\(100vw - 24px\)/)
  assert.match(settingsCss, /\.pocket-qr \{ width: min\(220px, 66vw\)/)
  assert.match(settingsCss, /\.pocket-pairing-code \{ font-size: 14px/)
  assert.match(settingsCss, /\.pocket-actions \{[^}]*flex-wrap: wrap/)
})

test('every Pocket action carries the capability the page alone can read', () => {
  assert.match(pocket, /fetch\('\/api\/pocket\/capability'\)/)
  assert.match(pocket, /'x-december-capability': capability \|\| ''/)
  assert.match(pocket, /if \(response\.status === 403\) \{\s+await claimCapability\(\)/)
  // Every acting route goes through the capability wrapper, never bare api().
  assert.match(pocket, /const response = await pocketPost\(intent\.path, intent\.body\)/)
  assert.doesNotMatch(pocket, /api\('\/api\/pocket\/(?:pair|rotate|sync|disconnect|revoke)'/)
  // The capability is never written down anywhere it could outlive the run.
  assert.doesNotMatch(pocket, /(?:localStorage|sessionStorage|document\.cookie)/)
})

test('phone repair, movement, and loss are distinct confirmed actions', () => {
  assert.match(pocket, /reconnect:[\s\S]*?reason: 'protocol-repair'[\s\S]*?confirmCopy:/)
  assert.match(pocket, /Create a fresh pairing code\? This repairs Pocket security and replaces the old phone connection\./)
  assert.match(pocket, /confirmLabel: 'Create fresh code'/)
  assert.match(pocket, /move:[\s\S]*?reason: 'move-device'[\s\S]*?stays connected until the new phone claims the connection when that is safe/i)
  assert.match(pocket, /lost:[\s\S]*?reason: 'lost-phone'[\s\S]*?immediately revokes that phone and rotates the encryption key/)
  assert.match(pocket, /reconnectButton\.addEventListener\('click', \(\) => showConfirmation\(intents\.reconnect\)\)/)
  assert.match(pocket, /moveButton\.addEventListener\('click', \(\) => showConfirmation\(intents\.move\)\)/)
  assert.match(pocket, /lostButton\.addEventListener\('click', \(\) => showConfirmation\(intents\.lost\)\)/)
  assert.doesNotMatch(pocket, /Replace phone/)
  assert.match(pocket, /title: 'Reconnect phone'/)
  assert.doesNotMatch(pocket, /confirmLabel: 'Reconnect phone'/)
  assert.match(pocket, /const confirming = pendingIntent !== null/)
  assert.match(pocket, /reconnectButton\.hidden = !usable \|\| !repairing \|\| confirming/)
})

test('every request has progress, fixed failure copy, and an actionable retry', () => {
  for (const action of ['pair', 'reconnect', 'move', 'lost', 'sync', 'disconnect', 'refresh']) {
    assert.match(pocket, new RegExp(`action === '${action}'`))
  }
  assert.match(pocket, /errorMessage[\s\S]*?December could not finish that request\. Retry when you are ready\./)
  assert.match(pocket, /lastFailedIntent = intent/)
  assert.match(pocket, /retryButton\.addEventListener\('click', \(\) => executeIntent\(lastFailedIntent\)\)/)
  assert.match(pocket, /pairingRetryButton\.addEventListener[\s\S]*?executePairing\(intent\)/)
  assert.doesNotMatch(pocket, /textContent\s*=\s*(?:errorMessage|status\.lastError)/)
})

test('Pocket uses paired-device language and states the phone outcome', () => {
  const pocketMarkup = html.slice(html.indexOf('<section class="pocket-settings"'), html.indexOf('<section class="connection-settings"'))
  assert.match(pocketMarkup, /Access your December page from your phone\. View the current page and send notes back to this computer\./)
  assert.doesNotMatch(pocketMarkup, /account|sign[ -]?in/i)
  assert.match(pocket, /No phone paired/)
  assert.match(pocket, /Phone paired/)
  assert.match(pocket, /Waiting for your phone/)
  assert.match(pocket, /\/api\/pocket\/pairing-status/)
  assert.match(pocket, /Reconnect this paired device with a fresh code/)
  assert.match(pocket, /Connect your phone again/)
  assert.match(pocket, /December repaired an incomplete Pocket upgrade\. Create a fresh code to reconnect\./)
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
