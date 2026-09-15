import { BrowserWindow, app } from 'electron'
import { registerIpcHandlers } from './ipc/handlers'
import { getSettings, listLibraries } from './services/config/config-service'
import {
  disposeAllLibraries,
  markLibrariesReady,
  startAllLibraries
} from './services/library/library-manager'
import { registerDownloaderPlugins } from './services/downloaders/register'
import { dispose as disposeDownloads, init as initDownloads } from './services/downloaders/queue'
import { disposePlayback, initPlayback } from './services/playback/playback-service'
import { disposeMediaSources } from './services/playback/sources/registry'
import { startConnStatusPolling, stopConnStatusPolling } from './services/playback/conn-status'
import { createMainWindow, rememberCloseChoice, showMainWindow } from './services/main-window'
import { registerMediaProtocol, registerMediaScheme } from './services/media-protocol'
import { applyProxySettings } from './services/net/proxy'
import { disposeScriptPlayer } from '@script-player/composition/session'
import {
  applyPendingOnQuit,
  initUpdates,
  runUpdaterStartup
} from './services/updates/updater'

/**
 * Main process entry. Startup order:
 * 0. The updater's own hook — when it starts the app to finish an install or
 *    uninstall, that is all this run does
 * 1. IPC handlers and the media protocol
 * 2. App settings and the proxy, before anything touches the network
 * 3. The main window — it opens without waiting for the libraries
 * 4. In the background: each library's index sync and watcher, the player
 *    list, and the download queue (after the libraries, so a resumed job's
 *    target library can be resolved)
 */

runUpdaterStartup()

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
  // Cheap local read; lets the window open with the right background color.
  const settings = await getSettings().catch(() => null)
  // Before anything reaches the network: the forum, the libraries and the
  // download queue below all go out through whatever this puts in place.
  await applyProxySettings().catch((e) => console.error('[proxy] setup failed:', e))
  // What closing the main window does to a detached player, where the close
  // handler can read it without going to disk.
  rememberCloseChoice(settings?.ui.onCloseMainWindow ?? 'ask')
  createMainWindow(settings?.ui.theme ?? 'system')

  // Background incremental index sync; a large library must not hold up the window.
  void listLibraries()
    .then((libraries) => startAllLibraries(libraries))
    .catch((e) => {
      console.error('[library] startup sync failed:', e)
      // Whoever is waiting for the libraries waits forever otherwise.
      markLibrariesReady()
    })

  startConnStatusPolling()

  void initUpdates(settings)

  // The player list, and the auto-connect scan for the ones marked for it.
  void initPlayback().catch((e) => console.error('[playback] startup failed:', e))

  // Downloads resume after the libraries are known: a job's target library
  // has to resolve before anything can be moved into it.
  registerDownloaderPlugins()
  void initDownloads().catch((e) => console.error('[downloads] startup failed:', e))

  // Starting the app again brings the main window forward — and builds it
  // again when the user closed it and kept a player window running.
  app.on('second-instance', () => {
    void showMainWindow()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(settings?.ui.theme ?? 'system')
    }
  })
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
  disposeDownloads()
  void Promise.all([disposeAllLibraries(), disposeScriptPlayer(), disposeMediaSources()]).finally(
    () => app.exit(0)
  )
})
