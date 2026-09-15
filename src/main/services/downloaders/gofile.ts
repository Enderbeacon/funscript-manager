import { createHash } from 'node:crypto'
import { getSettings } from '../config/config-service'
import { httpDownloadToFile } from './http'
import {
  HttpStatusError,
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'

/**
 * gofile. The highest-risk source in the project: an unofficial API
 * whose anti-bot "website token" scheme changes every 6–12 months.
 *
 * Verified against the live API and a real public folder (2026-07-27):
 *
 *   POST /accounts                    → guest account, `data.token` (32 chars)
 *   GET  /contents/{code}             → folder listing, `data.children`
 *        headers: Authorization: Bearer <token>
 *                 X-Website-Token: <wt>          ← header, not a query param
 *                 X-BL: <language>
 *
 * `wt` is derived client-side, and the salt was read out of the site's own
 * obfuscated generator (`/dist/js/wt.obf.js`) rather than guessed:
 *
 *   wt = sha256(`${userAgent}::${language}::${token}::${floor(unix/14400)}::${salt}`)
 *
 * Two things the API tells apart, and so must we:
 *   - `error-notPremium` → the wt was rejected. That is the scheme having moved.
 *   - `error-notFound`   → the wt was fine, the link is dead.
 *
 * **A file link needs the `accountToken` cookie.** Without it the CDN answers
 * 200 with an HTML page, so a naive download writes a web page to disk and calls
 * it a video. `htmlIsError` in the shared downloader is the backstop for that.
 */

const API_BASE = process.env.FSMGR_GOFILE_API || 'https://api.gofile.io'
const SITE = 'https://gofile.io'

/**
 * Read out of the live `wt.obf.js` on 2026-07-27. gallery-dl's published salt
 * (`5d4f7g8sd45fsd`) is already stale, which is the whole reason this is
 * overridable from Settings: when it rotates again the user can paste the new
 * value — or a whole website token — without waiting for an app update.
 */
const BUILTIN_SALT = '9844d94d963d30'

/** The wt is bound to these, so they have to match what we actually send. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36'
const LANG = 'en-US'

/** `https://gofile.io/d/CODE`, and our own per-file form `?file=<id>`. */
const FOLDER_URL = /gofile\.io\/(?:d|\?c=)\/?([\w-]+)/i

/** Nested folders are followed, but not without a floor under the recursion. */
const MAX_FOLDER_DEPTH = 3

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
  data?: {
    type?: string
    name?: string
    code?: string
    children?: Record<string, GofileChild>
  }
}

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

interface Session {
  accountToken: string
  websiteToken: string
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
 * built-in salt is still worth trying.
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
 * A guest account per resolve. Cheap, and it keeps the account token paired with
 * the wt derived from it — the pair is what the API checks, so caching one
 * without the other is how this breaks silently.
 */
async function openSession(): Promise<Session> {
  const { gofile } = (await getSettings()).download
  const res = await fetch(`${API_BASE}/accounts`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Accept: 'application/json', Origin: SITE, Referer: `${SITE}/` }
  })
  if (!res.ok) throw new HttpStatusError(res.status)
  const body = (await res.json().catch(() => null)) as GofileResponse | null
  const accountToken = (body as { data?: { token?: string } } | null)?.data?.token
  if (!accountToken) throw new PermanentError('gofile_no_account')

  const remote = await remoteConfig(gofile.configUrl)
  // A whole token, entered by hand or pushed remotely, skips derivation; failing
  // that, derive from whichever salt is freshest.
  const websiteToken =
    gofile.websiteToken ||
    remote.websiteToken ||
    deriveToken(accountToken, gofile.salt || remote.salt || BUILTIN_SALT)
  return { accountToken, websiteToken }
}

async function getContents(code: string, session: Session): Promise<GofileResponse['data']> {
  const res = await fetch(`${API_BASE}/contents/${encodeURIComponent(code)}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      'Accept-Language': LANG,
      Authorization: `Bearer ${session.accountToken}`,
      'X-Website-Token': session.websiteToken,
      'X-BL': LANG,
      Origin: SITE,
      Referer: `${SITE}/`
    }
  })
  const body = (await res.json().catch(() => null)) as GofileResponse | null
  const status = body?.status ?? `http_${res.status}`

  if (status === 'ok' && body?.data) return body.data
  // The wt was refused — the scheme moved. Say so plainly: the user can paste a
  // replacement in Settings, which is the only action that helps.
  if (status === 'error-notPremium' || res.status === 401) {
    throw new PermanentError('gofile_token_rejected')
  }
  if (status === 'error-notFound' || res.status === 404) throw new PermanentError('gofile_gone')
  if (status === 'error-passwordRequired') throw new PermanentError('gofile_password')
  // Their rate limit is per-IP and short; the queue's 5xx backoff fits it.
  if (status === 'error-rateLimit' || res.status === 429) throw new HttpStatusError(503)
  if (!res.ok) throw new HttpStatusError(res.status)
  throw new PermanentError('gofile_gone')
}

/** Depth-first walk, so a folder of folders still expands into plain files. */
async function collectFiles(
  code: string,
  session: Session,
  depth: number
): Promise<{ rootCode: string; file: GofileChild }[]> {
  const data = await getContents(code, session)
  const children = Object.values(data?.children ?? {})
  const out: { rootCode: string; file: GofileChild }[] = []
  for (const child of children) {
    if (child.type === 'file') {
      out.push({ rootCode: code, file: child })
    } else if (child.type === 'folder' && child.code && depth < MAX_FOLDER_DEPTH) {
      out.push(...(await collectFiles(child.code, session, depth + 1)))
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
    const code = folderCode(url)
    const session = await openSession()
    const files = await collectFiles(code, session, 0)
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
    const code = folderCode(url)
    const wanted = requestedFileId(url)
    const session = await openSession()
    const data = await getContents(code, session)
    const children = Object.values(data?.children ?? {})

    const file = wanted
      ? children.find((c) => c.id === wanted && c.type === 'file')
      : children.find((c) => c.type === 'file')
    if (!file?.link) throw new PermanentError('gofile_gone')

    return {
      url: file.link,
      filename: file.name || file.id,
      ...(file.size !== undefined ? { sizeBytes: file.size } : {}),
      ...(file.mimetype ? { mimeType: file.mimetype } : {}),
      // download() needs the cookie from the same session that produced the link.
      context: { accountToken: session.accountToken }
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
