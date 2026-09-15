import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'

let playerWindow: BrowserWindow | null = null
/**
 * True while the window is closing *because* the user asked to dock it back.
 *
 * The window going away and the user wanting the player gone are different
 * things, and they arrive on the same `closed` event: pressing the dock button
 * means "put it back inside", pressing the title bar's X means "I am done with
 * it". Without this flag the main window cannot tell them apart, and docking
 * back leaves nothing on screen at all.
 */
let docking = false
let surfaceChanged: ((detached: boolean, docked: boolean) => void) | null = null

export function onScriptPlayerSurfaceChanged(
  listener: (detached: boolean, docked: boolean) => void
): void {
  surfaceChanged = listener
}

export function isScriptPlayerDetached(): boolean {
  return playerWindow !== null && !playerWindow.isDestroyed()
}

export function detachScriptPlayerWindow(): boolean {
  if (isScriptPlayerDetached()) {
    if (playerWindow!.isMinimized()) playerWindow!.restore()
    playerWindow!.show()
    playerWindow!.focus()
    return true
  }

  playerWindow = new BrowserWindow({
    width: 560,
    height: 760,
    minWidth: 460,
    minHeight: 560,
    show: false,
    title: 'Funscript Manager — Script Player',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#eef0f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })
  playerWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  playerWindow.once('ready-to-show', () => playerWindow?.show())
  playerWindow.once('closed', () => {
    playerWindow = null
    const docked = docking
    docking = false
    surfaceChanged?.(false, docked)
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    const url = new URL(rendererUrl)
    url.searchParams.set('scriptPlayerWindow', '1')
    void playerWindow.loadURL(url.toString())
  } else {
    void playerWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { scriptPlayerWindow: '1' }
    })
  }
  surfaceChanged?.(true, false)
  return true
}

/**
 * Take the window away because the app is going: not a docking, and not the
 * user being done with the player either. Nothing is left to tell.
 */
export function closeScriptPlayerWindow(): void {
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
  playerWindow = null
}

/** Dock the player back into the main window: close the separate one, and say why. */
export function attachScriptPlayerWindow(): boolean {
  if (playerWindow && !playerWindow.isDestroyed()) {
    docking = true
    playerWindow.close()
  }
  return false
}
