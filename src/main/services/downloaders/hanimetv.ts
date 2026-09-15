import { BrowserWindow, session, type DownloadItem } from 'electron'
import { byPreference, type QualityPreference } from '@shared/quality'
import { getSettings } from '../config/config-service'
import {
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'
import { httpDownloadToFile } from './http'
import { headStatus } from './link-check'
import { BROWSER_UA } from './page-direct/common'

/**
 * hanime.tv.
 *
 * The site's own video page has a download panel — one MP4 per resolution —
 * and that is what this uses. The player was the wrong way in and was measured
 * as such (2026-07-31): the old `/api/v8` endpoint is gone, the new player
 * signs its handshake and decodes the answer out of a response header, and its
 * segments never appear on the session's network layer at all.
 *
 * The panel, by contrast, hands over an ordinary file address — which means
 * Range resume, pacing and progress all work exactly as they do everywhere else.
 *
 * **Every entry needs an account** ("Sign in required" is written on each one),
 * and 1080p needs a paid one. So this opens the page in a hidden window on the
 * app's own session: whatever the login window left behind is what decides
 * which resolutions exist.
 *
 * The address is taken from Electron's download manager rather than read out of
 * the DOM. Clicking an entry may be an anchor or a script; `will-download`
 * reports the real address either way, and the download itself is cancelled
 * there — the queue does the transfer, with everything the queue provides.
 */

const VIDEO_URL = /^https?:\/\/(?:www\.)?hanime\.tv\/videos\/hentai\/([\w-]+)/i

/** Page load, panel open, and the click that names the file. */
const BUDGET_MS = 60_000
/** Long enough for the panel's contents to render after the button. */
const PANEL_MS = 2500
/** How long a clicked row gets to produce a file before it is judged. */
const CLICK_WAIT_MS = 12_000

function slugOf(url: string): string | null {
  return VIDEO_URL.exec(url)?.[1] ?? null
}

/** One window at a time — two would fight over the download listener. */
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/**
 * Open the download panel and report what it offers.
 *
 * Entries are found by their own text rather than by class name: the site is a
 * compiled Vue app whose class names change with every build, but a row that
 * says "1080p" will keep saying "1080p". An entry that also says it needs an
 * account or a membership is recorded as locked rather than clicked — clicking
 * it opens a sales page, not a download.
 */
const READ_PANEL = `(() => {
  const control = [...document.querySelectorAll('a,button')].find(
    (el) => /download/i.test(el.textContent || '') || /download/i.test(el.getAttribute('aria-label') || '')
  )
  if (!control) return JSON.stringify({ error: 'no_control' })
  control.scrollIntoView({ block: 'center' })
  control.click()
  return JSON.stringify({ ok: true })
})()`

/**
 * The panel's rows, found by grouping rather than by position.
 *
 * A resolution label appears in several places on this page — the player's own
 * quality indicator, the video's specifications, an upsell tooltip. What makes
 * the panel the panel is that its labels sit together: four of them under one
 * container. So every clean `1080p`-style label is collected, grouped by
 * ancestor, and the largest group wins.
 *
 * Rows are remembered on `window` and clicked by index afterwards. Their
 * coordinates are useless — the panel renders above the viewport — and their
 * own `click()` is what opened this panel in the first place.
 */
const LIST_ENTRIES = `(() => {
  const RES = /^(\\d{3,4})\\s*p$/i
  const LOCKED = /premium|member|sign in|subscribe/i

  const labels = []
  for (const el of document.querySelectorAll('*')) {
    if (el.children.length > 0) continue
    const text = (el.textContent || '').trim()
    const found = RES.exec(text)
    if (found) labels.push({ el, height: Number(found[1]) })
  }

  // Group by each label's ancestors; the container holding the most of them is
  // the panel. Ties go to the innermost, which is the tightest fit.
  const groups = new Map()
  for (const label of labels) {
    let node = label.el.parentElement
    for (let depth = 0; depth < 6 && node; depth++) {
      let group = groups.get(node)
      if (!group) groups.set(node, (group = { depth, labels: [] }))
      group.labels.push(label)
      node = node.parentElement
    }
  }
  let panel = null
  for (const [node, group] of groups) {
    if (group.labels.length < 2) continue
    if (!panel || group.labels.length > panel.labels.length ||
        (group.labels.length === panel.labels.length && group.depth < panel.depth)) {
      panel = { node, depth: group.depth, labels: group.labels }
    }
  }
  if (!panel) return JSON.stringify([])

  const rows = []
  window.__fsmgrRows = []
  for (const label of panel.labels) {
    // Out to the row: the thing that is clickable, or failing that the label's
    // own parent, which is what carries the row's wording.
    let row = label.el
    for (let i = 0; i < 3 && row.parentElement && row !== panel.node; i++) {
      if (/^(a|button)$/i.test(row.tagName) || row.getAttribute('role') === 'button') break
      row = row.parentElement
    }
    const text = (row.textContent || '').trim()
    // "Sign in required" is written beside the row, not inside it, so the
    // question is asked of the row and of what encloses it.
    const around = (row.parentElement?.textContent || '') + text
    window.__fsmgrRows.push(row)
    rows.push({
      index: rows.length,
      height: label.height,
      text: text.slice(0, 80),
      locked: LOCKED.test(around)
    })
  }
  return JSON.stringify(rows)
})()`

/**
 * Did clicking a row put a sign-in or membership prompt on screen? Asked only
 * when the click produced no file, to tell "you need an account" apart from
 * "this did not work".
 */
const WANTS_ACCOUNT = `(() => {
  const text = document.body.innerText || ''
  return /sign in required|premium members only|reserved for premium|go premium/i.test(text)
})()`

/** Click the row `LIST_ENTRIES` recorded at this index. */
const CLICK_ENTRY = (index: number): string => `(() => {
  const row = (window.__fsmgrRows || [])[${index}]
  if (!row) return 'gone'
  row.scrollIntoView({ block: 'center' })
  row.click()
  return 'clicked'
})()`

interface Entry {
  index: number
  height: number
  text: string
  locked: boolean
}

/**
 * Which entry to click: the preference's own order, over the rows an account
 * can actually take. A row the site has locked is not a candidate at all.
 */
function pick(entries: Entry[], preferred: QualityPreference): Entry | null {
  const open = entries.filter((e) => !e.locked)
  return byPreference(open, (e) => e.height, preferred)[0] ?? null
}

interface Resolved {
  url: string
  fileName: string
  height: number
}

async function readPanel(pageUrl: string): Promise<Resolved> {
  const slug = slugOf(pageUrl)
  if (!slug) throw new PermanentError('hanimetv_bad_link')
  const settings = await getSettings()

  return serialize(async () => {
    const jar = session.defaultSession
    const win = new BrowserWindow({
      show: false,
      // A desktop-sized viewport: the panel is laid out for one.
      width: 1280,
      height: 900,
      webPreferences: {
        session: jar,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      }
    })

    let captured: { url: string; fileName: string } | null = null
    const onDownload = (event: Electron.Event, item: DownloadItem): void => {
      captured = { url: item.getURL(), fileName: item.getFilename() }
      // The queue does the transfer; this window only asked for the address.
      event.preventDefault()
    }
    jar.on('will-download', onDownload)

    try {
      const deadline = Date.now() + BUDGET_MS
      await win.loadURL(pageUrl, { userAgent: BROWSER_UA }).catch(() => {})

      const opened = JSON.parse(
        (await win.webContents.executeJavaScript(READ_PANEL, true)) as string
      ) as { ok?: boolean; error?: string }
      if (opened.error) throw new PermanentError('hanimetv_unavailable')
      await new Promise((r) => setTimeout(r, PANEL_MS))

      const entries = JSON.parse(
        (await win.webContents.executeJavaScript(LIST_ENTRIES)) as string
      ) as Entry[]
      if (entries.length === 0) throw new PermanentError('hanimetv_unavailable')

      const choice = pick(entries, settings.download.preferredQuality)
      // Every resolution locked means the account, not the site, is the limit.
      if (!choice) throw new PermanentError('hanimetv_login')

      const clicked = (await win.webContents.executeJavaScript(
        CLICK_ENTRY(choice.index),
        true
      )) as string
      if (clicked !== 'clicked') throw new PermanentError('hanimetv_unavailable')

      const giveUpAt = Math.min(deadline, Date.now() + CLICK_WAIT_MS)
      while (!captured && Date.now() < giveUpAt) {
        await new Promise((r) => setTimeout(r, 200))
      }
      if (!captured) {
        // A row that hands over nothing is normally a row that wanted an
        // account. Signed out, the site does not say so on the row itself — it
        // says so once the row is clicked, so that is when to look.
        const asked = (await win.webContents
          .executeJavaScript(WANTS_ACCOUNT)
          .catch(() => false)) as boolean
        throw new PermanentError(asked ? 'hanimetv_login' : 'hanimetv_unavailable')
      }
      return { ...(captured as { url: string; fileName: string }), height: choice.height }
    } finally {
      jar.off('will-download', onDownload)
      if (!win.isDestroyed()) win.destroy()
    }
  })
}

export const hanimetvPlugin: DownloaderPlugin = {
  id: 'hanimetv',

  match(url) {
    return VIDEO_URL.test(url)
  },

  guessFileName(url) {
    return `${slugOf(url) ?? 'hanime'}.mp4`
  },

  /** A window has to load and a panel has to open; nobody waits for that unasked. */
  checkCost: 'slow',

  /** A video that is gone is a 404 from the site, with no window involved. */
  check(url) {
    return headStatus(url, { headers: { 'User-Agent': BROWSER_UA } })
  },

  /**
   * Panel addresses are handed out per click and do not outlive the visit,
   * which is what the queue already assumes: nothing is persisted, and every
   * resume and retry comes back through here for a fresh one.
   */
  async resolve(url) {
    const { url: direct, fileName } = await readPanel(url)
    return { url: direct, filename: fileName || `${slugOf(url) ?? 'hanime'}.mp4` }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    const res = await httpDownloadToFile({
      url: info.url,
      partPath: targetPath,
      signal,
      onProgress,
      headers: { Referer: 'https://hanime.tv/', 'User-Agent': BROWSER_UA },
      // Signed out, the address answers with a page telling you to sign in.
      htmlIsError: 'hanimetv_login'
    })
    return {
      filePath: targetPath,
      sizeBytes: res.sizeBytes,
      ...(res.serverFileName ? { fileName: res.serverFileName } : {})
    }
  }
}
