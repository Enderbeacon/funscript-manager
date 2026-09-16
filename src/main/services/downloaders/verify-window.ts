import { BrowserWindow, type DownloadItem, type Event as ElectronEvent } from 'electron'
import {
  CHALLENGE_PARTITION,
  challengeSessionFor,
  isChallengePage,
  releaseChallengeSession
} from './page-direct/challenge-window'
import { BROWSER_UA } from './page-direct/common'

/**
 * A real window on a site's page, for a person to pass the check the app could
 * not: a bot challenge that wants a box ticked, a captcha in front of a file.
 *
 * It opens only when the person asks — from the queue, or the notice about the
 * failed download — never on its own in the middle of something else. It runs
 * on the challenge partition, so what passing the check earns is there for the
 * app's own reads afterwards, and nothing from the page can reach the app.
 *
 * Two endings, depending on the host:
 *   - `access`: the window closes by itself once the page is no longer a check.
 *   - `file`:   the window waits for the page to start a download, and that
 *     download is saved where the job's partial file goes.
 */

export type VerifyOutcome =
  | { kind: 'cleared' }
  | { kind: 'file'; item: DownloadItem }
  | { kind: 'closed' }

export interface VerifyOptions {
  delivers: 'access' | 'file'
  /** Where a `file` download is written; required for that mode. */
  savePath?: string
  /** One line telling the person what to do; already in their language. */
  hint: string
}

const POLL_MS = 800
const HINT_ID = 'fsmgr-verify-hint'

/** One window per page: asking again brings the open one forward. */
const open = new Map<string, { win: BrowserWindow; outcome: Promise<VerifyOutcome> }>()

/** A bar along the bottom of the page, over it but never in the way of a click. */
function hintScript(hint: string): string {
  return `(() => {
    if (document.getElementById(${JSON.stringify(HINT_ID)})) return
    const bar = document.createElement('div')
    bar.id = ${JSON.stringify(HINT_ID)}
    bar.textContent = ${JSON.stringify(hint)}
    Object.assign(bar.style, {
      position: 'fixed', left: '0', right: '0', bottom: '0', zIndex: '2147483647',
      padding: '10px 14px', background: 'rgba(24, 24, 32, 0.92)', color: '#fff',
      font: '13px/1.4 system-ui, sans-serif', textAlign: 'center', pointerEvents: 'none'
    })
    document.documentElement.appendChild(bar)
  })()`
}

export function openVerification(url: string, options: VerifyOptions): Promise<VerifyOutcome> {
  const existing = open.get(url)
  if (existing && !existing.win.isDestroyed()) {
    existing.win.show()
    existing.win.focus()
    return existing.outcome
  }

  const win = new BrowserWindow({
    width: 1040,
    height: 780,
    // Checks and smokes run without a person; a window must not appear then.
    show: process.env.FSMGR_VERIFY_HIDDEN !== '1',
    autoHideMenuBar: true,
    title: options.hint,
    webPreferences: {
      // The partition has to be set before the page can load; the session is
      // the same object `challengeSessionFor` hands back below.
      partition: CHALLENGE_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })
  const contents = win.webContents
  // Kept apart from `contents`, which cannot be asked anything once destroyed.
  const contentsId = contents.id
  const partition = challengeSessionFor(contentsId)
  // The title says what to do; the page's own title would replace it.
  win.on('page-title-updated', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('dom-ready', () => {
    void contents.executeJavaScript(hintScript(options.hint)).catch(() => {})
  })

  const outcome = new Promise<VerifyOutcome>((resolve) => {
    let settled = false
    let poll: NodeJS.Timeout | null = null
    const settle = (result: VerifyOutcome): void => {
      if (settled) return
      settled = true
      if (poll) clearInterval(poll)
      resolve(result)
    }

    const onDownload = (_event: ElectronEvent, item: DownloadItem, from: Electron.WebContents): void => {
      if (from.id !== contentsId || settled) return
      // Has to happen here, synchronously, or a save dialog opens instead.
      item.setSavePath(options.savePath!)
      // The transfer belongs to the session, not the page; the window can go.
      item.once('done', () => {
        if (!win.isDestroyed()) win.destroy()
      })
      if (!win.isDestroyed()) win.hide()
      settle({ kind: 'file', item })
    }

    if (options.delivers === 'file') {
      partition.on('will-download', onDownload)
    } else {
      // Nothing to wait for but the page turning into itself.
      poll = setInterval(() => {
        // Not before the site itself is on screen: the blank page a window
        // starts on is not a check either.
        if (win.isDestroyed() || contents.isLoading() || !/^https?:/i.test(contents.getURL())) return
        contents
          .executeJavaScript('document.documentElement.outerHTML')
          .then((html: string) => {
            if (typeof html === 'string' && html.length > 0 && !isChallengePage(html)) {
              settle({ kind: 'cleared' })
              if (!win.isDestroyed()) win.destroy()
            }
          })
          .catch(() => {})
      }, POLL_MS)
    }

    win.on('closed', () => {
      partition.removeListener('will-download', onDownload)
      releaseChallengeSession(contentsId)
      open.delete(url)
      settle({ kind: 'closed' })
    })
  })

  open.set(url, { win, outcome })
  void win.loadURL(url, { userAgent: BROWSER_UA }).catch(() => {
    // A check that interrupts its own first navigation is normal; the window
    // stays up for the person either way.
  })
  return outcome
}
