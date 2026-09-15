import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { getSettings } from '../config/config-service'
import { httpDownloadToFile } from '../downloaders/http'

/**
 * The external binaries the app installs and updates for the user: yt-dlp
 * (every video-site download) and ffmpeg (thumbnails, and merging what yt-dlp
 * fetches). Nobody should have to go find these themselves.
 *
 * They are installed into `<userData>/bin`, which needs no elevation — the
 * install directory under Program Files is not writable for a normal user, so
 * updating there would fail on exactly the machines that need it.
 *
 * Resolution order, per binary: a path the user configured → our managed copy
 * → whatever shipped with the app → PATH. Installing therefore takes over from
 * a bundled copy, and a configured path always wins.
 */

export type BinaryId = 'ytdlp' | 'ffmpeg'

/** Where a resolved binary came from; the UI says different things for each. */
export type BinarySource = 'configured' | 'managed' | 'bundled' | 'path'

export interface BinaryStatus {
  id: BinaryId
  /** Absolute path, or the bare command when we are relying on PATH. */
  path: string | null
  source: BinarySource | null
  /** What `--version` reports; null when it will not run. */
  version: string | null
  /** Latest release, when GitHub could be reached. */
  latest: string | null
  /** Known to be behind. False when unknown — never nag on a guess. */
  hasUpdate: boolean
}

interface BinarySpec {
  id: BinaryId
  /** Name inside `<userData>/bin`. */
  fileName: string
  defaultUrl: string
  repo: string
  /** Set when the download is a zip: the member to pull out, and its depth. */
  zip?: { member: string; strip: number }
  versionArgs: string[]
  parseVersion(stdout: string): string | null
  /** The release's user-visible version, from the JSON GitHub returns. */
  releaseVersion(release: GithubRelease): string | null
  /** Undefined when the two versions are not comparable (a foreign build). */
  isBehind(installed: string, release: GithubRelease): boolean | undefined
}

interface GithubRelease {
  tag_name?: string
  name?: string
  published_at?: string
}

/** `N-124971-g625ab011f4-20260611` → `20260611`; ffmpeg builds date their name. */
function buildDate(version: string): string | null {
  return /-(\d{8})$/.exec(version)?.[1] ?? null
}

/** `2026-07-25T15:20:39Z` → `20260725`. */
function releaseDate(release: GithubRelease): string | null {
  const iso = release.published_at ?? ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  return m ? `${m[1]}${m[2]}${m[3]}` : null
}

const SPECS: Record<BinaryId, BinarySpec> = {
  ytdlp: {
    id: 'ytdlp',
    fileName: 'yt-dlp.exe',
    defaultUrl: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
    repo: 'yt-dlp/yt-dlp',
    versionArgs: ['--version'],
    // Prints exactly the release tag, e.g. `2026.07.04`.
    parseVersion: (out) => out.trim() || null,
    releaseVersion: (r) => r.tag_name ?? null,
    isBehind: (installed, release) =>
      release.tag_name ? installed.trim() !== release.tag_name.trim() : undefined
  },
  ffmpeg: {
    id: 'ffmpeg',
    fileName: 'ffmpeg.exe',
    defaultUrl:
      'https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip',
    repo: 'yt-dlp/FFmpeg-Builds',
    zip: { member: '*/bin/ffmpeg.exe', strip: 2 },
    versionArgs: ['-version'],
    // `ffmpeg version N-124971-g625ab011f4-20260611 Copyright (c) …`
    parseVersion: (out) => /^ffmpeg version (\S+)/m.exec(out)?.[1] ?? null,
    // The tag is the rolling `latest`, so the build date is the real version.
    releaseVersion: (r) => {
      const date = releaseDate(r)
      return date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : (r.name ?? null)
    },
    // Only their own builds carry a date; anything else (the bundled
    // ffmpeg-static, a distro build) is not comparable, so we say nothing.
    isBehind: (installed, release) => {
      const mine = buildDate(installed)
      const theirs = releaseDate(release)
      return mine && theirs ? mine < theirs : undefined
    }
  }
}

export function binDir(): string {
  return join(app.getPath('userData'), 'bin')
}

function managedPath(id: BinaryId): string {
  return join(binDir(), SPECS[id].fileName)
}

/**
 * What ships inside the app, when anything does.
 *
 * ffmpeg-static resolves to its binary inside `node_modules`, which in a
 * packaged build sits inside `app.asar` — and nothing can be spawned from
 * there. electron-builder unpacks it beside the archive (`asarUnpack`), so the
 * path has to be redirected to the unpacked copy.
 */
function bundledPath(id: BinaryId): string | null {
  if (id === 'ffmpeg') {
    if (!ffmpegStatic) return null
    return app.isPackaged
      ? ffmpegStatic.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
      : ffmpegStatic
  }
  const packaged = join(process.resourcesPath ?? '', 'bin', 'yt-dlp.exe')
  return app.isPackaged && existsSync(packaged) ? packaged : null
}

/** Test seam: point the smokes at a specific binary. */
function envOverride(id: BinaryId): string | undefined {
  return id === 'ytdlp' ? process.env.FSMGR_YTDLP_PATH : process.env.FSMGR_FFMPEG_PATH
}

interface Resolved {
  path: string
  source: BinarySource
}

function resolveWith(id: BinaryId, configured: string): Resolved | null {
  const override = envOverride(id)
  if (override) return existsSync(override) ? { path: override, source: 'configured' } : null
  // A path the user typed that does not exist is "set up wrong", not "not set
  // up" — falling back would hide their mistake.
  if (configured) return existsSync(configured) ? { path: configured, source: 'configured' } : null
  const managed = managedPath(id)
  if (existsSync(managed)) return { path: managed, source: 'managed' }
  const bundled = bundledPath(id)
  if (bundled && existsSync(bundled)) return { path: bundled, source: 'bundled' }
  return { path: id === 'ytdlp' ? 'yt-dlp' : 'ffmpeg', source: 'path' }
}

async function configuredPath(id: BinaryId): Promise<string> {
  const { dependencies } = await getSettings()
  return id === 'ytdlp' ? dependencies.ytdlpPath : dependencies.ffmpegPath
}

/** The yt-dlp to run, or null when there is none. */
export async function resolveYtdlp(): Promise<string | null> {
  return (resolveWith('ytdlp', await configuredPath('ytdlp')))?.path ?? null
}

/** The ffmpeg to run, or null when there is none. */
export async function resolveFfmpeg(): Promise<string | null> {
  return (resolveWith('ffmpeg', await configuredPath('ffmpeg')))?.path ?? null
}

function runVersion(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    const timer = setTimeout(() => proc.kill(), 10_000)
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
    // ffmpeg prints its banner on stderr in some builds.
    proc.stderr?.on('data', (d: Buffer) => (out += d.toString()))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out : null)
    })
  })
}

const RELEASE_TTL_MS = 30 * 60 * 1000
const releaseCache = new Map<BinaryId, { at: number; release: GithubRelease | null }>()

/**
 * Latest release for a binary. Unauthenticated GitHub allows 60 calls an hour
 * per address, so results are cached; a failure resolves to null and the UI
 * simply says nothing about updates rather than showing an error.
 */
async function latestRelease(id: BinaryId): Promise<GithubRelease | null> {
  const cached = releaseCache.get(id)
  if (cached && Date.now() - cached.at < RELEASE_TTL_MS) return cached.release
  let release: GithubRelease | null = null
  try {
    const res = await fetch(`https://api.github.com/repos/${SPECS[id].repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `FunscriptManager/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (res.ok) release = (await res.json()) as GithubRelease
  } catch {
    // Offline, rate-limited, or blocked — not an error worth showing.
  }
  releaseCache.set(id, { at: Date.now(), release })
  return release
}

async function statusOf(id: BinaryId): Promise<BinaryStatus> {
  const spec = SPECS[id]
  const resolved = resolveWith(id, await configuredPath(id))
  const version = resolved
    ? spec.parseVersion((await runVersion(resolved.path, spec.versionArgs)) ?? '')
    : null
  const release = await latestRelease(id)
  return {
    id,
    path: resolved?.path ?? null,
    source: version ? (resolved?.source ?? null) : null,
    version,
    latest: release ? spec.releaseVersion(release) : null,
    hasUpdate: Boolean(version && release && spec.isBehind(version, release) === true)
  }
}

export async function status(): Promise<BinaryStatus[]> {
  return Promise.all((Object.keys(SPECS) as BinaryId[]).map(statusOf))
}

export interface InstallProgress {
  id: BinaryId
  phase: 'downloading' | 'extracting'
  bytesDownloaded: number
  totalBytes: number | null
}

export const depsEvents = new EventEmitter()

/** bsdtar, not whatever `tar` PATH resolves to — GNU tar cannot read a zip. */
function extractFromZip(zipPath: string, into: string, spec: BinarySpec): Promise<void> {
  const bsdtar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  const zip = spec.zip!
  return new Promise((resolve, reject) => {
    const proc = spawn(
      bsdtar,
      ['-xf', zipPath, '-C', into, `--strip-components=${zip.strip}`, zip.member],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let err = ''
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('error', (e) => reject(new Error(`extract failed: ${e.message}`)))
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`extract failed (${code}): ${err.slice(0, 200)}`))
    )
  })
}

/**
 * Download and install (or replace) one binary. The new file is assembled in a
 * temp directory and only moved into place once it is complete, so a failed
 * download never leaves a half-written executable where a working one was.
 */
export async function install(id: BinaryId): Promise<BinaryStatus> {
  const spec = SPECS[id]
  const settings = await getSettings()
  const url =
    (id === 'ytdlp' ? settings.dependencies.ytdlpUrl : settings.dependencies.ffmpegUrl).trim() ||
    spec.defaultUrl

  const staging = await mkdtemp(join(tmpdir(), 'fsmgr-dep-'))
  try {
    const downloadName = spec.zip ? 'download.zip' : spec.fileName
    const downloadPath = join(staging, downloadName)
    await httpDownloadToFile({
      url,
      partPath: downloadPath,
      noRateLimit: true,
      signal: AbortSignal.timeout(30 * 60_000),
      onProgress: (p) =>
        depsEvents.emit('progress', {
          id,
          phase: 'downloading',
          bytesDownloaded: Math.round(p.bytesDownloaded),
          totalBytes: p.totalBytes !== undefined ? Math.round(p.totalBytes) : null
        } satisfies InstallProgress)
    })

    let staged = downloadPath
    if (spec.zip) {
      depsEvents.emit('progress', {
        id,
        phase: 'extracting',
        bytesDownloaded: 0,
        totalBytes: null
      } satisfies InstallProgress)
      await extractFromZip(downloadPath, staging, spec)
      staged = join(staging, spec.fileName)
      if (!existsSync(staged)) throw new Error(`${spec.fileName} not found in the archive`)
    }

    await mkdir(binDir(), { recursive: true })
    const target = managedPath(id)
    // Windows will not replace a running executable; nothing here should be
    // running mid-install, but move the old one aside rather than assume it.
    const old = `${target}.old`
    await rm(old, { force: true }).catch(() => {})
    if (existsSync(target)) await rename(target, old).catch(() => {})
    await rename(staged, target)
    await rm(old, { force: true }).catch(() => {})

    releaseCache.delete(id) // the freshly installed version is the answer now
    return await statusOf(id)
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}
