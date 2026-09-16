import { httpDownloadToFile } from './http'
import {
  HttpStatusError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'

/**
 * pixeldrain. Public REST API:
 *   file   https://pixeldrain.com/u/{id}      → /api/file/{id}
 *   list   https://pixeldrain.com/l/{id}      → /api/list/{id}
 *   share  https://pixeldrain.com/d/{id}[/…]  → /api/filesystem/{id}[/…]
 *
 * A `/d/` share is pixeldrain's newer kind: a file, or a directory tree the
 * uploader shares whole — often the video with its scripts beside it.
 * `?stat` describes a path and lists a directory's children; `?attach` serves
 * a file with its name and honours Range, so resume works as for `/u/`.
 *
 * The API base is overridable so smokes can point at a stub server instead of
 * hitting the real service.
 */

const API_BASE_OVERRIDE = process.env.FSMGR_PIXELDRAIN_API

/** Every public hostname listed by pixeldrain, including the pre-2019 one. */
const HOST = String.raw`(?:pixeldrain\.(?:com|net|nl|biz|tech|dev)|pixeldra\.in)`
const ORIGIN = String.raw`https?:\/\/(?:www\.)?${HOST}`
const FILE_URL = new RegExp(String.raw`^${ORIGIN}\/(?:u|api\/file)\/([\w-]+)(?:[/?#]|$)`, 'i')
const LIST_URL = new RegExp(String.raw`^${ORIGIN}\/(?:l|api\/list)\/([\w-]+)(?:[/?#]|$)`, 'i')
/** The share id and, for a deep link, the path under it — still percent-encoded. */
const SHARE_URL = new RegExp(
  String.raw`^${ORIGIN}\/(?:d|api\/filesystem)\/([\w-]+)((?:\/[^?#]*)?)(?:[?#].*)?$`,
  'i'
)

/** Pixeldrain itself allows at most this many nested directories. */
const MAX_SHARE_DEPTH = 64

interface ListResponse {
  files?: { id: string; name?: string; size?: number }[]
}

interface FileInfo {
  name?: string
  size?: number
  mime_type?: string
}

interface ShareNode {
  type: 'file' | 'dir'
  /** `/{shareId}/sub/dir/name.mp4` — unencoded. */
  path: string
  name: string
  file_size?: number
  file_type?: string
}

interface ShareStat {
  /** From the account root down to the path asked about. */
  path?: ShareNode[]
  /** The entry in `path` that the requested public path resolves to. */
  base_index?: number
  children?: ShareNode[]
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new HttpStatusError(res.status)
  return (await res.json()) as T
}

/** `/abc/sub dir/x.mp4` → `abc/sub%20dir/x.mp4`, the form both the API and the site take. */
function encodePath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

function siteOrigin(url: string): string {
  return new URL(url).origin
}

/** Use the hostname the author shared, so an alternate domain keeps bypassing a local block. */
function apiBase(url: string): string {
  return API_BASE_OVERRIDE || `${siteOrigin(url)}/api`
}

/** The share path a `/d/` link points at, encoded; null for any other link. */
function sharePath(url: string): string | null {
  const match = SHARE_URL.exec(url)
  if (!match) return null
  const rest = match[2] ?? ''
  let decoded = rest
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    // Already plain, or malformed in a way the API will answer for.
  }
  return encodePath(`/${match[1]}${decoded}`)
}

function statShare(url: string, path: string): Promise<ShareStat> {
  return getJson<ShareStat>(`${apiBase(url)}/filesystem/${path}?stat`)
}

function shareBase(stat: ShareStat): ShareNode | undefined {
  const index = stat.base_index
  return index === undefined ? stat.path?.at(-1) : stat.path?.[index]
}

function childPath(parent: string, name: string): string {
  return `${parent}/${encodeURIComponent(name)}`
}

/**
 * Every file under a share directory. Names starting with a dot are
 * pixeldrain's own bookkeeping (`.search_index.gz`), not the uploader's files.
 */
async function shareFiles(url: string, path: string, depth: number): Promise<ShareNode[]> {
  const stat = await statShare(url, path)
  const self = shareBase(stat)
  if (self?.type === 'file') return [{ ...self, path }]
  const out: ShareNode[] = []
  for (const child of stat.children ?? []) {
    if (child.name.startsWith('.')) continue
    // API node paths are account-internal. Public requests stay rooted at the
    // share id and append the displayed name instead.
    const publicPath = childPath(path, child.name)
    if (child.type === 'file') out.push({ ...child, path: publicPath })
    else if (depth < MAX_SHARE_DEPTH) {
      out.push(...(await shareFiles(url, publicPath, depth + 1)))
    }
  }
  return out
}

export const pixeldrainPlugin: DownloaderPlugin = {
  id: 'pixeldrain',

  match(url) {
    return FILE_URL.test(url) || LIST_URL.test(url) || SHARE_URL.test(url)
  },

  /** A list or a shared directory becomes one job per file; a file link stays one job. */
  async expand(url) {
    const share = sharePath(url)
    if (share) {
      const files = await shareFiles(url, share, 0)
      // An empty or unreadable share keeps the original URL so the job fails
      // visibly instead of vanishing at enqueue time.
      return files.length > 0
        ? files.map((f) => `${siteOrigin(url)}/d/${f.path}`)
        : [url]
    }
    const list = LIST_URL.exec(url)
    if (!list) return [url]
    const data = await getJson<ListResponse>(`${apiBase(url)}/list/${list[1]}`)
    const files = data.files ?? []
    return files.length > 0
      ? files.map((f) => `${siteOrigin(url)}/u/${f.id}`)
      : [url]
  },

  guessFileName(url) {
    const share = sharePath(url)
    if (share) return decodeURIComponent(share.split('/').at(-1) ?? 'pixeldrain')
    return FILE_URL.exec(url)?.[1] ?? 'pixeldrain'
  },

  /** `/info` or `?stat` is one API call, and a removed file is a clean 404. */
  checkCost: 'cheap',

  async resolve(url) {
    const share = sharePath(url)
    if (share) {
      const stat = await statShare(url, share)
      const self = shareBase(stat)
      // A directory that expanded to nothing has no file to hand over.
      if (self?.type !== 'file') throw new HttpStatusError(404)
      return {
        url: `${apiBase(url)}/filesystem/${share}?attach`,
        filename: self.name,
        ...(self.file_size !== undefined ? { sizeBytes: self.file_size } : {}),
        ...(self.file_type ? { mimeType: self.file_type } : {})
      }
    }

    const match = FILE_URL.exec(url)
    if (!match) throw new Error(`not a pixeldrain file url: ${url}`)
    const id = match[1]!
    const info = await getJson<FileInfo>(`${apiBase(url)}/file/${id}/info`)
    return {
      url: `${apiBase(url)}/file/${id}`,
      filename: info.name || id,
      ...(info.size !== undefined ? { sizeBytes: info.size } : {}),
      ...(info.mime_type ? { mimeType: info.mime_type } : {})
    }
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
      onProgress
    })
    // The API's own name already won at resolve(); no need for the header.
    return { filePath: targetPath, sizeBytes: res.sizeBytes }
  }
}
