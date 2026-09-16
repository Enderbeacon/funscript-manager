/**
 * Downloader plugin interface.
 *
 * Expiring-direct-link defense (interface-level contract):
 * - The queue persists the source page URL (download_job.source_url);
 *   DownloadInfo.url is always treated as short-lived and never persisted.
 * - resolve() is called just-in-time, when the job starts — not at enqueue.
 * - Pause/resume, restart-resume, and retry all re-resolve() before
 *   resuming with a Range request.
 * - On mid-download 403/410: re-resolve() once and continue from the offset;
 *   only a failed re-resolve marks the job failed.
 */

export interface DownloaderPlugin {
  /** Plugin id, e.g. 'pixeldrain' | 'mega' | 'gofile' | 'ytdlp' | 'eporner' | 'rule34video' | 'hanime1'. */
  readonly id: string

  /** Whether this plugin handles the given URL. */
  match(url: string): boolean

  /**
   * Expand one URL into several at enqueue time — a folder/album link becomes
   * one job per file (e.g. a pixeldrain `/l/{id}` list). Omitted = one job as-is.
   * This runs when the user adds the URL, not at download time: only the
   * direct link is short-lived, the file list is what the user is choosing.
   */
  expand?(url: string): Promise<string[]>

  /** A name to show before the download starts; refined once headers arrive. */
  guessFileName?(url: string): string

  /**
   * Is checking whether this link is still alive quick enough to do unasked?
   *
   * Cheap means one API call or one HEAD. Everything else is `slow` — a page
   * parse behind a bot check, a hidden browser window, a yt-dlp process — and
   * only runs when the user asks for that link specifically. Absent = slow:
   * a plugin has to say it is cheap, because guessing wrong here means a post
   * view that hangs for half a minute before it shows anything.
   */
  readonly checkCost?: 'cheap' | 'slow'

  /**
   * Liveness check. Optional: without it, resolve() is the probe — for most
   * hosts resolving *is* the existence check, and having one code path means
   * the answer cannot drift from what the download would do. Implement this
   * only when resolving does not touch the network (a plain direct link) or
   * costs much more than asking does.
   */
  check?(url: string): Promise<LinkStatus>

  /**
   * How a person gets a link past a check this host puts in front of it — a
   * bot challenge, a captcha. A job the check stops fails with
   * `verification_required`, and the queue offers to open `pageUrl` in a real
   * window for the person to pass it.
   *
   * - `access`: passing it is all it takes; the job is retried afterwards,
   *   reading the page through the session the check was passed in.
   * - `file`: the page hands the file over itself once passed (a captcha token
   *   good for one request), so the download started in that window is the
   *   job's download.
   */
  readonly verification?: {
    pageUrl(url: string): string
    delivers: 'access' | 'file'
  }

  /** Resolve a URL into download metadata (just-in-time, at job start). */
  resolve(url: string): Promise<DownloadInfo>

  /** Perform the download, reporting progress. */
  download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult>

  /**
   * Drop whatever the plugin kept beside `partPath` when a job is cancelled.
   * The queue deletes the .part file itself; a plugin that stages its work
   * elsewhere (ytdlp downloads into a sibling directory) needs this hook so
   * cancelling really leaves nothing behind.
   */
  cleanup?(partPath: string): Promise<void>
}

/**
 * What a liveness check found.
 *
 * Two of these are claims: `alive` (the host handed over the file's details)
 * and `gone` (the host said it is not there). `unknown` is a third answer —
 * asked, and the host said something that settles nothing.
 *
 * `unchecked` is not an answer at all: nobody asked. It is separate because
 * the two look identical from the outside and mean opposite things to whoever
 * is reading the card — one is a result, the other is an offer. Showing "could
 * not tell" for a link nothing had looked at is how a button stops looking
 * like a button.
 *
 * Nothing is ever marked dead on a guess.
 */
export type LinkStatus = 'alive' | 'gone' | 'unknown' | 'unchecked'

export interface DownloadInfo {
  /** Resolved direct link. Short-lived, not persisted. For some sources (mega) this is an opaque session string. */
  url: string
  filename: string
  sizeBytes?: number
  mimeType?: string
  /** Source-specific state, letting download() reuse resolve()'s work. */
  context?: Record<string, unknown>
}

export interface ProgressEvent {
  bytesDownloaded: number
  totalBytes?: number
  speedBytesPerSec?: number
  etaSec?: number
}

export interface DownloadResult {
  filePath: string
  sizeBytes: number
  contentSha256?: string
  /** Name the server advertised (Content-Disposition), when it had one. */
  fileName?: string
}

/** Thrown on an expired direct link (403/410/bad signature); the queue re-resolves and resumes. */
export class DirectLinkExpiredError extends Error {
  constructor(readonly httpStatus: number) {
    super(`direct link expired (HTTP ${httpStatus})`)
    this.name = 'DirectLinkExpiredError'
  }
}

/** Any other non-2xx response; the queue's retry policy reads the status. */
export class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`)
    this.name = 'HttpStatusError'
  }
}

/**
 * A failure retrying cannot fix — a removed video, an unsupported URL, a
 * missing yt-dlp. The queue fails the job at once and shows `reason`, which is
 * a code the renderer can translate (`downloads.jobError.<reason>`).
 */
export class PermanentError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PermanentError'
  }
}

/**
 * The host says "come back later" — mega's rolling free-tier quota.
 * Not a retry: backing off exponentially would burn the retry budget on a wait
 * whose length the host already told us. The job parks until `retryAt` and
 * resumes on its own from the bytes it already has.
 */
export class QuotaExceededError extends Error {
  readonly retryAt: Date
  constructor(waitSeconds: number) {
    super(`over quota, retry in ${waitSeconds}s`)
    this.name = 'QuotaExceededError'
    this.retryAt = new Date(Date.now() + Math.max(1, waitSeconds) * 1000)
  }
}

/**
 * The host is turning requests away for a while — too many from this address.
 *
 * Handled like a quota — the job parks and comes back on its own, because a
 * retry within seconds only extends the ban — but it is not one: a quota says
 * the file is there and rationed, this says nothing about the file at all. A
 * link check that hits it has no answer, not a live link.
 */
export class RateLimitedError extends Error {
  readonly retryAt: Date
  constructor(waitSeconds: number) {
    super(`rate limited, retry in ${waitSeconds}s`)
    this.name = 'RateLimitedError'
    this.retryAt = new Date(Date.now() + Math.max(1, waitSeconds) * 1000)
  }
}

const plugins: DownloaderPlugin[] = []

/**
 * Registration order is match order, and the generic direct-link plugin
 * matches every http(s) URL — so it has to be registered last.
 */
export function registerPlugin(plugin: DownloaderPlugin): void {
  plugins.push(plugin)
}

export function findPlugin(url: string): DownloaderPlugin | undefined {
  return plugins.find((p) => p.match(url))
}

/** The catch-all: it claims every http(s) URL, so it proves nothing about one. */
const GENERIC_PLUGIN_ID = 'direct'

/**
 * Does a real downloader handle this link — one that knows the host, rather
 * than the generic fallback that would just save whatever bytes come back?
 *
 * This is the question the forum scraper asks when deciding whether a link
 * buried in a reply is worth showing. Asking the registry rather than keeping a
 * second list of domains is the point: registering a new plugin is all it takes
 * for its links to start being recognised in replies too.
 */
export function canDownload(url: string): boolean {
  const plugin = findPlugin(url)
  return plugin !== undefined && plugin.id !== GENERIC_PLUGIN_ID
}

/** Test seam: drop every registration (the app registers once at startup). */
export function clearPlugins(): void {
  plugins.length = 0
}

