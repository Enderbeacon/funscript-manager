import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** The pages a VR panel can show, by the query that selects them. */
export type VrPage = 'panel' | 'scriptPlayer'

const QUERY: Record<VrPage, string> = { panel: 'vrPanel', scriptPlayer: 'vrScriptPlayer' }

/** Loads a VR page into `win`, from the dev server when there is one. */
export function loadVrPage(win: BrowserWindow, page: VrPage): void {
  const key = QUERY[page]
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (rendererUrl) {
    const url = new URL(rendererUrl)
    url.searchParams.set(key, '1')
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { query: { [key]: '1' } })
  }
}
