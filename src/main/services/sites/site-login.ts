import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BrowserWindow, app, session, type Cookie } from 'electron'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'

/**
 * Signing in to a download source.
 *
 * The app never handles credentials: it opens the site in a real browser
 * window on its own Electron session, and what stays behind is whatever
 * cookies the site chose to set. Everything downstream reads that one session:
 *
 * - page-direct plugins call `net.fetch`, which uses it already
 * - yt-dlp is a separate process, so its cookies are exported to a file for
 *   the length of one run and deleted afterwards
 *
 * Only sources whose downloader actually reads those cookies are listed. A row
 * for gofile or mega would be a button that changes nothing.
 */

export interface SiteSpec {
  id: string
  label: string
  /** Where the login window opens. The site's own page decides the rest. */
  url: string
  /** Cookie domains that belong to this site. */
  domains: string[]
  /**
   * Whether an account is needed to download from here at all.
   * `no`  — every source we support works signed out; sign in only for
   *         something the site keeps behind an account.
   * `some` — part of the catalogue needs one.
   */
  need: 'no' | 'some'
}

/**
 * `need` reflects what the app's own downloaders have been seen to do: all
 * eight sources were downloaded from signed out. Pornhub is the one with a
 * paid tier its free account cannot reach either way.
 */
export const SITES: SiteSpec[] = [
  { id: 'pornhub', label: 'Pornhub', url: 'https://www.pornhub.com/', domains: ['pornhub.com'], need: 'some' },
  { id: 'eporner', label: 'Eporner', url: 'https://www.eporner.com/', domains: ['eporner.com'], need: 'no' },
  { id: 'spankbang', label: 'SpankBang', url: 'https://spankbang.com/', domains: ['spankbang.com', 'spankbang.party'], need: 'no' },
  { id: 'rule34video', label: 'Rule34Video', url: 'https://rule34video.com/', domains: ['rule34video.com'], need: 'no' },
  { id: 'hanime1', label: 'Hanime1', url: 'https://hanime1.me/', domains: ['hanime1.me'], need: 'no' },
  // Its download panel says "Sign in required" on every resolution, and
  // reserves 1080p for paid accounts — so this is the one source where signing
  // in is not optional.
  { id: 'hanimetv', label: 'hanime.tv', url: 'https://hanime.tv/', domains: ['hanime.tv'], need: 'some' }
]

export interface SiteStatus extends SiteSpec {
  /** The user went through the login window and cookies are still there. */
  signedIn: boolean
}

/** Which sites the user has been through the login window for. */
interface SitesFile {
  visited: string[]
}

function statePath(): string {
  return join(app.getPath('userData'), 'sites.json')
}

async function readState(): Promise<SitesFile> {
  const raw = (await readJsonOr(statePath(), {})) as Partial<SitesFile>
  return { visited: Array.isArray(raw?.visited) ? raw.visited.filter((s) => typeof s === 'string') : [] }
}

async function markVisited(id: string, visited: boolean): Promise<void> {
  const state = await readState()
  const next = visited
    ? [...new Set([...state.visited, id])]
    : state.visited.filter((s) => s !== id)
  await atomicWriteJson(statePath(), { visited: next } satisfies SitesFile)
}

async function cookiesFor(domains: string[]): Promise<Cookie[]> {
  const jar = session.defaultSession.cookies
  const found: Cookie[] = []
  for (const domain of domains) {
    found.push(...(await jar.get({ domain }).catch(() => [])))
  }
  return found
}

export async function listSites(): Promise<SiteStatus[]> {
  const { visited } = await readState()
  return Promise.all(
    SITES.map(async (site) => ({
      ...site,
      // Both halves matter: the flag says the user meant to sign in, the
      // cookies say the session is still there to use.
      signedIn: visited.includes(site.id) && (await cookiesFor(site.domains)).length > 0
    }))
  )
}

const openWindows = new Map<string, BrowserWindow>()

/**
 * Open a site's page in a window and wait for it to close. There is no "signed
 * in" event to wait for — every site signals it differently — so the user
 * closing the window is the signal, and the answer is whatever cookies exist
 * at that point.
 */
export async function openSiteLogin(id: string): Promise<{ signedIn: boolean }> {
  const site = SITES.find((s) => s.id === id)
  if (!site) return { signedIn: false }

  const existing = openWindows.get(id)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return { signedIn: (await cookiesFor(site.domains)).length > 0 }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 860,
    autoHideMenuBar: true,
    title: site.label,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  })
  openWindows.set(id, win)
  void win.loadURL(site.url)

  await new Promise<void>((resolve) => win.once('closed', resolve))
  openWindows.delete(id)

  const signedIn = (await cookiesFor(site.domains)).length > 0
  await markVisited(id, signedIn)
  return { signedIn }
}

/** Drop everything the site left behind, so the next download is anonymous. */
export async function signOutSite(id: string): Promise<void> {
  const site = SITES.find((s) => s.id === id)
  if (!site) return
  const jar = session.defaultSession.cookies
  for (const cookie of await cookiesFor(site.domains)) {
    const scheme = cookie.secure ? 'https' : 'http'
    const host = cookie.domain?.replace(/^\./, '') ?? ''
    await jar.remove(`${scheme}://${host}${cookie.path ?? '/'}`, cookie.name).catch(() => {})
  }
  await markVisited(id, false)
}

/**
 * Test seam, matching FSMGR_YTDLP_HOSTS: hosts named here are treated as a
 * signed-in site, so a stub server can stand in for a real one and the whole
 * session → cookie file → yt-dlp path can be exercised without an account.
 */
function extraDomains(): string[] {
  return (process.env.FSMGR_SITE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/** The site a URL belongs to, or null when it is not one we can sign in to. */
function siteForUrl(url: string): SiteSpec | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const known = SITES.find((s) => s.domains.some((d) => host === d || host.endsWith(`.${d}`)))
  if (known) return known
  const extra = extraDomains().find((d) => host === d)
  return extra ? { id: extra, label: extra, url, domains: [extra], need: 'no' } : null
}

function cookiesDir(): string {
  return join(app.getPath('userData'), 'cookies')
}

/** One cookie line in the format yt-dlp reads (`# Netscape HTTP Cookie File`). */
function netscapeLine(cookie: Cookie): string {
  const domain = cookie.domain ?? ''
  const subdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
  const expires = Math.floor(cookie.expirationDate ?? 0)
  const line = [
    domain,
    subdomains,
    cookie.path || '/',
    cookie.secure ? 'TRUE' : 'FALSE',
    String(expires),
    cookie.name,
    cookie.value
  ].join('\t')
  // yt-dlp keeps httpOnly cookies behind this marker, the same way browsers
  // export them; without it the line is read as an ordinary cookie.
  return cookie.httpOnly ? `#HttpOnly_${line}` : line
}

export interface CookieFile {
  path: string
  /** Deletes it. Credentials should not outlive the download that needed them. */
  dispose(): Promise<void>
}

/**
 * Write the session's cookies for `url`'s site to a file yt-dlp can read, or
 * null when there are none — passing an empty cookie file only makes yt-dlp
 * complain about it.
 */
export async function cookieFileFor(url: string): Promise<CookieFile | null> {
  const site = siteForUrl(url)
  if (!site) return null
  const cookies = await cookiesFor(site.domains)
  if (cookies.length === 0) return null

  const dir = cookiesDir()
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}.txt`)
  const body = ['# Netscape HTTP Cookie File', ...cookies.map(netscapeLine), ''].join('\n')
  await writeFile(path, body, 'utf-8')
  return { path, dispose: () => rm(path, { force: true }).catch(() => {}) }
}
