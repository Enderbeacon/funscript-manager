import { BrowserWindow, app } from 'electron'
import { registerIpcHandlers } from './ipc/handlers'
import { getSettings } from './services/config/config-service'
import { disposeAllLibraries } from './services/library/library-manager'
import { registerDownloaderPlugins } from './services/downloaders/register'
import { dispose as disposeDownloads, init as initDownloads } from './services/downloaders/queue'
import { disposePlayback, initPlayback } from './services/playback/playback-service'
import { disposeMediaSources } from './services/playback/sources/registry'
import { disposeVideoStreams } from './services/playback/internal/stream'
import { startConnStatusPolling, stopConnStatusPolling } from './services/playback/conn-status'
import { createMainWindow, rememberCloseChoice, showMainWindow } from './services/main-window'
import { registerMediaProtocol, registerMediaScheme } from './services/media-protocol'
import { runStartup } from './services/startup/startup'
import { focusCard } from './services/startup/splash-window'
import { disposeStartupArtworkPreparation } from './services/startup/artwork-pool'
import { disposeScriptPlayer } from '@script-player/composition/session'
import { applyPendingOnQuit, runUpdaterStartup } from './services/updates/updater'
import { openVrPanelPreview } from './services/vr/preview-window'

/**
 * Main process entry. Startup order:
 * 0. The updater's own hook — when it starts the app to finish an install or
 *    uninstall, that is all this run does
 * 1. IPC handlers and the media protocol
 * 2. App settings, which decide what the startup card looks like
 * 3. The startup sequence (startup.ts): the card, the proxy, the release
 *    check, the libraries, and the window once it has drawn something
 * 4. Behind the finished window: the player list and the download queue
 */

runUpdaterStartup()

// Packaged builds get this from electron-builder. Development runs through
// electron.exe instead, so give Windows the same stable identity explicitly.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.funscriptmanager.desktop')
}

// Test/dev hook: e2e smokes point this at a scratch directory so they never
// touch the real profile (also isolates the single-instance lock below).
const userDataOverride = process.env['FSMGR_USER_DATA']
if (userDataOverride) {
  app.setPath('userData', userDataOverride)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

// Privileged-scheme registration must happen before app `ready`.
registerMediaScheme()

app.whenReady().then(async () => {
  registerIpcHandlers()
  registerMediaProtocol()
  // Cheap local read; decides the card's theme and language, and the window's
  // background color.
  const settings = await getSettings().catch(() => null)
  // What closing the main window does to a detached player, where the close
  // handler can read it without going to disk.
  rememberCloseChoice(settings?.ui.onCloseMainWindow ?? 'ask')

  // Starting the app again brings forward whatever stands for it: the startup
  // card while it is still getting ready, otherwise the main window — which is
  // built again when the user closed it and kept a player window running.
  app.on('second-instance', () => {
    if (!focusCard()) void showMainWindow()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(settings?.ui.theme ?? 'system')
    }
  })

  await runStartup(settings)
  if (!app.isPackaged && process.env['FSMGR_VR_PREVIEW']) openVrPanelPreview()

  // Behind the finished window from here: nothing below has to exist before
  // the user can work, and the downloads resume after the libraries are known
  // so a resumed job's target library can be resolved.
  startConnStatusPolling()
  void initPlayback().catch((e) => console.error('[playback] startup failed:', e))
  registerDownloaderPlugins()
  void initDownloads().catch((e) => console.error('[downloads] startup failed:', e))
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', (event) => {
  // Flush watchers/workers/db handles once, then continue quitting.
  event.preventDefault()
  // Hands a downloaded update to the updater, which waits for this exit.
  applyPendingOnQuit()
  stopConnStatusPolling()
  disposePlayback()
  disposeVideoStreams()
  disposeDownloads()
  void Promise.all([
    disposeStartupArtworkPreparation(),
    disposeAllLibraries(),
    disposeScriptPlayer(),
    disposeMediaSources()
  ]).finally(() => app.exit(0))
})
