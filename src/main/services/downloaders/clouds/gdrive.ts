import { filenameFromDisposition, httpDownloadToFile } from '../http'
import { BROWSER_UA, extraHosts } from '../page-direct/common'
import {
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from '../base'

/**
 * Google Drive public file links — the most common script host on the forum
 * after the dedicated ones.
 *
 * Verified live (2026-07-27): `drive.usercontent.google.com/download?id=…` served
 * a 206 for a Range with the real name in Content-Disposition. Large files answer
 * with an HTML confirmation page instead (the virus-scan notice), which carries a
 * form whose fields have to be echoed back — that is handled in resolve(), so the
 * download itself is always a plain ranged GET.
 *
 * A drive link that has run out of daily quota also answers 200-with-HTML. That
 * is a wait, but Drive never says how long, so it cannot use the queue's
 * cooldown (which needs a deadline) and fails with a code the user can read.
 *
 * Folder links are not supported: listing one needs an API key, and the post's
 * link list is what the user picked from.
 */

const FILE_ID = [
  /\/file\/d\/([\w-]{10,})/, // /file/d/<id>/view
  /[?&]id=([\w-]{10,})/, // /uc?export=download&id=<id>
  /\/document\/d\/([\w-]{10,})/,
  /\/open\?id=([\w-]{10,})/
]

const FOLDER_URL = /drive\.google\.com\/(?:drive\/)?(?:u\/\d+\/)?folders\//i

const DOWNLOAD_HOST =
  process.env.FSMGR_GDRIVE_DOWNLOAD || 'https://drive.usercontent.google.com/download'

function fileId(url: string): string {
  for (const re of FILE_ID) {
    const id = re.exec(url)?.[1]
    if (id) return id
  }
  throw new PermanentError('gdrive_bad_link')
}

function isHtml(contentType: string | null): boolean {
  return /^\s*(text\/html|application\/xhtml)/i.test(contentType ?? '')
}

/**
 * The confirmation page is a form of hidden inputs; Drive expects every one of
 * them back, including a per-request `uuid`, so they are echoed rather than
 * hand-picked.
 */
function confirmedUrl(html: string): string | null {
  const action = /<form[^>]+action="([^"]+)"/i.exec(html)?.[1]
  if (!action) return null
  const params = new URLSearchParams()
  for (const m of html.matchAll(/<input[^>]+name="([^"]+)"[^>]+value="([^"]*)"/g)) {
    params.set(m[1]!, m[2]!.replace(/&amp;/g, '&'))
  }
  if ([...params.keys()].length === 0) return null
  return `${action.replace(/&amp;/g, '&')}?${params}`
}

export const gdrivePlugin: DownloaderPlugin = {
  id: 'gdrive',

  match(url) {
    const host = safeHost(url)
    if (/(^|\.)(drive|docs)\.google\.com$/i.test(host)) return true
    return extraHosts('FSMGR_GDRIVE_HOSTS').includes(host.toLowerCase())
  },

  guessFileName(url) {
    try {
      return fileId(url)
    } catch {
      return 'gdrive'
    }
  },

  /** resolve() reads headers and drops the body; that is the whole check. */
  checkCost: 'cheap',

  async resolve(url) {
    if (FOLDER_URL.test(url)) throw new PermanentError('gdrive_folder')
    const id = fileId(url)
    const first = `${DOWNLOAD_HOST}?id=${encodeURIComponent(id)}&export=download`

    // Headers arrive before the body, so a file can be recognised and the body
    // dropped without transferring it.
    const res = await fetch(first, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow'
    })
    if (res.status === 404) throw new PermanentError('gdrive_gone')

    if (!isHtml(res.headers.get('content-type'))) {
      await res.body?.cancel().catch(() => {})
      const size = Number(res.headers.get('content-length') ?? NaN)
      return {
        url: first,
        filename: filenameFromDisposition(res.headers.get('content-disposition')) || id,
        ...(Number.isFinite(size) && size > 0 ? { sizeBytes: size } : {})
      }
    }

    const html = await res.text()
    if (/too many users have viewed|download quota/i.test(html)) {
      throw new PermanentError('gdrive_quota')
    }
    if (/request access|sign in|Zugriff anfordern/i.test(html) && !/<form/i.test(html)) {
      throw new PermanentError('gdrive_private')
    }
    const confirmed = confirmedUrl(html)
    if (!confirmed) throw new PermanentError('gdrive_gone')
    return { url: confirmed, filename: id }
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
      headers: { 'User-Agent': BROWSER_UA },
      htmlIsError: 'gdrive_quota'
    })
    return {
      filePath: targetPath,
      sizeBytes: res.sizeBytes,
      // The id is a poor name; Content-Disposition is the real one and arrives
      // here when resolve() went through the confirmation page.
      ...(res.serverFileName ? { fileName: res.serverFileName } : {})
    }
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}
