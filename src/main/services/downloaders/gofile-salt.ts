import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { atomicWriteText } from '../../util/atomic-json'

/**
 * gofile's website-token salt, read from gofile's own generator when the one
 * the app knows stops working.
 *
 * The token is `sha256(userAgent::language::accountToken::bucket::salt)`, and
 * the site ships the salt inside an obfuscated script. Rather than wait for a
 * build with the new value every time it rotates, the app runs that script,
 * asks it for a token, and reads the salt off the one string the generator
 * hashes. The formula itself is checked on the way: if the string no longer has
 * that shape, nothing is learned and the caller reports the site as changed.
 *
 * The script is someone else's code, so it runs where it can reach nothing: a
 * hidden, sandboxed window on a blank page, in a session of its own whose every
 * network request is cancelled.
 */

const PARTITION = 'fsmgr-gofile-token'
/** Handed to the generator in place of a real account token. */
const PROBE_TOKEN = 'fsmgr-probe'
const BUDGET_MS = 20_000

function statePath(): string {
  return join(app.getPath('userData'), 'gofile.json')
}

/** The salt learned on an earlier run, if there is one. */
export async function loadLearnedSalt(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf-8')) as { salt?: unknown }
    return typeof parsed.salt === 'string' && parsed.salt ? parsed.salt : null
  } catch {
    return null
  }
}

async function saveLearnedSalt(salt: string): Promise<void> {
  await atomicWriteText(
    statePath(),
    JSON.stringify({ salt, learnedAt: new Date().toISOString() }, null, 2)
  ).catch((e) => console.warn('[gofile] could not keep the learned salt:', e))
}

/** Where the page loads its token generator from. */
function generatorPath(html: string): string {
  const src = /<script[^>]+src="([^"]*\bwt[^"]*\.js)"/i.exec(html)?.[1]
  return src ?? '/js/wt.obf.js'
}

let blocked = false

function isolatedSession(): Electron.Session {
  const isolated = session.fromPartition(PARTITION)
  if (!blocked) {
    blocked = true
    isolated.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (_details, callback) =>
      callback({ cancel: true })
    )
  }
  return isolated
}

/** Run the generator and return the string it hashed, or null. */
async function hashedInput(script: string): Promise<string | null> {
  isolatedSession()
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  try {
    await win.loadURL('about:blank')
    // `void 0` so the script's completion value is never sent back; it may not
    // be something that can cross the process boundary.
    await win.webContents.executeJavaScript(`${script}\n;void 0`)
    const captured: unknown = await win.webContents.executeJavaScript(`(async () => {
      const real = window._sha256
      if (typeof real !== 'function' || typeof window.generateWT !== 'function') return null
      let seen = null
      window._sha256 = (input) => { seen = String(input); return real(input) }
      try { await window.generateWT(${JSON.stringify(PROBE_TOKEN)}) } finally { window._sha256 = real }
      return seen
    })()`)
    return typeof captured === 'string' ? captured : null
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

function withDeadline<T>(task: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([task, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))])
}

/**
 * Fetch gofile's current generator and learn its salt. Null when the site
 * could not be read or no longer builds the token the way the app does.
 */
export async function learnSalt(site: string, userAgent: string): Promise<string | null> {
  try {
    const salt = await withDeadline(
      (async () => {
        const headers = { 'User-Agent': userAgent }
        const page = await fetch(`${site}/`, { headers })
        const script = await fetch(new URL(generatorPath(await page.text()), site), { headers })
        if (!script.ok) return null
        const input = await hashedInput(await script.text())
        if (!input) return null
        const parts = input.split('::')
        const bucket = Math.floor(Date.now() / 1000 / 14400)
        const shaped =
          parts.length === 5 &&
          parts[2] === PROBE_TOKEN &&
          Math.abs(Number(parts[3]) - bucket) <= 1 &&
          /^[\w-]{4,}$/.test(parts[4] ?? '')
        return shaped ? parts[4]! : null
      })(),
      BUDGET_MS
    )
    if (salt) {
      console.log('[gofile] learned the current token salt')
      await saveLearnedSalt(salt)
    } else {
      console.warn('[gofile] the site no longer builds its token the way the app expects')
    }
    return salt
  } catch (e) {
    console.warn('[gofile] could not read the token generator:', e)
    return null
  }
}
