import { join } from 'node:path'
import { BrowserWindow, shell } from 'electron'
import { VR_PANEL_HEIGHT, VR_PANEL_WIDTH } from '@shared/vr'
import { loadVrPage } from './page'

/**
 * The VR panel in an ordinary window, for working on it without a headset.
 *
 * It is the same page the headset shows, at the same size, with the mouse
 * standing in for the laser. Development builds open it when
 * FSMGR_VR_PREVIEW is set (`npm run dev:vr`); nothing in the app offers it.
 */

let previewWindow: BrowserWindow | null = null

export function openVrPanelPreview(): void {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.focus()
    return
  }
  previewWindow = new BrowserWindow({
    width: VR_PANEL_WIDTH,
    height: VR_PANEL_HEIGHT,
    useContentSize: true,
    resizable: false,
    autoHideMenuBar: true,
    title: 'VR panel preview',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js')
    }
  })
  previewWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  previewWindow.once('ready-to-show', () => previewWindow?.show())
  previewWindow.once('closed', () => {
    previewWindow = null
  })
  loadVrPage(previewWindow, 'panel')
}
