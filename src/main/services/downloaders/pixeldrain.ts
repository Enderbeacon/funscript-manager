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
 *   folder https://pixeldrain.com/l/{id}      → /api/list/{id}
 *
 * The API base is overridable so smokes can point at a stub server instead of
 * hitting the real service.
 */

const API_BASE = process.env.FSMGR_PIXELDRAIN_API || 'https://pixeldrain.com/api'

const FILE_URL = /pixeldrain\.com\/(?:u|api\/file)\/([\w-]+)/i
const LIST_URL = /pixeldrain\.com\/l\/([\w-]+)/i

interface ListResponse {
  files?: { id: string; name?: string; size?: number }[]
}

interface FileInfo {
  name?: string
  size?: number
  mime_type?: string
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new HttpStatusError(res.status)
  return (await res.json()) as T
}

export const pixeldrainPlugin: DownloaderPlugin = {
  id: 'pixeldrain',

  match(url) {
    return FILE_URL.test(url) || LIST_URL.test(url)
  },

  /** A folder link becomes one job per file; a file link stays one job. */
  async expand(url) {
    const list = LIST_URL.exec(url)
    if (!list) return [url]
    const data = await getJson<ListResponse>(`${API_BASE}/list/${list[1]}`)
    const files = data.files ?? []
    // An empty or unreadable folder keeps the original URL so the job fails
    // visibly instead of vanishing at enqueue time.
    return files.length > 0 ? files.map((f) => `https://pixeldrain.com/u/${f.id}`) : [url]
  },

  guessFileName(url) {
    return FILE_URL.exec(url)?.[1] ?? 'pixeldrain'
  },

  /** `/info` is one API call, and a removed file is a clean 404. */
  checkCost: 'cheap',

  async resolve(url) {
    const match = FILE_URL.exec(url)
    if (!match) throw new Error(`not a pixeldrain file url: ${url}`)
    const id = match[1]!
    const info = await getJson<FileInfo>(`${API_BASE}/file/${id}/info`)
    return {
      url: `${API_BASE}/file/${id}`,
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
    // The API's /info name already won at resolve(); no need for the header.
    return { filePath: targetPath, sizeBytes: res.sizeBytes }
  }
}
