import { spawn } from 'node:child_process'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { bandsByPreference, type QualityPreference } from '@shared/quality'
import { getSettings } from '../config/config-service'
import { resolveFfmpeg, resolveYtdlp } from '../deps/binaries'
import { currentProxy } from '../net/proxy'
import { processRateLimit } from '../net/throttle'
import { cookieFileFor } from '../sites/site-login'
import {
  DirectLinkExpiredError,
  HttpStatusError,
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'

/**
 * yt-dlp wrapper. Main path for pornhub, and the fallback the page-direct
 * parsers (eporner, rule34video, spankbang) call when a page will not parse.
 *
 * Two things make this different from the http plugins:
 *
 * - **yt-dlp owns the download.** It picks formats, downloads video and audio
 *   separately and merges them with ffmpeg, so it cannot write straight into
 *   the queue's `<id>.part`. It works in a sibling directory and the finished
 *   file is moved onto that path at the end; the queue's rename-into-library
 *   step then works exactly as it does for every other plugin.
 * - **Resume is yt-dlp's own.** Its `--continue` (the default) picks up its
 *   internal .part file, which is why the work directory is stable per job:
 *   pause, restart, retry all re-run the same command and it resumes with a
 *   Range request rather than starting over.
 */

/** Hosts routed to yt-dlp. FSMGR_YTDLP_HOSTS adds more (smoke tests). */
const HOSTS = [
  /(^|\.)pornhub\.com$/i,
  /(^|\.)eporner\.com$/i,
  /(^|\.)rule34video\.com$/i,
  /(^|\.)spankbang\.(com|party)$/i
]

/** Marks our own progress lines in a stdout stream that also carries yt-dlp's chatter. */
const PROGRESS_PREFIX = 'FSMGRP|'

const PROGRESS_TEMPLATE =
  'download:' +
  PROGRESS_PREFIX +
  '%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|' +
  '%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s'

/** yt-dlp prints "NA" for anything it does not know yet. */
function num(value: string | undefined): number | undefined {
  if (!value || value === 'NA') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function extraHosts(): string[] {
  return (process.env.FSMGR_YTDLP_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

async function ytdlpPath(): Promise<string> {
  const exe = await resolveYtdlp()
  if (!exe) throw new PermanentError('ytdlp_not_installed')
  return exe
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

interface RunOptions {
  signal?: AbortSignal
  /** Called for every complete stdout line while the process runs. */
  onLine?: (line: string) => void
  timeoutMs?: number
}

/**
 * Run yt-dlp to completion. Killing is a tree kill on Windows: yt-dlp spawns
 * ffmpeg for merging, and killing only the parent would leave it holding the
 * output file open.
 */
function run(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      reject(new PermanentError('ytdlp_not_installed'))
      return
    }

    let stdout = ''
    let stderr = ''
    let pending = ''
    let spawnError: NodeJS.ErrnoException | null = null

    const kill = (): void => {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      if (process.platform === 'win32' && proc.pid !== undefined) {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        proc.kill('SIGTERM')
      }
    }

    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null
    opts.signal?.addEventListener('abort', kill, { once: true })

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      if (!opts.onLine) return
      pending += text
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) opts.onLine(line)
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('error', (e: NodeJS.ErrnoException) => {
      spawnError = e
    })
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', kill)
      if (pending && opts.onLine) opts.onLine(pending)
      if (spawnError) {
        // ENOENT is the common one: no yt-dlp on PATH and none configured.
        reject(
          spawnError.code === 'ENOENT'
            ? new PermanentError('ytdlp_not_installed')
            : new Error(String(spawnError.message))
        )
        return
      }
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * Turn a failed run into the error the queue's retry policy understands.
 * An HTTP status keeps the normal rules (4xx dead, 5xx backoff, 403/410
 * re-resolve); anything recognisably terminal fails at once; the rest falls
 * through as a plain error, i.e. a network blip worth a few retries.
 */
function classify(stderr: string): Error {
  const status = /HTTP Error (\d{3})/i.exec(stderr)
  if (status) {
    const code = Number(status[1])
    if (code === 403 || code === 410) return new DirectLinkExpiredError(code)
    return new HttpStatusError(code)
  }
  if (/Unsupported URL|is not a valid URL/i.test(stderr)) {
    return new PermanentError('ytdlp_unsupported')
  }
  // "Unable to extract hash" and friends mean the site changed and yt-dlp's
  // extractor has not caught up (eporner, 2026-07). Retrying just asks the
  // site the same broken question four times.
  if (/Unable to extract|Failed to extract|please report this issue/i.test(stderr)) {
    return new PermanentError('ytdlp_extractor_broken')
  }
  /*
   * "The video is not there." Every site words it differently and yt-dlp
   * passes the wording through — Pornhub says "This video has been disabled",
   * which matched none of the old patterns, so a video the site itself calls
   * dead came back as an unrecognised error: four pointless retries on the
   * download path, and "could not tell" on the link check.
   */
  if (
    /unavailable|has been (removed|deleted|disabled|terminated)|been deleted|no longer available|not available|Private video|does not exist|taken down|violat/i.test(
      stderr
    )
  ) {
    return new PermanentError('ytdlp_unavailable')
  }
  if (/Sign in|log ?in|age.?restricted|members[- ]only|premium/i.test(stderr)) {
    return new PermanentError('ytdlp_auth')
  }
  return new Error(firstErrorLine(stderr) || 'ytdlp_failed')
}

function firstErrorLine(stderr: string): string {
  const line = stderr.split(/\r?\n/).find((l) => l.trim().startsWith('ERROR:'))
  return (line ?? '').trim().slice(0, 200)
}

interface ProbeJson {
  title?: string
  ext?: string
  filesize?: number | null
  filesize_approx?: number | null
  requested_downloads?: { filesize?: number | null; filesize_approx?: number | null }[]
}

/** Sum of what yt-dlp expects to fetch — video + audio when they are separate. */
function expectedSize(info: ProbeJson): number | undefined {
  const parts = info.requested_downloads ?? []
  if (parts.length > 0) {
    let total = 0
    for (const part of parts) {
      const size = part.filesize ?? part.filesize_approx
      if (!size) return undefined // one unknown part makes the sum a lie
      total += size
    }
    return total
  }
  return info.filesize ?? info.filesize_approx ?? undefined
}

/** Format selection from the user's quality preference. */
function formatArgs(quality: QualityPreference): string[] {
  // ext:mp4:m4a only breaks ties — never at the cost of resolution.
  const common = ['-S', 'ext:mp4:m4a', '--merge-output-format', 'mp4']
  if (quality === 'best') return ['-f', 'bv*+ba/b', ...common]

  /**
   * yt-dlp does its own extraction, so the formats are never ours to sort
   * through — the preference has to be expressed in its language instead.
   *
   * `-S res:N` would not do: it picks whatever is *closest* to N, which sends
   * a request for 720p down to 480p when the site jumps straight to 1080p. So
   * the bands are tried in order and the first one that has anything wins,
   * which is the rule itself, written out.
   */
  const branches = bandsByPreference(quality).map((band) => {
    const range = band.max === null ? `[height>=${band.min}]` : `[height>=${band.min}][height<${band.max}]`
    return `bv*${range}+ba/b${range}`
  })
  // Last resort: a source that reports no height at all still downloads.
  branches.push('bv*+ba/b')
  return ['-f', branches.join('/'), ...common]
}

/** Proxy arguments; the app-wide setting applies to this process too. */
function netArgs(): string[] {
  const proxy = currentProxy()
  return proxy ? ['--proxy', proxy] : []
}

/** Where yt-dlp does its work: a directory beside the queue's .part file. */
function workDirFor(targetPath: string): string {
  return `${targetPath}.d`
}

export const ytdlpPlugin: DownloaderPlugin = {
  id: 'ytdlp',

  match(url) {
    try {
      const { hostname } = new URL(url)
      if (HOSTS.some((h) => h.test(hostname))) return true
      return extraHosts().includes(hostname.toLowerCase())
    } catch {
      return false
    }
  },

  guessFileName(url) {
    try {
      return new URL(url).pathname.split('/').filter(Boolean).pop() || 'video'
    } catch {
      return 'video'
    }
  },

  /** Answering costs a process launch and a full extractor run. */
  checkCost: 'slow',

  /**
   * Ask yt-dlp what it would download. This is only for the name and size the
   * UI shows before the transfer starts — the download re-extracts anyway, so
   * nothing here is treated as a link that could expire.
   */
  async resolve(url) {
    const exe = await ytdlpPath()
    const cookies = await cookieFileFor(url)
    const res = await run(
      exe,
      [
        '-J',
        '--no-warnings',
        '--no-playlist',
        ...netArgs(),
        ...(cookies ? ['--cookies', cookies.path] : []),
        url
      ],
      { timeoutMs: 60_000 }
    ).finally(() => cookies?.dispose())
    if (res.code !== 0) throw classify(res.stderr)

    let info: ProbeJson
    try {
      info = JSON.parse(res.stdout) as ProbeJson
    } catch {
      throw new PermanentError('ytdlp_unsupported')
    }
    const size = expectedSize(info)
    return {
      url,
      filename: `${info.title || 'video'}.${info.ext || 'mp4'}`,
      ...(size !== undefined ? { sizeBytes: size } : {})
    }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    const exe = await ytdlpPath()
    const settings = await getSettings()
    const workDir = workDirFor(targetPath)
    await mkdir(workDir, { recursive: true })

    // Video and audio arrive as separate files, each starting its byte count
    // from zero, so finished ones are banked and added to the live count.
    let banked = 0
    const onLine = (line: string): void => {
      const start = line.indexOf(PROGRESS_PREFIX)
      if (start === -1) return
      const [status, downloaded, total, estimate, speed, eta] = line
        .slice(start + PROGRESS_PREFIX.length)
        .split('|')
      const bytes = num(downloaded) ?? 0
      if (status === 'finished') {
        banked += bytes
        onProgress({ bytesDownloaded: banked, ...(info.sizeBytes !== undefined ? { totalBytes: info.sizeBytes } : {}) })
        return
      }
      // The line's own total only describes the current file, so it can be
      // used as the job total only while it is the first one.
      const lineTotal = banked === 0 ? (num(total) ?? num(estimate)) : undefined
      const totalBytes = info.sizeBytes ?? lineTotal
      onProgress({
        bytesDownloaded: banked + bytes,
        ...(totalBytes !== undefined ? { totalBytes } : {}),
        ...(num(speed) !== undefined ? { speedBytesPerSec: num(speed) } : {}),
        ...(num(eta) !== undefined ? { etaSec: num(eta) } : {})
      })
    }

    const ffmpeg = await resolveFfmpeg()
    // yt-dlp holds its own socket, so the proxy and the rate limit have to be
    // handed to it explicitly; the app's own transfers get both from inside.
    const limit = await processRateLimit()
    const cookies = await cookieFileFor(info.url)
    const args = [
      '--no-warnings',
      '--newline',
      '--no-playlist',
      '--progress-template',
      PROGRESS_TEMPLATE,
      ...formatArgs(settings.download.preferredQuality),
      ...netArgs(),
      ...(limit !== null ? ['--limit-rate', String(limit)] : []),
      ...(cookies ? ['--cookies', cookies.path] : []),
      '-o',
      join(workDir, '%(title)s.%(ext)s'),
      ...(ffmpeg ? ['--ffmpeg-location', ffmpeg] : []),
      info.url
    ]

    const res = await run(exe, args, { signal, onLine }).finally(() => cookies?.dispose())
    if (res.code !== 0) {
      // A non-zero exit right after an abort is our own kill, not a failure.
      // Exit 0 is a finished file and counts as success even if a pause landed
      // at that moment — re-downloading it from scratch would be worse.
      throw signal.aborted ? new Error('aborted') : classify(res.stderr)
    }

    const produced = await finishedFile(workDir)
    if (!produced) throw new PermanentError('ytdlp_no_output')

    await rename(join(workDir, produced), targetPath)
    await rm(workDir, { recursive: true, force: true }).catch(() => {})
    return {
      filePath: targetPath,
      sizeBytes: (await stat(targetPath)).size,
      // yt-dlp named it from the video's title and already made the name safe
      // for this platform — a better name than anything the URL could give.
      fileName: produced
    }
  },

  async cleanup(partPath) {
    await rm(workDirFor(partPath), { recursive: true, force: true }).catch(() => {})
  }
}

/** The merged result in a work dir, ignoring yt-dlp's own scratch files. */
async function finishedFile(workDir: string): Promise<string | null> {
  const names = (await readdir(workDir).catch(() => [])).filter(
    (n) => !/\.(part|ytdl|temp)$/i.test(n) && !/\.part-Frag\d+$/i.test(n)
  )
  let best: { name: string; size: number } | null = null
  for (const name of names) {
    const size = await stat(join(workDir, name))
      .then((s) => (s.isFile() ? s.size : -1))
      .catch(() => -1)
    if (size >= 0 && (!best || size > best.size)) best = { name, size }
  }
  return best?.name ?? null
}
