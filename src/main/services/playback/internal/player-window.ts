import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'

/**
 * The picture in a window of its own.
 *
 * Same arrangement as the script player's detached window: one session in the
 * main process, and the window is a second view of it. The difference is what
 * moving costs — the `<video>` element cannot travel between windows, so it is
 * torn down here and rebuilt there, and the new one catches up by reading the
 * playback intent (see `surface.ts`).
 */

let playerWindow: BrowserWindow | null = null
/**
 * True while the window is closing *because* the user asked to dock it back.
 *
 * Docking back and being done with the picture arrive on the same `closed`
 * event, and they mean opposite things: one puts the picture back in the main
 * window, the other leaves nothing on screen.
 */
let docking = false
let surfaceChanged: ((detached: boolean, docked: boolean) => void) | null = null

export function onVideoPlayerSurfaceChanged(
  listener: (detached: boolean, docked: boolean) => void
): void {
  surfaceChanged = listener
}

export function isVideoPlayerDetached(): boolean {
  return playerWindow !== null && !playerWindow.isDestroyed()
}

export function detachVideoPlayerWindow(): boolean {
  if (isVideoPlayerDetached()) {
    if (playerWindow!.isMinimized()) playerWindow!.restore()
    playerWindow!.show()
    playerWindow!.focus()
    return true
  }

  playerWindow = new BrowserWindow({
    width: 960,
    height: 620,
    minWidth: 420,
    minHeight: 300,
    show: false,
    title: 'Funscript Manager — Player',
    // The picture sits on black whatever the theme is, so the window is not
    // seen flashing the page colour before the first frame arrives.
    backgroundColor: '#05070c',
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
    url.searchParams.set('videoPlayerWindow', '1')
    void playerWindow.loadURL(url.toString())
  } else {
    void playerWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { videoPlayerWindow: '1' }
    })
  }
  surfaceChanged?.(true, false)
  return true
}

/** Put the picture back in the main window: close this one, and say why. */
export function attachVideoPlayerWindow(): boolean {
  if (playerWindow && !playerWindow.isDestroyed()) {
    docking = true
    playerWindow.close()
  }
  return false
}

/**
 * The main window went away, which means the app is going away. A picture
 * left on screen after that keeps the process alive with nothing behind it.
 */
export function closeVideoPlayerWindow(): void {
  if (playerWindow && !playerWindow.isDestroyed()) playerWindow.destroy()
  playerWindow = null
}
