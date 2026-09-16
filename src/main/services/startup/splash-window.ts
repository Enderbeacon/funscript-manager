import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import type { Settings } from '@shared/schemas/app-config'
import type { StartupStatus } from '@shared/schemas/startup'
import { broadcast } from '../../ipc/register'
import { getSettings } from '../config/config-service'
import { hideMainWindow, isDarkTheme } from '../main-window'

/**
 * The startup card: a small window that stands in for the app while it gets
 * ready, and again on the way out when an update is being installed.
 *
 * It exists because the alternative is worse. An empty window handed over
 * before the libraries are indexed can be clicked, and every click waits behind
 * the scan — an app that looks broken rather than busy. The card says what is
 * happening instead, and the window arrives able to answer.
 *
 * Theme, language and version travel in the URL: the card has to paint before
 * anything else does, so its first frame cannot wait on a round trip.
 */

let card: BrowserWindow | null = null

let status: StartupStatus = {
  step: 'starting',
  progress: 0,
  library: null,
  processed: 0,
  total: 0,
  version: null
}

export function startupStatus(): StartupStatus {
  return status
}

/** Move the card along. Everything it shows comes through here. */
export function setStartupStatus(next: Partial<StartupStatus>): void {
  status = { ...status, ...next }
  broadcast('event:startup', status)
}

export function isCardOpen(): boolean {
  return card !== null && !card.isDestroyed()
}

/** Bring the card forward — a second copy of the app started meanwhile. */
export function focusCard(): boolean {
  if (!isCardOpen()) return false
  card!.show()
  card!.focus()
  return true
}

export function openCard(settings: Settings | null): Promise<void> {
  if (isCardOpen()) return Promise.resolve()
  const theme = settings?.ui.theme ?? 'system'
  card = new BrowserWindow({
    // Includes room around the card for its rounded corners and shadow.
    width: 780,
    height: 520,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    show: false,
    center: true,
    // In front of whatever else is on screen, the way a startup card is
    // expected to be — it is gone within seconds.
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })

  const search = new URLSearchParams({
    version: app.getVersion(),
    lang: settings?.ui.language ?? 'system',
    theme: isDarkTheme(theme) ? 'dark' : 'light'
  }).toString()

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) void card.loadURL(`${rendererUrl}/splash.html?${search}`)
  else void card.loadFile(join(__dirname, '../renderer/splash.html'), { search })

  return new Promise<void>((resolve) => {
    const shown = card!
    shown.once('ready-to-show', () => {
      if (!shown.isDestroyed()) shown.show()
      resolve()
    })
    shown.once('closed', () => resolve())
  })
}

export function closeCard(): void {
  if (card && !card.isDestroyed()) card.close()
  card = null
}

/**
 * The card, on the way out: the updater replaces the app's files only once
 * this process has exited, so the window goes and the card explains why.
 */
export async function showInstallingCard(): Promise<void> {
  const settings = await getSettings().catch(() => null)
  hideMainWindow()
  await openCard(settings)
  setStartupStatus({ step: 'installing', progress: 100, library: null, processed: 0, total: 0 })
}
