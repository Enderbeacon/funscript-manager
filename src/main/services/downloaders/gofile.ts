import { createHash } from 'node:crypto'
import { getSettings } from '../config/config-service'
import { learnSalt, loadLearnedSalt } from './gofile-salt'
import { httpDownloadToFile } from './http'
import {
  HttpStatusError,
  PermanentError,
  RateLimitedError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'

/**
 * gofile. The highest-risk source in the project: an unofficial API
 * whose anti-bot "website token" scheme changes every 6–12 months.
 *
 * Verified against the live API and a real public folder (2026-07-27, and the
 * salt again on 2026-09-17):
 *
 *   POST /accounts                    → guest account, `data.token` (32 chars)
 *   GET  /contents/{code}             → folder listing, `data.children`
 *        headers: Authorization: Bearer <token>
 *                 X-Website-Token: <wt>          ← header, not a query param
 *                 X-BL: <language>
 *
 * `wt` is derived client-side, from a salt the site's own obfuscated generator
 * (`/js/wt.obf.js`) carries:
 *
 *   wt = sha256(`${userAgent}::${language}::${token}::${floor(unix/14400)}::${salt}`)
 *
 * What the API tells apart, and so must we:
 *   - `error-notPremium` → the wt was rejected. That is the salt having moved;
 *     the app reads the new one off the site (see gofile-salt.ts) and asks again.
 *   - `error-notFound`   → the wt was fine, the link is dead.
 *   - `error-rateLimit`  → too many requests from this address. Creating a guest
 *     account counts, and creating one per request is what used to bring it on
 *     within a few checks — so one account is kept for the whole session.
 *
 * **A file link needs the `accountToken` cookie.** Without it the CDN answers
 * 200 with an HTML page, so a naive download writes a web page to disk and calls
 * it a video. `htmlIsError` in the shared downloader is the backstop for that.
 */

const API_BASE = process.env.FSMGR_GOFILE_API || 'https://api.gofile.io'
const SITE = 'https://gofile.io'

/**
 * Read out of the live generator on 2026-09-17. Only the starting point: a
 * rejected token makes the app read the current value off the site, and the
 * Settings fields still let a user paste a salt or a whole token by hand.
 */
const BUILTIN_SALT = '12af056dacea0b'

/** The wt is bound to these, so they have to match what we actually send. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36'
const LANG = 'en-US'

/** `https://gofile.io/d/CODE`, and our own per-file form `?file=<id>`. */
const FOLDER_URL = /gofile\.io\/(?:d|\?c=)\/?([\w-]+)/i

/** Nested folders are followed, but not without a floor under the recursion. */
const MAX_FOLDER_DEPTH = 3

/**
 * How long to leave gofile alone once it says too many requests. It does not
 * say for how long; a ban measured at a few minutes outlasts any quick retry,
 * and asking again sooner only extends it.
 */
const RATE_LIMIT_WAIT_S = 5 * 60

/** Reading the generator opens a window; once a quarter of an hour is plenty. */
const RELEARN_AFTER_MS = 15 * 60 * 1000

interface GofileChild {
  id: string
  type: 'file' | 'folder'
  name?: string
  size?: number
  mimetype?: string
  md5?: string
  code?: string
  link?: string
}

interface GofileResponse {
  status?: string
  /** A folder with its children, or — for a link to one upload — the file itself. */
  data?: Partial<Omit<GofileChild, 'type'>> & {
    type?: string
    children?: Record<string, GofileChild>
  }
}

type Folder = NonNullable<GofileResponse['data']>

function folderCode(url: string): string {
  const code = FOLDER_URL.exec(url)?.[1]
  if (!code) throw new PermanentError('gofile_bad_link')
  return code
}

/** Our synthetic single-file address: the folder link plus which child it is. */
function fileUrl(code: string, fileId: string): string {
  return `${SITE}/d/${code}?file=${fileId}`
}

function requestedFileId(url: string): string | null {
  try {
    return new URL(url).searchParams.get('file')
  } catch {
    return null
  }
}

function deriveToken(accountToken: string, salt: string): string {
  const bucket = Math.floor(Date.now() / 1000 / 14400)
  return createHash('sha256')
    .update(`${UA}::${LANG}::${accountToken}::${bucket}::${salt}`)
    .digest('hex')
}

interface RemoteConfig {
  salt?: string
  websiteToken?: string
}

/** Remote config is polled at most this often; a failure just falls through. */
const REMOTE_TTL_MS = 30 * 60 * 1000
let remoteCache: { at: number; url: string; config: RemoteConfig } | null = null

/**
 * Optional hot-fix channel: a JSON document holding `salt` and/or
 * `websiteToken`, so a rotation can be answered without shipping a build. Off
 * unless the user sets a URL — and a fetch that fails is silent on purpose, the
 * other salts are still worth trying.
 */
async function remoteConfig(url: string): Promise<RemoteConfig> {
  if (!url) return {}
  if (remoteCache && remoteCache.url === url && Date.now() - remoteCache.at < REMOTE_TTL_MS) {
    return remoteCache.config
  }
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return {}
    const body = (await res.json()) as RemoteConfig
    const config: RemoteConfig = {
      ...(typeof body.salt === 'string' ? { salt: body.salt } : {}),
      ...(typeof body.websiteToken === 'string' ? { websiteToken: body.websiteToken } : {})
    }
    remoteCache = { at: Date.now(), url, config }
    return config
  } catch {
    return {}
  }
}

/**
 * The guest account, made once and kept for the session. The wt is derived
 * from it afresh on every request, so the two can never drift apart.
 */
let account: Promise<string> | null = null

function guestAccount(): Promise<string> {
  account ??= createAccount().catch((e: unknown) => {
    account = null
    throw e
  })
  return account
}

async function createAccount(): Promise<string> {
  const res = await fetch(`${API_BASE}/accounts`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json', Origin: SITE, Referer: `${SITE}/` }
  })
  const body = (await res.json().catch(() => null)) as
    | (GofileResponse & { data?: { token?: string } })
    | null
  if (res.status === 429 || body?.status === 'error-rateLimit') {
    throw new RateLimitedError(RATE_LIMIT_WAIT_S)
  }
  if (!res.ok) throw new HttpStatusError(res.status)
  const token = body?.data?.token
  if (!token) throw new PermanentError('gofile_no_account')
  return token
}

/** The salt the app worked out last, kept across runs; read once. */
let learned: Promise<string | null> | null = null
let learning: Promise<string | null> | null = null
let learnedAt = 0

/** Read the current salt off the site — at most once per interval, however many ask. */
function relearn(): Promise<string | null> {
  if (learning) return learning
  if (Date.now() - learnedAt < RELEARN_AFTER_MS) return learned ?? Promise.resolve(null)
  learning = learnSalt(SITE, UA).then((salt) => {
    learnedAt = Date.now()
    if (salt) learned = Promise.resolve(salt)
    learning = null
    return salt
  })
  return learning
}

/** Rejected: the wt. Account: the account token itself was not accepted. */
type Refusal = 'rejected' | 'account'

async function askContents(
  code: string,
  accountToken: string,
  websiteToken: string
): Promise<Folder | Refusal> {
  const res = await fetch(`${API_BASE}/contents/${encodeURIComponent(code)}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': LANG,
      Authorization: `Bearer ${accountToken}`,
      'X-Website-Token': websiteToken,
      'X-BL': LANG,
      Origin: SITE,
      Referer: `${SITE}/`
    }
  })
  const body = (await res.json().catch(() => null)) as GofileResponse | null
  const status = body?.status ?? `http_${res.status}`

  if (status === 'ok' && body?.data) return body.data
  if (status === 'error-notPremium') return 'rejected'
  if (status === 'error-rateLimit' || res.status === 429) throw new RateLimitedError(RATE_LIMIT_WAIT_S)
  if (status === 'error-notFound' || res.status === 404) throw new PermanentError('gofile_gone')
  if (status === 'error-passwordRequired') throw new PermanentError('gofile_password')
  if (res.status === 401 || res.status === 403) return 'account'
  if (!res.ok) throw new HttpStatusError(res.status)
  throw new PermanentError('gofile_gone')
}

/**
 * Ask with every website token worth trying, freshest idea first.
 *
 * A value the user typed into Settings is the only one used: they set it
 * because they know better, and quietly replacing it would hide that it went
 * stale. Otherwise the salts are tried in turn — remote, learned, built in —
 * and when all of them are refused, the site's generator is read for the
 * current one.
 */
async function withWebsiteToken(
  accountToken: string,
  ask: (websiteToken: string) => Promise<Folder | Refusal>
): Promise<Folder | Refusal> {
  const { gofile } = (await getSettings()).download
  if (gofile.websiteToken) return ask(gofile.websiteToken)
  if (gofile.salt) return ask(deriveToken(accountToken, gofile.salt))
  const remote = await remoteConfig(gofile.configUrl)
  if (remote.websiteToken) {
    const answer = await ask(remote.websiteToken)
    if (answer !== 'rejected') return answer
  }

  learned ??= loadLearnedSalt()
  const tried = new Set<string>()
  for (const salt of [remote.salt, await learned, BUILTIN_SALT]) {
    if (!salt || tried.has(salt)) continue
    tried.add(salt)
    const answer = await ask(deriveToken(accountToken, salt))
    if (answer !== 'rejected') return answer
  }

  const current = await relearn()
  if (!current || tried.has(current)) return 'rejected'
  return ask(deriveToken(accountToken, current))
}

/**
 * List a folder, with the account the answer was given to — a file link from
 * it downloads only with that account's cookie.
 *
 * One fresh account is tried before giving up: a guest account can lapse, and
 * a lapsed one may be refused exactly like a stale salt.
 */
async function listFolder(code: string): Promise<{ folder: Folder; accountToken: string }> {
  for (let fresh = false; ; fresh = true) {
    const accountToken = await guestAccount()
    const answer = await withWebsiteToken(accountToken, (wt) => askContents(code, accountToken, wt))
    if (answer !== 'rejected' && answer !== 'account') return { folder: answer, accountToken }
    if (fresh) {
      // Say so plainly: pasting a token in Settings is the only thing left
      // that helps.
      throw new PermanentError('gofile_token_rejected')
    }
    account = null
  }
}

/** Depth-first walk, so a folder of folders still expands into plain files. */
/**
 * The files a contents answer holds. A `/d/` code names either a folder or,
 * since gofile started handing out links to single uploads, one file — and
 * that answer carries the file's own details with no children at all. Reading
 * only the children took every such link for an empty, dead folder.
 */
function filesIn(folder: Folder): GofileChild[] {
  if (folder.type === 'file' && folder.id && folder.link) {
    return [{ ...folder, id: folder.id, type: 'file' }]
  }
  return Object.values(folder.children ?? {})
}

async function collectFiles(
  code: string,
  depth: number
): Promise<{ rootCode: string; file: GofileChild }[]> {
  const { folder } = await listFolder(code)
  const children = filesIn(folder)
  const out: { rootCode: string; file: GofileChild }[] = []
  for (const child of children) {
    if (child.type === 'file') {
      out.push({ rootCode: code, file: child })
    } else if (child.type === 'folder' && child.code && depth < MAX_FOLDER_DEPTH) {
      out.push(...(await collectFiles(child.code, depth + 1)))
    }
  }
  return out
}

export const gofilePlugin: DownloaderPlugin = {
  id: 'gofile',

  match(url) {
    return FOLDER_URL.test(url)
  },

  /**
   * A gofile link always names a folder, even for a single upload, so expanding
   * is not optional here: without it one job would stand for N files. Each job
   * gets `?file=<id>` so a later resolve knows which child it is — and opening
   * that URL in a browser still lands on the right folder.
   */
  async expand(url) {
    if (requestedFileId(url)) return [url]
    const files = await collectFiles(folderCode(url), 0)
    // Keep the original URL when the folder is empty or unreadable: a job that
    // fails visibly beats one that silently never existed.
    if (files.length === 0) return [url]
    return files.map(({ rootCode, file }) => fileUrl(rootCode, file.id))
  },

  guessFileName(url) {
    return folderCode(url)
  },

  /** The contents call the download starts with; nothing extra is spent. */
  checkCost: 'cheap',

  async resolve(url) {
    const wanted = requestedFileId(url)
    const { folder, accountToken } = await listFolder(folderCode(url))
    const children = filesIn(folder)

    const file = wanted
      ? children.find((c) => c.id === wanted && c.type === 'file')
      : children.find((c) => c.type === 'file')
    if (!file?.link) throw new PermanentError('gofile_gone')

    return {
      url: file.link,
      filename: file.name || file.id,
      ...(file.size !== undefined ? { sizeBytes: file.size } : {}),
      ...(file.mimetype ? { mimeType: file.mimetype } : {}),
      // download() needs the cookie of the account that produced the link.
      context: { accountToken }
    }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    const accountToken = String(info.context?.accountToken ?? '')
    const res = await httpDownloadToFile({
      url: info.url,
      partPath: targetPath,
      signal,
      onProgress,
      headers: {
        'User-Agent': UA,
        // Without this the CDN serves an HTML page with a 200 — see the note at
        // the top of this file.
        Cookie: `accountToken=${accountToken}`,
        Referer: `${SITE}/`,
        Origin: SITE
      },
      htmlIsError: 'gofile_token_rejected'
    })
    // The API's own name already won at resolve(); it is the upload's real name.
    return { filePath: targetPath, sizeBytes: res.sizeBytes }
  }
}
