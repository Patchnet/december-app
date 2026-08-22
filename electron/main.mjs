import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  safeStorage,
  session,
  shell,
  Tray,
} from 'electron'
import {
  DESKTOP_FALLBACK_PORT,
  DESKTOP_HOST,
  DESKTOP_PORT,
  isPortAvailable,
  navigationDecision,
  preparePocketSecret,
  selectDesktopPort,
} from './runtime.mjs'

app.setName('December')

const lock = app.requestSingleInstanceLock()
if (!lock) app.quit()

let mainWindow = null
let tray = null
let serverProcess = null
let quitting = false
let serverOutput = ''
let desktopPort = DESKTOP_PORT
const baseUrl = () => `http://${DESKTOP_HOST}:${desktopPort}`

const rememberOutput = (chunk) => {
  serverOutput = (serverOutput + String(chunk)).slice(-2000)
}

function showMain({ capture = false } = {}) {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (capture) {
    mainWindow.webContents.executeJavaScript("document.querySelector('#capture')?.focus()", true).catch(() => {})
  }
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return
  serverProcess.kill('SIGTERM')
  serverProcess = null
}

async function waitForServer(timeoutMs = 20000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (!serverProcess || serverProcess.exitCode !== null) {
      throw new Error(`December's local server stopped during startup.\n\n${serverOutput.trim()}`)
    }
    try {
      const response = await fetch(`${baseUrl()}/api/health`)
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`December's local server did not become ready.\n\n${serverOutput.trim()}`)
}

function startServer(dataDir, pocketSecret) {
  const appRoot = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  const entry = join(appRoot, 'server.mjs')
  // The Pocket key travels in the child's environment and nowhere else. On a
  // computer with no key store there is no key to pass, and the server is
  // told so plainly rather than left to guess.
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(desktopPort),
    DECEMBER_DATA_DIR: dataDir,
    DECEMBER_POCKET_SECRET_BACKEND: pocketSecret.backend,
  }
  if (pocketSecret.key) env.DECEMBER_POCKET_SECRET_KEY = pocketSecret.key
  else delete env.DECEMBER_POCKET_SECRET_KEY
  serverProcess = spawn(process.execPath, [entry], {
    cwd: appRoot,
    windowsHide: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', rememberOutput)
  serverProcess.stderr.on('data', rememberOutput)
  serverProcess.on('error', rememberOutput)
}

const firstRunUrl = () => `${baseUrl()}/?desktop=1`

// December's window is December's page. Everything that would take it
// somewhere else is refused; a plain https link opens in the real browser,
// where the person can see the address bar. Nothing gets a second window,
// a webview, or a device permission.
function guardContents(contents) {
  const origin = baseUrl()
  contents.setWindowOpenHandler(({ url: target }) => {
    if (navigationDecision(target, origin) === 'external') shell.openExternal(target)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, target) => {
    if (navigationDecision(target, origin) !== 'allow') {
      event.preventDefault()
      if (navigationDecision(target, origin) === 'external') shell.openExternal(target)
    }
  })
  contents.on('will-redirect', (event, target) => {
    if (navigationDecision(target, origin) !== 'allow') event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

function hardenSession() {
  const permissions = session.defaultSession
  permissions.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  permissions.setPermissionCheckHandler(() => false)
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      sandbox: true,
    },
  })
  // The window's own contents are guarded by the app-level hook below,
  // which fires while this constructor is still running.
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.loadURL(url)
}

function createTray() {
  // Windows: multi-size .ico (16/20/24/32) picks the right DPI layer.
  // macOS: template image, recolored by the menu bar automatically.
  const file = process.platform === 'darwin' ? join('icons', 'trayTemplate.png') : join('icons', 'tray.ico')
  const image = nativeImage.createFromPath(join(app.getAppPath(), 'electron', file))
  tray = new Tray(image)
  tray.setToolTip('December')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open December', click: () => showMain() },
    { label: 'Capture', accelerator: 'CommandOrControl+Alt+D', click: () => showMain({ capture: true }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', () => showMain())
}

if (lock) {
  app.on('second-instance', () => showMain())
  app.whenReady().then(async () => {
    try {
      hardenSession()
      const dataDir = join(app.getPath('userData'), 'data')
      const pocketSecret = await preparePocketSecret({ userDataDir: app.getPath('userData'), safeStorage })
      const availability = await Promise.all(
        [DESKTOP_PORT, DESKTOP_FALLBACK_PORT].map(async (port) => [port, await isPortAvailable(port)])
      )
      desktopPort = selectDesktopPort(availability.filter(([, available]) => available).map(([port]) => port))
      startServer(dataDir, pocketSecret)
      await waitForServer()
      createWindow(firstRunUrl())
      createTray()
      const registered = globalShortcut.register('CommandOrControl+Alt+D', () => showMain({ capture: true }))
      if (!registered) {
        dialog.showMessageBox({
          type: 'warning',
          title: 'Capture shortcut unavailable',
          message: 'December is running, but Ctrl+Alt+D is already used by another app.',
          detail: 'Use Capture from the tray menu instead.',
        })
      }
    } catch (error) {
      dialog.showErrorBox('December could not start', String(error.message || error))
      quitting = true
      app.quit()
    }
  })
}

// Any contents December did not build itself still answers to the same rule.
app.on('web-contents-created', (_event, contents) => guardContents(contents))

app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  stopServer()
})

app.on('window-all-closed', () => {
  // The tray owns app lifetime. Quit is explicit from its menu.
})
