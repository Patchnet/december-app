import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  Menu,
  nativeImage,
  shell,
  Tray,
} from 'electron'
import { DESKTOP_FALLBACK_PORT, DESKTOP_HOST, DESKTOP_PORT, isPortAvailable, selectDesktopPort } from './runtime.mjs'

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

function startServer(dataDir) {
  const appRoot = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  const entry = join(appRoot, 'server.mjs')
  serverProcess = spawn(process.execPath, [entry], {
    cwd: appRoot,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(desktopPort),
      DECEMBER_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', rememberOutput)
  serverProcess.stderr.on('data', rememberOutput)
  serverProcess.on('error', rememberOutput)
}

const firstRunUrl = () => `${baseUrl()}/?desktop=1`

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
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://') || target.startsWith('http://')) shell.openExternal(target)
    return { action: 'deny' }
  })
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
  let image = nativeImage.createFromPath(join(app.getAppPath(), 'electron', 'tray-icon.svg'))
  if (!image.isEmpty()) image = image.resize({ width: 18, height: 18 })
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
      const dataDir = join(app.getPath('userData'), 'data')
      const availability = await Promise.all(
        [DESKTOP_PORT, DESKTOP_FALLBACK_PORT].map(async (port) => [port, await isPortAvailable(port)])
      )
      desktopPort = selectDesktopPort(availability.filter(([, available]) => available).map(([port]) => port))
      startServer(dataDir)
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

app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  stopServer()
})

app.on('window-all-closed', () => {
  // The tray owns app lifetime. Quit is explicit from its menu.
})
