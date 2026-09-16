import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, sep } from 'node:path'
import { FUNSCRIPT_EXTENSION, LIBRARY_CACHE_DIR } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { DownloadJob, DownloadProgress } from '@shared/schemas/download'
import type { ScrapedLink, ScrapedPost } from '@shared/schemas/scraped-post'
import { getSettings, listLibraries } from '../config/config-service'
import { isMediaFile } from '../library/companion-grouping'
import { attachScriptsToMedia, fillWantedFromDownload } from '../library/library-manager'
import { setActiveDownloads } from '../net/throttle'
import {
  DirectLinkExpiredError,
  HttpStatusError,
  PermanentError,
  QuotaExceededError,
  findPlugin,
  type DownloaderPlugin,
  type ProgressEvent
} from './base'
import { fileNameFromUrl } from './direct'
import { batchSettled, finalizeBatch } from './post-ingest'
import * as store from './store'

/**
 * Download scheduler.
 *
 * Concurrency: a global cap from settings, plus one running job per hoster —
 * the per-hoster limit is what keeps a source from rate-limiting us, so it is
 * enforced when picking the next job rather than by a second queue layer.
 *
 * Not p-queue: it is ESM-only and this main process is bundled as CJS.
 * The rules here (per-hoster serialization, status-aware retry, re-resolve on
 * expiry) are specific enough that a generic concurrency limiter would only
 * cover the easy part anyway.
 *
 * Resume offset always comes from the .part file's size on disk, never from
 * the stored byte count — the file is the truth, the row is for display.
 */

const PROGRESS_INTERVAL_MS = 250 // at most 4 Hz to the renderer
const PERSIST_INTERVAL_MS = 2000
const MAX_NETWORK_RETRIES = 3
const MAX_SERVER_RETRIES = 5
const MAX_EXPIRY_RE_RESOLVES = 2

export interface DownloadQueueEvents {
  'jobs-changed': () => void
  progress: (list: DownloadProgress[]) => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof DownloadQueueEvents>(e: K, l: DownloadQueueEvents[K]): this {
    return super.on(e, l)
  }
  override emit<K extends keyof DownloadQueueEvents>(
    e: K,
    ...args: Parameters<DownloadQueueEvents[K]>
  ): boolean {
    return super.emit(e, ...args)
  }
}

export const downloadEvents = new TypedEmitter()

/** What the user asked for when a running job is aborted. */
type Intent = 'pause' | 'cancel'

interface RunningJob {
  controller: AbortController
  hoster: string
  intent: Intent | null
}

const running = new Map<string, RunningJob>()
const progressBuf = new Map<string, DownloadProgress>()
const lastPersist = new Map<string, number>()
let progressTimer: NodeJS.Timeout | null = null
let pumping = false
let started = false

function notifyChanged(): void {
  downloadEvents.emit('jobs-changed')
}

function flushProgress(): void {
  if (progressBuf.size === 0) {
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }
    return
  }
  downloadEvents.emit('progress', [...progressBuf.values()])
  progressBuf.clear()
}

function scheduleProgress(): void {
  if (!progressTimer) progressTimer = setInterval(flushProgress, PROGRESS_INTERVAL_MS)
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** 1s, 2s, 4s… capped — the same shape for network and 5xx retries. */
function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1))
}

async function libraryRoot(libraryId: string): Promise<string> {
  const library = (await listLibraries()).find((l) => l.id === libraryId)
  if (!library) throw new AppError('library_not_found')
  return library.rootPath
}

/** Partial downloads live in the library's cache dir, which the watcher ignores. */
function partPathFor(root: string, jobId: string): string {
  return join(root, LIBRARY_CACHE_DIR, 'cache', 'incoming', `${jobId}.part`)
}

/**
 * Byte counts cross into a schema that says integer. Not every source obeys:
 * yt-dlp's running total for an HLS stream is an estimate with a fraction, and
 * one such value used to make `download:list` fail validation — which blanks
 * the whole downloads page, not just that row.
 */
function bytes(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

/** `clip.mp4` → `clip (2).mp4` until the name is free. */
function freePath(dir: string, fileName: string): string {
  const ext = extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  let candidate = join(dir, fileName)
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`)
  return candidate
}

/** Windows-hostile characters, so a server-supplied name cannot break the write. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim()
  return cleaned || 'download'
}

export async function init(): Promise<void> {
  if (started) return
  started = true
  const demoted = store.demoteInterrupted()
  if (demoted > 0) console.log(`[downloads] ${demoted} interrupted job(s) moved to paused`)
  // A cooldown outlives the process: re-arm the wake-ups, and start anything
  // whose window reopened while the app was closed.
  for (const job of store.list()) {
    if (job.state !== 'cooling') continue
    armCooldown(job.id, new Date(job.cooldownUntil ?? 0))
  }
  await pump()
}

export function dispose(): void {
  for (const [, job] of running) {
    job.intent = 'pause'
    job.controller.abort()
  }
  for (const timer of coolTimers.values()) clearTimeout(timer)
  coolTimers.clear()
  if (progressTimer) clearInterval(progressTimer)
  progressTimer = null
  store.closeStore()
  started = false
}

export function listJobs(): DownloadJob[] {
  // partPath and the raw post JSON are implementation detail; the renderer
  // gets the projection only — plus the two things the queue UI needs out of
  // that JSON. A file name alone does not say which post it belongs to, and
  // "VRPRD-016_B_4K.mp4" looks the same in a list of twelve.
  return store.listNewestFirst().map(
    ({
      partPath: _partPath,
      namePinned: _pinned,
      mediaId: _mediaId,
      ingested: _ingested,
      awaitingPair: _awaitingPair,
      postJson,
      ...job
    }) => {
      const from = postJson ? parsePostJson(postJson) : null
      return {
        ...job,
        postTitle: from?.title ?? '',
        postUrl: from?.postUrl ?? '',
        postThumb: from?.previewImage ?? ''
      }
    }
  )
}

/** The stored post, or null when it is unreadable — a job must still list. */
function parsePostJson(json: string): ScrapedPost | null {
  try {
    return JSON.parse(json) as ScrapedPost
  } catch {
    return null
  }
}

/**
 * A name to start a job under. `pinned` means it came from something that knows
 * better than the source — nothing discovered during the download replaces it.
 * An unpinned name is only a starting point.
 */
interface NameHint {
  value: string
  pinned: boolean
}

interface JobOptions {
  name?: NameHint
  batch?: { batchId: string; role: DownloadJob['role']; postJson: string }
  /**
   * The library entry this download is for — one waiting for its video. The
   * file goes straight into it on arrival instead of becoming an entry of its
   * own.
   */
  mediaId?: string
}

/** One job to be, before anything is written. */
interface PlannedJob {
  sourceUrl: string
  hoster: string
  fileName: string
  namePinned: boolean
}

/**
 * Enqueue the links a user ticked in a parsed post. They share a batch id so
 * post-download ingest can run once the whole set has settled, and each job
 * records what it is (video / script) and the post it came from.
 *
 * All or nothing. Every link is looked at — folders listed — before any job is
 * written, because a folder listing can fail after the links before it were
 * already queued: the scripts would download on their own, file themselves as
 * a post with no video, and the user pressing Download again would fetch them a
 * second time.
 */
export async function addPostJobs(
  libraryId: string,
  post: ScrapedPost,
  urls: string[],
  /** Post link URL → a direct link the user pasted in its place (payhip, or a
   *  source whose parse broke). The job downloads from this address but keeps
   *  the post link's role and batch, so ingest still works on it. */
  manualLinks: Record<string, string> = {}
): Promise<{ jobIds: string[]; batchId: string }> {
  const root = await libraryRoot(libraryId)
  const batch = { batchId: randomUUID(), postJson: JSON.stringify(post) }

  const plans: { planned: PlannedJob[]; role: DownloadJob['role'] }[] = []
  for (const url of urls) {
    const link = post.links.find((l) => l.url === url)
    if (!link) continue
    const target = manualLinks[url]?.trim() || url
    // A pasted link names the file itself, so the post's label — which for a
    // store page is just the page address — must not override it.
    const name = link.isAttachment && target === url ? attachmentName(link, post) : undefined
    plans.push({
      planned: await planJobs(target, name),
      role: link.isScript ? 'script' : 'video'
    })
  }

  const jobIds = plans.flatMap(({ planned, role }) =>
    insertPlanned(planned, libraryId, root, { batch: { ...batch, role } })
  )
  notifyChanged()
  void pump()
  return { jobIds, batchId: batch.batchId }
}

/**
 * What to save a forum attachment as.
 *
 * The link text is usually the file's name, and a better one than the upload's
 * hash. But authors retitle links: three scripts posted as "Sex only", with no
 * extension and the same words each time, were saved as `Sex only`,
 * `Sex only (2)` and `Sex only (3)` — files the library cannot recognise, with
 * their axes lost. So the text is only trusted when it looks like a file name
 * and no other attachment in the post shares it; otherwise the name the forum
 * sends with the file wins, and the text, given the extension it has to have,
 * is only the fallback.
 */
function attachmentName(link: ScrapedLink, post: ScrapedPost): NameHint {
  const label = link.label.trim()
  const extension = link.isScript ? FUNSCRIPT_EXTENSION : extname(fileNameFromUrl(link.url))
  const named = link.isScript
    ? label.toLowerCase().endsWith(FUNSCRIPT_EXTENSION)
    : /\.[a-z0-9]{2,5}$/i.test(label)
  const shared =
    post.links.filter((l) => l.isAttachment && l.label.trim().toLowerCase() === label.toLowerCase())
      .length > 1
  if (named && !shared) return { value: label, pinned: true }
  return { value: named ? label : `${label}${extension}`, pinned: false }
}

/**
 * Enqueue a URL. A folder link expands into one job per file at this point
 * (the user is choosing files, and only the *direct link* is short-lived).
 */
export async function addJobs(
  url: string,
  libraryId: string,
  options: JobOptions = {}
): Promise<string[]> {
  const root = await libraryRoot(libraryId)
  const ids = insertPlanned(await planJobs(url, options.name), libraryId, root, options)
  notifyChanged()
  void pump()
  return ids
}

/** Find the plugin and list the files behind a URL, without writing anything. */
async function planJobs(url: string, name?: NameHint): Promise<PlannedJob[]> {
  const plugin = findPlugin(url)
  if (!plugin) throw new AppError('download_no_plugin', { url })

  let urls = [url]
  if (plugin.expand) {
    try {
      urls = await plugin.expand(url)
    } catch (e) {
      // A folder listing that fails is worth surfacing: the user asked for
      // several files and would otherwise silently get one broken job.
      console.error(`[downloads] could not list ${url}:`, e)
      throw new AppError('download_expand_failed', { url })
    }
  }

  return urls.map((one) => {
    // A hint only makes sense for a single job; an expanded folder has one
    // real name per file and takes them from the source instead.
    const hint = urls.length === 1 ? name : undefined
    return {
      sourceUrl: one,
      hoster: plugin.id,
      fileName: safeFileName(hint?.value ?? plugin.guessFileName?.(one) ?? 'download'),
      namePinned: hint?.pinned ?? false
    }
  })
}

function insertPlanned(
  planned: PlannedJob[],
  libraryId: string,
  root: string,
  options: JobOptions
): string[] {
  return planned.map((job) => {
    const id = randomUUID()
    store.insert({
      id,
      ...job,
      libraryId,
      partPath: partPathFor(root, id),
      ...(options.batch ?? {}),
      ...(options.mediaId ? { mediaId: options.mediaId } : {})
    })
    return id
  })
}

export async function pauseJob(id: string): Promise<void> {
  const active = running.get(id)
  if (active) {
    active.intent = 'pause'
    active.controller.abort()
    return
  }
  const job = store.get(id)
  if (!job || job.state === 'done') return
  store.update(id, { state: 'paused' })
  notifyChanged()
}

export async function resumeJob(id: string): Promise<void> {
  const job = store.get(id)
  if (!job || job.state === 'running' || job.state === 'done') return
  // Resuming by hand overrides a cooldown: the user may know the quota is back.
  store.update(id, { state: 'pending', error: null, cooldownUntil: null })
  notifyChanged()
  await pump()
}

/** Retry a failed job from its partial bytes, with a clean retry budget. */
export async function retryJob(id: string): Promise<void> {
  const job = store.get(id)
  if (!job || job.state === 'running') return
  store.update(id, { state: 'pending', error: null, attempts: 0 })
  notifyChanged()
  await pump()
}

export async function cancelJob(id: string): Promise<void> {
  const active = running.get(id)
  if (active) {
    // The running attempt cleans up once it unwinds; aborting mid-write and
    // deleting the file from here would race the stream.
    active.intent = 'cancel'
    active.controller.abort()
    return
  }
  await discard(id)
}

async function discard(id: string): Promise<void> {
  const job = store.get(id)
  if (!job) return
  clearTimeout(coolTimers.get(id))
  coolTimers.delete(id)
  await rm(job.partPath, { force: true }).catch(() => {})
  // Plugins that stage their work elsewhere (ytdlp) clean that up themselves.
  await findPlugin(job.sourceUrl)?.cleanup?.(job.partPath).catch(() => {})
  store.remove(id)
  progressBuf.delete(id)
  notifyChanged()
}

export function clearFinished(): void {
  if (store.removeFinished().length > 0) notifyChanged()
}

/** States that mean the batch this job belongs to has not settled yet. */
const UNSETTLED = new Set(['pending', 'running', 'paused', 'cooling'])

/**
 * Is anything still on its way into this library?
 *
 * Asked by the scanner. Scripts are kilobytes and land long before the video
 * they belong to, and until the whole batch settles nothing has told the
 * library they belong together — so a scan in that window sees loose funscripts
 * and files them as videos-still-to-come. The post's own ingest then creates
 * the real entry, and the library is left holding one entry per script plus the
 * right one.
 *
 * A settled batch is still on its way in until its ingest has run. The last
 * file to land wakes the scanner as well as the ingest, and the ingest waits
 * for that very scan to index the video — so without this the scan would reach
 * the loose scripts first, every time, and file the ones that belong to a video
 * that failed, or that are waiting for the user to pick theirs.
 *
 * Waiting costs nothing: a genuinely orphaned script gets its entry on the next
 * scan, once the queue is quiet and the answer cannot change under us.
 */
export function isBusyFor(libraryId: string): boolean {
  return store
    .list()
    .some(
      (job) =>
        job.libraryId === libraryId &&
        (UNSETTLED.has(job.state) ||
          (job.batchId !== null && job.state === 'done' && !job.ingested && !job.awaitingPair))
    )
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    const { download } = await getSettings()
    while (running.size < download.globalConcurrency) {
      const busy = new Set([...running.values()].map((r) => r.hoster))
      const next = store.nextPending(busy)
      if (!next) break
      startJob(next)
    }
  } catch (e) {
    console.error('[downloads] pump failed:', e)
  } finally {
    pumping = false
  }
}

function startJob(job: store.JobRecord): void {
  const plugin = findPlugin(job.sourceUrl)
  if (!plugin) {
    store.update(job.id, { state: 'failed', error: 'download_no_plugin' })
    notifyChanged()
    return
  }
  const entry: RunningJob = { controller: new AbortController(), hoster: job.hoster, intent: null }
  running.set(job.id, entry)
  setActiveDownloads(running.size)
  store.update(job.id, { state: 'running', error: null })
  notifyChanged()

  void runJob(job, plugin, entry)
    .catch((e) => console.error(`[downloads] job ${job.id} crashed:`, e))
    .finally(() => {
      running.delete(job.id)
      setActiveDownloads(running.size)
      progressBuf.delete(job.id)
      lastPersist.delete(job.id)
      void settleBatch(job.batchId)
      void pump()
    })
}

async function runJob(
  job: store.JobRecord,
  plugin: DownloaderPlugin,
  entry: RunningJob
): Promise<void> {
  const signal = entry.controller.signal
  let networkRetries = 0
  let serverRetries = 0
  let expiryReResolves = 0

  const onProgress = (p: ProgressEvent): void => {
    progressBuf.set(job.id, {
      id: job.id,
      bytesDownloaded: bytes(p.bytesDownloaded),
      totalBytes: p.totalBytes !== undefined ? bytes(p.totalBytes) : null,
      speedBytesPerSec: Math.max(0, p.speedBytesPerSec ?? 0),
      etaSec: p.etaSec !== undefined ? Math.max(0, p.etaSec) : null
    })
    scheduleProgress()
    const now = Date.now()
    if (now - (lastPersist.get(job.id) ?? 0) >= PERSIST_INTERVAL_MS) {
      lastPersist.set(job.id, now)
      store.update(job.id, {
        bytesDownloaded: bytes(p.bytesDownloaded),
        ...(p.totalBytes !== undefined ? { totalBytes: bytes(p.totalBytes) } : {})
      })
    }
  }

  /**
   * `error` is always a code the renderer translates — never raw text. A status
   * line or a library's exception message is for the log, which is where the
   * detail goes; the user gets a sentence and a link to the source.
   */
  const fail = (error: string, detail?: unknown): void => {
    if (detail !== undefined) {
      console.error(`[downloads] job ${job.id} failed (${error}):`, detail)
    }
    store.update(job.id, { state: 'failed', error })
    notifyChanged()
  }

  for (;;) {
    if (signal.aborted) return settleAborted(job, entry)
    try {
      // Just-in-time resolve: never persisted, re-done on every resume and
      // retry so an expiring signature is always fresh.
      const info = await plugin.resolve(job.sourceUrl)
      if (signal.aborted) return settleAborted(job, entry)

      // A pinned name came from something that knows better than the URL (a
      // forum post naming its attachment); nothing discovered later overrides it.
      if (!job.namePinned) {
        const named = safeFileName(info.filename || job.fileName)
        if (named !== job.fileName) store.update(job.id, { fileName: named })
      }
      if (info.sizeBytes !== undefined) store.update(job.id, { totalBytes: bytes(info.sizeBytes) })
      notifyChanged()

      const result = await plugin.download(info, job.partPath, onProgress, signal)
      // The transfer finished and the bytes are on disk. A pause that landed in
      // that same instant is too late to be worth throwing the file away and
      // downloading it a second time — only an explicit cancel still wins.
      if (signal.aborted && entry.intent === 'cancel') return settleAborted(job, entry)
      // Content-Disposition is the most authoritative name a plain link has.
      if (!job.namePinned && result.fileName) {
        store.update(job.id, { fileName: safeFileName(result.fileName) })
      }

      await finish(job.id)
      return
    } catch (e) {
      if (signal.aborted) return settleAborted(job, entry)

      // A removed video, an unsupported URL, no yt-dlp installed — retrying
      // changes nothing, so say what is wrong and stop.
      if (e instanceof PermanentError) return fail(e.reason)

      // The host told us how long to wait. Park until then and pick up from
      // the bytes already on disk; this must not eat the retry budget.
      if (e instanceof QuotaExceededError) return cool(job.id, e.retryAt)

      if (e instanceof DirectLinkExpiredError) {
        // Not a normal retry: re-resolve and continue from the offset. Only a
        // second failure in a row means the link really is dead.
        if (++expiryReResolves > MAX_EXPIRY_RE_RESOLVES) {
          return fail(reasonForStatus(e.httpStatus), e)
        }
        continue
      }

      if (e instanceof HttpStatusError) {
        if (e.status >= 500) {
          if (++serverRetries > MAX_SERVER_RETRIES) return fail(reasonForStatus(e.status), e)
          store.update(job.id, { attempts: networkRetries + serverRetries })
          notifyChanged()
          await sleep(backoffMs(serverRetries), signal)
          continue
        }
        // 4xx is authentication or a dead link; retrying just burns time.
        return fail(reasonForStatus(e.status), e)
      }

      if (++networkRetries > MAX_NETWORK_RETRIES) return fail('network_failed', e)
      store.update(job.id, { attempts: networkRetries + serverRetries })
      notifyChanged()
      await sleep(backoffMs(networkRetries), signal)
    }
  }
}

/**
 * HTTP status → a failure code the renderer has a sentence for.
 *
 * A status number is not a reason a user can act on, and half of them mean the
 * same thing to whoever is looking at the queue. What differs is what to do
 * next: sign in, find another mirror, or wait — so that is what the codes split
 * on. The status itself goes to the log.
 */
function reasonForStatus(status: number): string {
  if (status === 404 || status === 410) return 'link_gone'
  if (status === 401 || status === 403) return 'link_denied'
  if (status === 429) return 'host_busy'
  if (status >= 500) return 'host_down'
  return 'link_broken'
}

/** Timers waking parked jobs; keyed by job id so a cancel can drop them. */
const coolTimers = new Map<string, NodeJS.Timeout>()

/**
 * Park a job until the host's quota window reopens. The wake-up is scheduled
 * in memory *and* the deadline is stored, so a restart in the middle of a long
 * cooldown does not strand the job (init re-arms it).
 */
function cool(id: string, retryAt: Date): void {
  store.update(id, { state: 'cooling', cooldownUntil: retryAt.toISOString(), error: null })
  notifyChanged()
  armCooldown(id, retryAt)
}

function armCooldown(id: string, retryAt: Date): void {
  clearTimeout(coolTimers.get(id))
  // setTimeout saturates past ~24.8 days; nothing mega hands out comes close,
  // but clamp rather than fire immediately if it ever does.
  const delay = Math.min(Math.max(0, retryAt.getTime() - Date.now()), 2 ** 31 - 1)
  coolTimers.set(
    id,
    setTimeout(() => {
      coolTimers.delete(id)
      const job = store.get(id)
      if (!job || job.state !== 'cooling') return
      store.update(id, { state: 'pending', cooldownUntil: null })
      notifyChanged()
      void pump()
    }, delay)
  )
}

/** The ingest pass running or queued for each batch; one at a time per batch. */
const settling = new Map<string, Promise<void>>()

/**
 * Run post-download ingest whenever the batch has settled. A paused job keeps
 * the batch open on purpose: the user may still resume it, and the metadata
 * write wants the complete set.
 *
 * A batch can settle again later — a failed job retried — and ingest files only
 * what is new, so running it again is safe. Running it twice at once is not:
 * two jobs of one batch finishing together would both find the same scripts
 * unfiled. So passes over one batch queue up behind each other.
 */
async function settleBatch(batchId: string | null): Promise<void> {
  if (!batchId) return
  const run = (settling.get(batchId) ?? Promise.resolve()).then(async () => {
    if (!batchSettled(batchId)) return
    try {
      await finalizeBatch(batchId)
    } catch (e) {
      console.error(`[downloads] batch ${batchId} ingest failed:`, e)
    }
    notifyChanged()
  })
  settling.set(batchId, run)
  await run
  if (settling.get(batchId) === run) settling.delete(batchId)
}

/**
 * Scripts waiting for the user to pick their video, as library-relative path
 * keys. The scanner must not file these as entries of their own while the
 * question is open — they have an owner, it just has not been named yet.
 */
export function awaitingPairKeys(libraryId: string, root: string): Set<string> {
  return new Set(
    store
      .listAwaitingPair()
      .filter((job) => job.libraryId === libraryId && job.filePath)
      .map((job) => relative(root, job.filePath!).split(sep).join('/').toLowerCase())
  )
}

/** An aborted attempt is either the user pausing or the user cancelling. */
function settleAborted(job: store.JobRecord, entry: RunningJob): void {
  if (entry.intent === 'cancel') {
    void discard(job.id)
    return
  }
  store.update(job.id, { state: 'paused' })
  notifyChanged()
}

/**
 * Move the finished .part into the library root under its real name. The
 * library watcher takes it from there — that is the same ingest path a file
 * dropped in by hand goes through, so downloads need no special casing.
 *
 * The exception is a download meant for an entry that is waiting for its
 * video: that file goes straight into the entry.
 */
async function finish(id: string): Promise<void> {
  const job = store.get(id)
  if (!job) return

  if (job.mediaId && isMediaFile(job.fileName)) {
    const placed = await fillWantedFromDownload(
      job.libraryId,
      job.mediaId,
      job.partPath,
      job.fileName
    ).catch((e) => {
      console.error(`[downloads] job ${id} could not fill its entry:`, e)
      return null
    })
    if (placed) {
      await markDone(id, placed, { ingested: true })
      return
    }
    // The entry was merged, removed or filled some other way in the meantime.
    // The file is still wanted; it is filed like any other download.
    store.update(id, { mediaId: null })
  }

  const root = await libraryRoot(job.libraryId)
  const target = freePath(root, job.fileName)
  await mkdir(dirname(target), { recursive: true })
  await rename(job.partPath, target)

  // A script from a link pasted for an entry — a folder holding the video and
  // its scripts — belongs to that entry; there is no post to pair it by. Filed
  // before the job reads as done, so the scanner never sees it unowned.
  if (!job.batchId && job.mediaId && job.fileName.toLowerCase().endsWith(FUNSCRIPT_EXTENSION)) {
    await attachScriptsToMedia(job.libraryId, job.mediaId, [{ absPath: target }], {}).catch((e) =>
      console.error(`[downloads] job ${id} could not join its entry:`, e)
    )
    await markDone(id, target, { ingested: true })
    return
  }
  await markDone(id, target)
}

async function markDone(id: string, filePath: string, extra: store.JobPatch = {}): Promise<void> {
  const size = (await stat(filePath)).size
  store.update(id, {
    state: 'done',
    filePath,
    bytesDownloaded: size,
    totalBytes: size,
    error: null,
    ...extra
  })
  notifyChanged()
}
