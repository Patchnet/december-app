/** Packaged-app update policy. The Electron wiring lives in main.mjs. */

export function shouldCheckForUpdates({ packaged }) {
  return packaged === true
}

export function configureUpdater(updater) {
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = false
  updater.allowPrerelease = false
}

/** electron-updater emits `error` and also rejects this promise. The event is
    the one presentation path; absorb the duplicate rejection here. */
export async function requestUpdateCheck(updater) {
  try {
    return await updater.checkForUpdates()
  } catch {
    return null
  }
}

/** Launch checks stay quiet unless an update is already downloaded. */
export function shouldAnnounce({ source, kind }) {
  if (kind === 'downloaded') return true
  return source === 'manual' && (kind === 'not-available' || kind === 'error')
}

export function restartDialogOptions(version) {
  const label = version ? `December ${version}` : 'An update'
  return {
    type: 'info',
    title: 'Update ready',
    message: `${label} is ready.`,
    detail: 'Restart to install it. Your page stays where it is.',
    buttons: ['Restart', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }
}

export function upToDateDialogOptions(version) {
  return {
    type: 'info',
    title: 'December',
    message: version ? `You're on ${version}.` : "You're up to date.",
    detail: 'No update to install.',
    buttons: ['OK'],
  }
}

export function updateFailedDialogOptions(error) {
  return {
    type: 'warning',
    title: 'Could not update',
    message: 'December could not check for an update.',
    detail: String(error?.message || error || 'update failed').slice(0, 240),
    buttons: ['OK'],
  }
}
