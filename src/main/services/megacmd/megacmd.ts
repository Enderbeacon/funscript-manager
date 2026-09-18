import { execFile, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { AppError } from '@shared/errors'
import { getSettings } from '../config/config-service'
import { PermanentError, type DownloadResult, type ProgressEvent } from '../downloaders/base'
import { httpDownloadToFile } from '../downloaders/http'
import { proxyForUrl } from '../net/proxy'

/**
 * MEGAcmd, MEGA's own command-line client, as a second way to download MEGA
 * links. It downloads with whatever account the user signed in to inside it,
 * so a paid account's transfer quota applies — without the app ever holding a
 * MEGA session, which MEGA treats as a leaked login and locks the account for.
 *
 * Every command goes through `MegaClient.exe`, which starts MEGAcmd's
 * background server on first use and talks to it. It is called directly rather
 * than through the `mega-*.bat` wrappers: cmd.exe would take the `#` and `!`
 * in a MEGA link as its own syntax.
 */

const INSTALLER_URL = 'https://mega.nz/MEGAcmdSetup64.exe'
const CLIENT = 'MegaClient.exe'
const SHELL = 'MEGAcmdShell.exe'
const COMMAND_TIMEOUT_MS = 60_000
const POLL_MS = 1000
/** How long a transfer may sit without moving before the job says so. */
const STALL_MS = 3 * 60_000
/** A queued transfer can take a moment to show up in the transfer list. */
const APPEAR_MS = 30_000

export interface MegacmdStatus {
  installed: boolean
  /** The install folder in use, whether or not anything is there. */
  path: string
  version: string | null
  /** The account signed in inside MEGAcmd, or null when none is. */
  account: string | null
}

export interface MegacmdInstallProgress {
  phase: 'downloading' | 'installing'
  bytesDownloaded: number
  totalBytes: number | null
}

class InstallEmitter extends EventEmitter {
  override on(e: 'progress', l: (p: MegacmdInstallProgress) => void): this {
    return super.on(e, l)
  }
  override emit(e: 'progress', p: MegacmdInstallProgress): boolean {
    return super.emit(e, p)
  }
}

export const megacmdEvents = new InstallEmitter()

/** Where MEGAcmd's installer puts it: per user, no elevation needed. */
function defaultDir(): string {
  return join(process.env.LOCALAPPDATA ?? '', 'MEGAcmd')
}

/** The configured folder; a path to one of its programs counts as its folder. */
async function installDir(): Promise<string> {
  const configured = (await getSettings()).download.mega.megacmdPath.trim()
  if (!configured) return defaultDir()
  return /\.exe$/i.test(configured) ? dirname(configured) : configured
}

async function client(): Promise<string | null> {
  const path = join(await installDir(), CLIENT)
  return existsSync(path) ? path : null
}

interface CommandResult {
  code: number
  out: string
}

function run(exe: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: COMMAND_TIMEOUT_MS }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0
      resolve({ code, out: `${stdout}${stderr}` })
    })
  })
}

async function command(args: string[]): Promise<CommandResult> {
  const exe = await client()
  if (!exe) throw new PermanentError('megacmd_missing')
  return run(exe, args)
}

export async function status(): Promise<MegacmdStatus> {
  const path = await installDir()
  const exe = await client()
  if (!exe) return { installed: false, path, version: null, account: null }
  const [version, whoami] = [await run(exe, ['version']), await run(exe, ['whoami'])]
  return {
    installed: true,
    path,
    version: /MEGAcmd version:\s*([\d.]+)/i.exec(version.out)?.[1] ?? null,
    account: whoami.code === 0 ? (/e-?mail:\s*(\S+)/i.exec(whoami.out)?.[1] ?? null) : null
  }
}

let installing: Promise<MegacmdStatus> | null = null

/**
 * Fetch MEGA's installer and run it silently. It installs per user and needs
 * no elevation. MEGAcmd updates itself afterwards, so installing again is only
 * ever a repair.
 */
export function install(): Promise<MegacmdStatus> {
  installing ??= (async () => {
    const work = await mkdtemp(join(tmpdir(), 'fsmgr-megacmd-'))
    try {
      const setup = join(work, 'MEGAcmdSetup64.exe')
      const controller = new AbortController()
      await httpDownloadToFile({
        url: INSTALLER_URL,
        partPath: setup,
        signal: controller.signal,
        onProgress: (p) =>
          megacmdEvents.emit('progress', {
            phase: 'downloading',
            bytesDownloaded: p.bytesDownloaded,
            totalBytes: p.totalBytes ?? null
          })
      })
      megacmdEvents.emit('progress', { phase: 'installing', bytesDownloaded: 0, totalBytes: null })
      const code = await new Promise<number>((resolve) => {
        const child = spawn(setup, ['/S'], { windowsHide: true })
        child.once('error', () => resolve(-1))
        child.once('exit', (c) => resolve(c ?? -1))
      })
      const after = await status()
      if (code !== 0 || !after.installed) {
        console.error(`[megacmd] installer exited with ${code}; installed: ${after.installed}`)
        throw new AppError('megacmd_install_failed')
      }
      return after
    } catch (e) {
      if (e instanceof AppError) throw e
      console.error('[megacmd] install failed:', e)
      throw new AppError('megacmd_install_failed')
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {})
      installing = null
    }
  })()
  return installing
}

/**
 * Open MEGAcmd's own interactive shell in a console window, where the user
 * signs in with `login`. The password goes from the keyboard to MEGA's client
 * and nowhere near the app.
 */
export async function openLogin(): Promise<void> {
  const shell = join(await installDir(), SHELL)
  if (!existsSync(shell)) throw new AppError('megacmd_missing')
  spawn(shell, [], { detached: true, stdio: 'ignore' }).unref()
}

let lastProxy: string | null = null

/**
 * Give MEGAcmd the proxy the rest of the app uses. It keeps its own setting,
 * and its "follow the system" mode does not find a proxy the app's Chromium
 * side does — so the address is always spelled out.
 */
async function syncProxy(): Promise<void> {
  const proxy = await proxyForUrl('https://mega.nz/')
  if (proxy === lastProxy) return
  const result = await command(proxy ? ['proxy', proxy] : ['proxy', '--none'])
  if (result.code !== 0) {
    console.error(`[megacmd] setting the proxy failed (${result.code}): ${result.out.trim()}`)
    return
  }
  lastProxy = proxy
}

interface Transfer {
  tag: string
  destination: string
  percent: number
  state: string
}

/** States a transfer can come back from. */
const LIVE_STATES = new Set(['QUEUED', 'ACTIVE', 'PAUSED', 'RETRYING', 'COMPLETING'])

async function transfers(): Promise<Transfer[]> {
  const result = await command([
    'transfers',
    '--only-downloads',
    '--show-completed',
    '--limit=10000',
    '--col-separator=|',
    '--output-cols=TAG,DESTINYPATH,PROGRESS,STATE'
  ])
  const list: Transfer[] = []
  for (const line of result.out.split(/\r?\n/)) {
    const [tag, destination, progress, state] = line.split('|').map((c) => c.trim())
    if (!tag || !/^\d+$/.test(tag) || !destination || !progress || !state) continue
    list.push({ tag, destination, percent: Number.parseFloat(progress) || 0, state: state.toUpperCase() })
  }
  return list
}

function inside(dir: string, path: string): boolean {
  const norm = (p: string): string => p.replace(/[\\/]+/g, sep).toLowerCase()
  return norm(path).startsWith(norm(dir) + sep)
}

/** The newest transfer writing into `dir`, if MEGAcmd still knows about one. */
async function transferFor(dir: string): Promise<Transfer | null> {
  const mine = (await transfers()).filter((t) => inside(dir, t.destination))
  mine.sort((a, b) => Number(b.tag) - Number(a.tag))
  return mine[0] ?? null
}

/** MEGAcmd stages each job in its own folder beside the job's partial file. */
function stagingDir(partPath: string): string {
  return `${partPath}.megacmd`
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

/**
 * Download `url` through MEGAcmd into `partPath`, reporting progress the way
 * the queue's own downloads do.
 *
 * Pausing the job pauses the transfer inside MEGAcmd, which keeps what it has;
 * running the job again resumes that same transfer instead of starting over.
 * A transfer that stops moving is paused and the job fails as stalled, so the
 * queue does not show a download that is not happening.
 */
export async function download(
  url: string,
  partPath: string,
  sizeHint: number | undefined,
  onProgress: (p: ProgressEvent) => void,
  signal: AbortSignal
): Promise<DownloadResult> {
  const dir = stagingDir(partPath)
  await syncProxy()

  const earlier = await transferFor(dir)
  if (earlier && LIVE_STATES.has(earlier.state)) {
    if (earlier.state === 'PAUSED') await command(['transfers', '-r', earlier.tag])
  } else if (!(earlier?.state === 'COMPLETED' && (await stagedFile(dir)))) {
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    const started = await command(['get', '-q', '--ignore-quota-warn', url, dir])
    if (started.code !== 0) {
      throw new Error(`MEGAcmd get failed (${started.code}): ${started.out.trim()}`)
    }
  }

  const began = Date.now()
  let lastPercent = -1
  let movedAt = Date.now()
  let window = { at: Date.now(), bytes: 0 }
  for (;;) {
    if (signal.aborted) break
    const transfer = await transferFor(dir)
    if (!transfer) {
      if (Date.now() - began > APPEAR_MS) throw new Error('MEGAcmd lost track of the transfer')
    } else if (transfer.state === 'COMPLETED') {
      break
    } else if (transfer.state === 'CANCELLED' || transfer.state === 'FAILED') {
      throw new Error(`MEGAcmd transfer ${transfer.tag} ended as ${transfer.state}`)
    } else {
      if (transfer.percent !== lastPercent) {
        lastPercent = transfer.percent
        movedAt = Date.now()
      } else if (Date.now() - movedAt > STALL_MS) {
        console.error(`[megacmd] transfer ${transfer.tag} has not moved for ${STALL_MS / 1000}s; pausing it`)
        await command(['transfers', '-p', transfer.tag])
        throw new PermanentError('megacmd_stalled')
      }
      if (sizeHint) {
        const received = Math.round((transfer.percent / 100) * sizeHint)
        const elapsed = (Date.now() - window.at) / 1000
        const speed = elapsed > 0 ? Math.max(0, (received - window.bytes) / elapsed) : 0
        if (elapsed >= 2) window = { at: Date.now(), bytes: received }
        onProgress({
          bytesDownloaded: received,
          totalBytes: sizeHint,
          speedBytesPerSec: speed,
          ...(speed > 0 ? { etaSec: Math.max(0, (sizeHint - received) / speed) } : {})
        })
      }
    }
    await sleep(POLL_MS, signal)
  }

  if (signal.aborted) {
    // Paused rather than cancelled: a resume picks the same transfer up, and a
    // cancel reaches `cleanup`, which removes it.
    const transfer = await transferFor(dir)
    if (transfer && LIVE_STATES.has(transfer.state)) await command(['transfers', '-p', transfer.tag])
    throw new Error('aborted')
  }

  const file = await stagedFile(dir)
  if (!file) throw new Error('MEGAcmd finished but left no file')
  await rm(partPath, { force: true })
  await rename(file, partPath)
  await rm(dir, { recursive: true, force: true })
  return { filePath: partPath, sizeBytes: (await stat(partPath)).size }
}

/** The one finished file in a staging folder; MEGAcmd's partial files start with a dot. */
async function stagedFile(dir: string): Promise<string | null> {
  const names = await readdir(dir).catch(() => [] as string[])
  const done = names.filter((n) => !n.startsWith('.'))
  return done.length === 1 ? join(dir, done[0]!) : null
}

/** A cancelled job: stop MEGAcmd's transfer and drop what it staged. */
export async function cleanup(partPath: string): Promise<void> {
  const dir = stagingDir(partPath)
  if (await client()) {
    const transfer = await transferFor(dir).catch(() => null)
    if (transfer && LIVE_STATES.has(transfer.state)) await command(['transfers', '-c', transfer.tag])
  }
  await rm(dir, { recursive: true, force: true })
}

