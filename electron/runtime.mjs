import { createServer } from 'node:net'

export const DESKTOP_HOST = '127.0.0.1'
export const DESKTOP_PORT = 3008
export const DESKTOP_FALLBACK_PORT = 3009

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
