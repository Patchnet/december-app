import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const DESKTOP_HOST = '127.0.0.1'
export const DESKTOP_PORT = 3008
export const DESKTOP_FALLBACK_PORT = 3009

// The file that holds December's Pocket key, wrapped by whatever the
// operating system offers: DPAPI on Windows, the Keychain on macOS,
// libsecret or KWallet on Linux.
export const POCKET_KEY_FILE = 'pocket-master.key'
const defaultFiles = { mkdir, readFile, rename, rm, writeFile }

// Chromium's safeStorage will happily "encrypt" with a hardcoded key when a
// Linux session has no keyring. That is obfuscation, not protection, and it
// reports itself as basic_text. December treats basic_text — and the equally
// unpromising unknown — as no key store at all.
export function pocketSecretBackend({ platform = process.platform, safeStorage } = {}) {
  try {
    if (!safeStorage?.isEncryptionAvailable?.()) return 'basic_text'
    if (platform !== 'linux') return 'os'
    const selected = safeStorage.getSelectedStorageBackend?.() || 'unknown'
    return selected === 'basic_text' || selected === 'unknown' ? 'basic_text' : 'os'
  } catch {
    return 'basic_text'
  }
}

// The local server runs as its own process, so it cannot reach safeStorage
// directly. The shell unwraps one long-lived key here and hands it over in
// the child's environment; that key is what seals the Pocket credentials and
// content key on disk. Nothing sensitive is written when there is no key
// store — December stays fully usable, Pocket simply will not pair.
export async function preparePocketSecret({
  userDataDir,
  safeStorage,
  platform = process.platform,
  files = defaultFiles,
  newKey = () => randomBytes(32),
} = {}) {
  const file = join(userDataDir, POCKET_KEY_FILE)
  const backend = pocketSecretBackend({ platform, safeStorage })
  if (backend !== 'os') {
    await files.rm(file, { force: true }).catch(() => {})
    return { backend: 'basic_text', key: null }
  }
  try {
    const stored = await files.readFile(file)
    const key = Buffer.from(safeStorage.decryptString(stored), 'base64url')
    if (key.length === 32) return { backend: 'os', key: key.toString('base64url') }
  } catch (error) {
    if (error?.code && error.code !== 'ENOENT') return { backend: 'basic_text', key: null }
  }
  try {
    const key = newKey()
    const sealed = safeStorage.encryptString(key.toString('base64url'))
    await files.mkdir(userDataDir, { recursive: true })
    const temporary = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.writing`
    await files.writeFile(temporary, sealed, { mode: 0o600 })
    await files.rename(temporary, file)
    return { backend: 'os', key: key.toString('base64url') }
  } catch {
    // A keychain that refuses at the last moment is still a missing keychain.
    return { backend: 'basic_text', key: null }
  }
}

// The window only ever shows December's own loopback origin. Anything else —
// a redirect, an injected link, a drag-and-dropped file — is refused inside
// the window and, when it is plain web, handed to the real browser instead.
export function navigationDecision(target, origin) {
  let url
  try {
    url = new URL(target)
  } catch {
    return 'block'
  }
  if (url.origin === origin) return 'allow'
  if (url.protocol === 'https:') return 'external'
  return 'block'
}

export function selectDesktopPort(availablePorts, candidates = [DESKTOP_PORT, DESKTOP_FALLBACK_PORT]) {
  for (const port of candidates) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid desktop port: ${port}`)
    if (availablePorts.includes(port)) return port
  }
  throw new Error(
    `December cannot start because ${candidates.map((port) => `${DESKTOP_HOST}:${port}`).join(' and ')} are already in use. ` +
    'Close the other December or development server, then open the app again.'
  )
}

export function isPortAvailable(port = DESKTOP_PORT, host = DESKTOP_HOST) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', (error) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    probe.listen(port, host, () => probe.close(() => resolve(true)))
  })
}
