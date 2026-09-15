import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { File } from 'megajs'
import { throttleStage } from '../net/throttle'
import {
  PermanentError,
  QuotaExceededError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'

/**
 * mega.nz public links. Built on megajs, which handles the chunked
 * transfer and the decryption; only public links are supported — the app never
 * asks for a mega account.
 *
 * Three things this file exists to get right:
 *
 * - **Quota.** The free tier is capped per IP on a rolling window, and mega
 *   answers an over-quota request with a wait time rather than a plain error.
 *   That becomes QuotaExceededError, and the queue parks the job until the
 *   window reopens instead of spending its retry budget.
 * - **Resume.** `download({ start })` picks up from a byte offset and the
 *   result is identical to a download in one go, so a paused job continues
 *   from what is already on disk.
 * - **Aborting safely.** Destroying a megajs stream makes it emit `error`.
 *   Unhandled, that takes the whole main process down, so every stream gets a
 *   handler before anything can abort it.
 */

/** `https://mega.nz/file/<id>#<key>` and the older `#!<id>!<key>` form. */
const FILE_URL = /^https:\/\/mega\.(?:nz|io)\/(?:file\/[\w-]+#|#!)/i
/** `https://mega.nz/folder/<id>#<key>`, optionally deep-linked to one file. */
const FOLDER_URL = /^https:\/\/mega\.(?:nz|io)\/folder\/[\w-]+#[\w-]+/i
/** mega's own deep link to one file inside a public folder. */
const FOLDER_CHILD = /^(https:\/\/mega\.nz\/folder\/[\w-]+#[\w-]+)\/file\/([\w-]+)$/i

/** megajs only accepts mega.nz; mega.io is the same service under a newer name. */
function normalize(url: string): string {
  return url.replace(/^https:\/\/mega\.io\//i, 'https://mega.nz/')
}

/** megajs types the node loosely; this is the shape we actually use. */
interface MegaNode {
  name?: string | null
  size?: number
  directory?: boolean
  downloadId?: string | string[]
  children?: MegaNode[]
  loadAttributes(): Promise<unknown>
  /** A duplexify stream: readable, and destroyable when the user pauses. */
  download(options: { start?: number; end?: number }): NodeJS.ReadableStream & {
    destroy(error?: Error): void
  }
}

/** The node id of a folder child, i.e. the second half of its downloadId. */
function childId(node: MegaNode): string | null {
  const id = node.downloadId
  return Array.isArray(id) ? (id[1] ?? null) : null
}

/**
 * Every file under a folder, however deep.
 *
 * Looking only one level down is what made a shared folder organised as
 * `Video/` + `Scripts/` expand to nothing — and a folder that expands to
 * nothing then gets asked about as a file, which mega refuses because it is a
 * directory. Authors putting the video and its scripts in one link is the
 * normal shape on this forum, and subfolders are how they separate them.
 *
 * mega's public-folder load brings the whole tree in one call, so the walk
 * costs nothing extra. Deep links address a node by id regardless of how far
 * down it sits, so the URLs produced here work the same as the flat ones.
 */
function descendantFiles(folder: MegaNode): MegaNode[] {
  const out: MegaNode[] = []
  const stack = [...(folder.children ?? [])]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const node = stack.pop()!
    const id = childId(node)
    if (node.directory) {
      stack.push(...(node.children ?? []))
      continue
    }
    // A malformed tree that points back at itself would otherwise never end.
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(node)
  }
  return out
}

/**
 * mega reports an exhausted quota through the error it throws. megajs surfaces
 * it in a few shapes depending on where it happens, so match on both the code
 * and the text, and take the wait it suggests when there is one.
 */
function asQuotaError(e: unknown): QuotaExceededError | null {
  const err = e as { message?: string; code?: number | string } | null
  const text = String(err?.message ?? '')
  const overQuota =
    err?.code === -17 || // EOVERQUOTA
    /EOVERQUOTA|over ?quota|bandwidth limit|509/i.test(text)
  if (!overQuota) return null
  // "... try again in 3600 seconds" / "wait 21600s"
  const seconds = Number(/(\d+)\s*(?:seconds|secs?|s\b)/i.exec(text)?.[1] ?? 0)
  // mega's free window is measured in hours; an hour is the conservative
  // default when it does not say.
  return new QuotaExceededError(seconds > 0 ? seconds : 3600)
}

/**
 * mega's API error numbers, which megajs reports inside the message text
 * ("EEXPIRED (-8): ...") rather than on a `code` property. Matching the number
 * is what makes this reliable — the prose around it is megajs's, and it varies
 * by call: `-8` on a dead file link arrives worded as an *upload* URL expiring.
 */
const GONE_CODES = new Set([
  -8, // EEXPIRED  — the link no longer resolves
  -9, // ENOENT    — no such node
  -16 // EBLOCKED — taken down
])
const BAD_LINK_CODES = new Set([
  -2, // EARGS — malformed handle or key
  -14 // EKEY  — the key does not decrypt this node
])

function apiCode(text: string): number | null {
  const found = /\((-\d+)\)/.exec(text)
  return found ? Number(found[1]) : null
}

/**
 * When mega puts a number in the message, that number is the answer and the
 * prose around it is not consulted.
 *
 * The prose is actively misleading — a dead *file* link is reported as an
 * *upload* URL having expired — which is why the codes were introduced in the
 * first place. Leaving the text patterns as an OR meant they could still
 * overrule a perfectly ordinary code: any transient failure whose wording
 * happens to contain "expired" was declared a dead link, and a dead verdict is
 * cached and sticks. The text is only read when there is no code at all.
 */
function rethrow(e: unknown): never {
  const quota = asQuotaError(e)
  if (quota) throw quota
  const text = String((e as Error)?.message ?? e)
  const code = apiCode(text)

  if (code !== null) {
    if (GONE_CODES.has(code)) throw new PermanentError('mega_gone')
    if (BAD_LINK_CODES.has(code)) throw new PermanentError('mega_bad_link')
    // A code we do not recognise is not a verdict: retrying is allowed, and
    // the link is left unproven rather than marked dead.
    throw e instanceof Error ? e : new Error(text)
  }

  if (/not (?:found|exist)|ENOENT|does not exist|has been (?:removed|deleted|terminated)|taken down/i.test(text)) {
    throw new PermanentError('mega_gone')
  }
  if (/Invalid (?:URL|argument)|decrypt|MAC verification/i.test(text)) {
    throw new PermanentError('mega_bad_link')
  }
  throw e instanceof Error ? e : new Error(text)
}

/**
 * Test seam: pretend mega answered "over quota, wait N seconds". Exhausting a
 * real quota to check the cooldown would mean downloading gigabytes.
 */
function forcedQuota(): QuotaExceededError | null {
  const seconds = Number(process.env.FSMGR_MEGA_FORCE_QUOTA ?? '')
  return seconds > 0 ? new QuotaExceededError(seconds) : null
}

async function loadNode(url: string): Promise<MegaNode> {
  const forced = forcedQuota()
  if (forced) throw forced
  const deep = FOLDER_CHILD.exec(normalize(url))
  try {
    if (deep) {
      const folder = File.fromURL(deep[1]!) as unknown as MegaNode
      await folder.loadAttributes()
      const child = (folder.children ?? []).find((c) => childId(c) === deep[2])
      if (!child) throw new PermanentError('mega_gone')
      return child
    }
    const node = File.fromURL(normalize(url)) as unknown as MegaNode
    await node.loadAttributes()
    return node
  } catch (e) {
    if (e instanceof PermanentError || e instanceof QuotaExceededError) throw e
    return rethrow(e)
  }
}

async function sizeOnDisk(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export const megaPlugin: DownloaderPlugin = {
  id: 'mega',

  match(url) {
    const normalized = normalize(url)
    return FILE_URL.test(normalized) || FOLDER_URL.test(normalized)
  },

  /**
   * A folder becomes one job per file, addressed with mega's own deep link so
   * the URL we persist still opens the right file in a browser and can be
   * re-resolved later. A file link stays a single job.
   */
  async expand(url) {
    const normalized = normalize(url)
    if (!FOLDER_URL.test(normalized) || FOLDER_CHILD.test(normalized)) return [normalized]
    const folder = await loadNode(normalized)
    const base = normalized.replace(/\/+$/, '')
    const files = descendantFiles(folder)
    // An empty or unreadable folder keeps the original URL, so the job fails
    // visibly instead of disappearing at enqueue time.
    return files.length > 0 ? files.map((c) => `${base}/file/${childId(c)}`) : [normalized]
  },

  guessFileName(url) {
    return FOLDER_URL.test(normalize(url)) ? 'mega folder' : 'mega file'
  },

  /** Loading the node's attributes is one round trip and no transfer quota. */
  checkCost: 'cheap',

  async resolve(url) {
    const node = await loadNode(url)
    if (node.directory) throw new PermanentError('mega_bad_link')
    return {
      // megajs works from the link, so this stays the source URL; nothing
      // short-lived is persisted.
      url: normalize(url),
      filename: node.name || 'mega file',
      ...(typeof node.size === 'number' ? { sizeBytes: node.size } : {})
    }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    await mkdir(dirname(targetPath), { recursive: true })
    const node = await loadNode(info.url)
    const total = typeof node.size === 'number' ? node.size : undefined
    const offset = await sizeOnDisk(targetPath)
    if (total !== undefined && offset >= total) {
      return { filePath: targetPath, sizeBytes: offset } // already complete
    }

    let stream: ReturnType<MegaNode["download"]>
    try {
      stream = node.download(offset > 0 ? { start: offset } : {})
    } catch (e) {
      return rethrow(e)
    }

    let downloaded = offset
    let windowStart = Date.now()
    let windowBytes = 0
    const pacer = await throttleStage()

    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(targetPath, { flags: offset > 0 ? 'a' : 'w' })
      let settled = false
      const finish = (e?: unknown): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        if (e) reject(e)
        else resolve()
      }

      function onAbort(): void {
        // Destroying makes megajs emit 'error'; the handler below is already
        // attached, which is the only reason this does not kill the process.
        stream.destroy(new Error('aborted'))
        pacer?.destroy()
        out.destroy()
        finish(new Error('aborted'))
      }

      stream.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        windowBytes += chunk.length
        const elapsed = (Date.now() - windowStart) / 1000
        const speed = elapsed > 0 ? windowBytes / elapsed : 0
        onProgress({
          bytesDownloaded: downloaded,
          ...(total !== undefined ? { totalBytes: total } : {}),
          speedBytesPerSec: speed,
          ...(total !== undefined && speed > 0
            ? { etaSec: Math.max(0, (total - downloaded) / speed) }
            : {})
        })
        if (elapsed >= 1) {
          windowStart = Date.now()
          windowBytes = 0
        }
      })
      stream.on('error', finish)
      pacer?.on('error', finish)
      out.on('error', finish)
      out.on('close', () => finish())
      signal.addEventListener('abort', onAbort, { once: true })
      if (pacer) stream.pipe(pacer).pipe(out)
      else stream.pipe(out)
    }).catch((e) => {
      if (signal.aborted) throw e // the queue reads the abort intent
      return rethrow(e)
    })

    return { filePath: targetPath, sizeBytes: await sizeOnDisk(targetPath) }
  }
}
