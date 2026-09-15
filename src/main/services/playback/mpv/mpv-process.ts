import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { AppError } from '@shared/errors'
import { MpvIpcClient, mpvPipeName, mpvPipePath } from './mpv-ipc'

/**
 * mpv process management.
 *
 * The pipe name is shared with MFP; if the pipe is already accepting
 * connections (MFP auto-started mpv first), we attach to it instead of
 * spawning a second instance. Our own mpv is spawned detached — it outlives
 * nothing important and closes when the user closes its window.
 */

/** Can the mpv pipe be connected to right now? */
async function probeMpvPipe(): Promise<boolean> {
  try {
    const client = await MpvIpcClient.connect(mpvPipePath(), 500)
    client.close()
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the mpv executable: explicit setting → bundled resources/bin →
 * PATH lookup fallback ('mpv', resolved by spawn). Null if the configured
 * path is bogus.
 */
export function resolveMpvExecutable(mpvExePath: string): string | null {
  if (mpvExePath) {
    return existsSync(mpvExePath) ? mpvExePath : null
  }
  const bundled = join(process.resourcesPath ?? '', 'bin', 'mpv.exe')
  if (app.isPackaged && existsSync(bundled)) return bundled
  return 'mpv' // rely on PATH; spawn errors surface as mpv_unavailable
}

const SPAWN_ARGS = [
  `--input-ipc-server=${mpvPipeName()}`,
  '--idle=yes',
  '--keep-open=yes',
  '--pause',
  '--force-window=yes'
]

/**
 * Ensure an mpv with our pipe is running; returns a connected client.
 * `reused` is true when an existing instance (e.g. MFP's) was attached.
 */
export async function ensureMpv(mpvExePath: string): Promise<{ client: MpvIpcClient; reused: boolean }> {
  if (await probeMpvPipe()) {
    return { client: await MpvIpcClient.connect(), reused: true }
  }

  const exe = resolveMpvExecutable(mpvExePath)
  if (!exe) throw new AppError('mpv_unavailable')

  let proc
  try {
    proc = spawn(exe, SPAWN_ARGS, { detached: true, stdio: 'ignore', windowsHide: false })
    proc.unref()
  } catch {
    throw new AppError('mpv_unavailable')
  }

  // ENOENT (not installed / bad path) or an immediate exit must fail fast —
  // without this the pipe-retry loop below burns the full deadline.
  let spawnFailed: Error | null = null
  proc.on('error', (e) => {
    spawnFailed ??= e instanceof Error ? e : new Error(String(e))
  })
  proc.on('exit', (code) => {
    spawnFailed ??= new Error(`mpv exited during startup (code ${code})`)
  })

  // The pipe appears once mpv finishes starting up.
  const deadline = Date.now() + 8000
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    if (spawnFailed) {
      console.error('[mpv] failed to start:', spawnFailed)
      throw new AppError('mpv_unavailable')
    }
    try {
      return { client: await MpvIpcClient.connect(), reused: false }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  console.error('[mpv] failed to start:', lastErr)
  throw new AppError('mpv_unavailable')
}
