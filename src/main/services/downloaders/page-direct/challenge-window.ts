import { BrowserWindow, session } from 'electron'
import { PageParseError } from './common'

/**
 * Read a page that sits behind a JS bot challenge, by letting a real renderer
 * solve it and then taking the DOM.
 *
 * Needed for spankbang, and measured on 2026-07-27 before being written:
 *
 * - Node's `fetch` and Electron's `net.fetch` both get Cloudflare's
 *   "Just a moment…" interstitial (HTTP 403) on a cold session.
 * - A hidden `BrowserWindow` clears it in a few seconds.
 * - **And `net.fetch` still gets 403 afterwards**, even with `cf_clearance` in
 *   the cookie jar. So this is not "warm up the session once" — the window is
 *   the only way to read these pages, every time.
 *
 * Which window configuration clears it varies between runs, so the configs are
 * tried in order and the first one that works wins rather than being hard-coded.
 *
 * Everything runs in its own persistent partition: the challenge cookies stay
 * out of the app's default session, and that session can have image/media/font
 * requests blocked without touching how the rest of the app loads anything.
 */

const PARTITION = 'persist:fsmgr-challenge'
/**
 * One budget for the whole read, shared across the window configurations rather
 * than given to each. The live site cleared in under five seconds, so this is
 * already generous — and per-attempt timeouts multiplied out to a minute and a
 * half of a job sitting on "downloading" before it admitted defeat.
 */
const TOTAL_BUDGET_MS = 45_000
const POLL_MS = 700

/** The interstitial, as it appears in the DOM while it is still up. */
function isChallengePage(html: string): boolean {
  const head = html.slice(0, 4000)
  return /Just a moment|challenges\.cloudflare\.com|cf-browser-verification/i.test(head)
}

let blocked = false

/**
 * Drop the heavy subresources for this partition only. A video page would
 * otherwise start pulling poster images and preview clips we are throwing away
 * — and the run that cleared fastest was the one with images off.
 */
function blockHeavyResources(): Electron.Session {
  const partition = session.fromPartition(PARTITION)
  if (blocked) return partition
  blocked = true
  partition.webRequest.onBeforeRequest(
    { urls: ['*://*/*'], types: ['image', 'media', 'font'] },
    (_details, callback) => callback({ cancel: true })
  )
  return partition
}

/** One window at a time: several resolves at once would each open their own. */
let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  // Keep the chain alive regardless of how this task ended.
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

interface Attempt {
  label: string
  webPreferences: Electron.WebPreferences
}

const ATTEMPTS: Attempt[] = [
  { label: 'offscreen', webPreferences: { offscreen: true, images: false } },
  { label: 'offscreen+images', webPreferences: { offscreen: true } },
  { label: 'hidden', webPreferences: {} }
]

async function loadOnce(
  url: string,
  attempt: Attempt,
  userAgent: string,
  deadline: number
): Promise<string | null> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      ...attempt.webPreferences,
      partition: PARTITION,
      // Nothing from the page may reach the app.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  try {
    await win.loadURL(url, { userAgent })
    for (;;) {
      if (win.isDestroyed()) return null
      const html = (await win.webContents.executeJavaScript(
        'document.documentElement.outerHTML'
      )) as string
      if (!isChallengePage(html)) return html
      if (Date.now() > deadline) return null
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
  } catch {
    // A navigation the challenge aborted, or a destroyed window: try the next
    // configuration rather than failing the whole job here.
    return null
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Load `url` in a hidden window and return its DOM once the challenge is gone.
 * Throws `PageParseError('challenge_unsolved')` if none of the configurations
 * get through — the caller treats that like any other unreadable page.
 */
export function fetchViaWindow(url: string, userAgent: string): Promise<string> {
  return serialize(async () => {
    blockHeavyResources()
    const deadline = Date.now() + TOTAL_BUDGET_MS
    for (const attempt of ATTEMPTS) {
      if (Date.now() >= deadline) break
      const html = await loadOnce(url, attempt, userAgent, deadline)
      if (html) return html
      console.warn(`[challenge] ${attempt.label} did not clear ${new URL(url).hostname}`)
    }
    throw new PageParseError('challenge_unsolved')
  })
}
