import { join } from 'node:path'
import { BrowserWindow, app, nativeTheme, shell } from 'electron'
import type { Settings } from '@shared/schemas/app-config'
import { closeScriptPlayerWindow, isScriptPlayerDetached } from '@script-player/infrastructure/window/script-player-window'
import { broadcast } from '../ipc/register'
import { getSettings } from './config/config-service'
import { closeVideoPlayerWindow, isVideoPlayerDetached } from './playback/internal/player-window'

/**
 * The main window, and what happens to the other windows when it closes.
 *
 * Closing it used to be the end of everything: the detached picture was
 * destroyed with it, and the detached script player was left holding the
 * process open with no way back to the app. Neither is a decision this code
 * should be making on its own — someone watching a video in the popped-out
 * player is not asking for it to vanish because they tidied the library window
 * away — so it asks, and remembers the answer if told to.
 */

type CloseChoice = Settings['ui']['onCloseMainWindow']
type Theme = Settings['ui']['theme']

let mainWindow: BrowserWindow | null = null

/**
 * What to do about the detached players, read from the settings.
 *
 * Held here rather than read when needed: `close` has to decide there and
 * then, and reading a file is not something that can happen inside it.
 */
let closeChoice: CloseChoice = 'ask'

/** The user has answered; the close that follows goes straight through. */
let answered = false

/** The app is on its way out anyway, so there is nothing left to ask about. */
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

/** Whether a theme setting lands on the dark palette right now. */
export function isDarkTheme(theme: Theme): boolean {
  return theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
}

/** Pre-paint window background; values mirror --bg-page in themes.css. */
export function windowBackground(theme: Theme): string {
  return isDarkTheme(theme) ? '#0b0d12' : '#eef0f7'
}

/** Window-control colors to match; mirrors --text-primary in themes.css. */
function controlColor(theme: Theme): string {
  const dark = theme === 'system' ? nativeTheme.shouldUseDarkColors : theme === 'dark'
  return dark ? '#f2f4f8' : '#161a24'
}

/*
 * The system buttons sit on the app's own top bar, which is glass over a
 * coloured backdrop — no flat colour matches it, so the overlay paints nothing
 * and lets the bar itself show through. Only the symbols are ours to colour.
 */
const OVERLAY_BACKGROUND = '#00000000'

/** Height of the app's own top bar; the overlay has to line up with it. */
const TITLEBAR_HEIGHT = 40

export function isMainWindowOpen(): boolean {
  return mainWindow !== null && !mainWindow.isDestroyed()
}

/** Keep the setting where `close` can reach it. Called on startup and on save. */
export function rememberCloseChoice(choice: CloseChoice): void {
  closeChoice = choice
}

function anyPlayerDetached(): boolean {
  return isVideoPlayerDetached() || isScriptPlayerDetached()
}

function closeDetachedPlayers(): void {
  closeVideoPlayerWindow()
  closeScriptPlayerWindow()
}

/**
 * The answer to the question, from the dialog in the renderer.
 *
 * Cancelling never gets here: the window was already told to stay by the
 * `preventDefault` that put the question on screen.
 */
export function resolveMainWindowClose(closePlayers: boolean): void {
  if (closePlayers) closeDetachedPlayers()
  answered = true
  mainWindow?.close()
}

/**
 * Build the main window. `show` is false during startup: the window loads
 * behind the startup card and is revealed once it has drawn something.
 */
export function createMainWindow(theme: Theme, show = true): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: windowBackground(theme),
    autoHideMenuBar: true,
    // In production Windows uses the icon embedded in the packaged EXE. In
    // development the executable is Electron's, so the window needs our icon
    // explicitly or the taskbar falls back to Electron's logo.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.ico') }),
    /*
     * The native title bar is a grey strip that has nothing to do with the rest
     * of the window. Hidden, with only the system buttons overlaid, the app's
     * own top bar runs to the edge — and the buttons stay real, which a fully
     * frameless window would have cost.
     */
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: OVERLAY_BACKGROUND,
      symbolColor: controlColor(theme),
      height: TITLEBAR_HEIGHT
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (show) revealMainWindow()
  })

  /**
   * With a player in a window of its own, closing this one is a question.
   *
   * Nothing detached means nothing to ask: closing the main window is closing
   * the app, the way it always was.
   */
  mainWindow.on('close', (event) => {
    if (answered || quitting || !anyPlayerDetached()) return
    if (closeChoice === 'closePlayers') {
      closeDetachedPlayers()
      return
    }
    if (closeChoice === 'keepPlayers') return
    event.preventDefault()
    broadcast('event:confirm-close', {
      video: isVideoPlayerDetached(),
      script: isScriptPlayerDetached()
    })
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    answered = false
    // The detached players are on their own now, and their button back to the
    // app is the only one there is.
    broadcast('event:main-window', { open: false })
  })

  // External links always open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Put the window on screen, and tell whoever was waiting for it. */
export function revealMainWindow(): void {
  if (!isMainWindowOpen() || mainWindow!.isVisible()) return
  mainWindow!.show()
  broadcast('event:main-window', { open: true })
}

/** Out of sight without closing: the app is quitting to install an update. */
export function hideMainWindow(): void {
  if (isMainWindowOpen()) mainWindow!.hide()
}

/**
 * Put the main window in front, building it again if it is gone.
 *
 * Gone is an ordinary state now: the user closed it and kept a player running.
 * Starting the app a second time and the button in the player window both come
 * through here.
 */
export async function showMainWindow(): Promise<void> {
  if (isMainWindowOpen()) {
    if (mainWindow!.isMinimized()) mainWindow!.restore()
    mainWindow!.show()
    mainWindow!.focus()
    return
  }
  const settings = await getSettings().catch(() => null)
  createMainWindow(settings?.ui.theme ?? 'system')
}
