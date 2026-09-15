import { exec, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * MultiFunPlayer process discovery.
 * MFP has no CLI or control endpoint of its own; all we can do is detect a
 * running instance and launch the configured executable. It attaches to the
 * shared mpv pipe on its own.
 */

const execAsync = promisify(exec)

const MFP_EXE = 'MultiFunPlayer.exe'

export type MfpStatus = 'running' | 'launched' | 'unavailable'

export async function isMfpRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${MFP_EXE}" /NH /FO CSV`, {
      windowsHide: true
    })
    return stdout.toLowerCase().includes(MFP_EXE.toLowerCase())
  } catch {
    return false
  }
}

/** Search the common install locations (settings "auto-detect" helper). */
export function detectMfpExecutable(): string | null {
  const home = process.env['USERPROFILE'] ?? ''
  const candidates = [
    join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'MultiFunPlayer', MFP_EXE),
    join('C:\\Program Files\\MultiFunPlayer', MFP_EXE),
    join(home, 'Downloads', 'MultiFunPlayer', MFP_EXE)
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

/** Executable path of a running MFP, if one is up. */
async function runningMfpPath(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -NonInteractive -Command ' +
        '"(Get-Process -Name MultiFunPlayer -ErrorAction SilentlyContinue | Select-Object -First 1).Path"',
      { windowsHide: true }
    )
    const path = stdout.trim()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

/**
 * Settings "auto-detect": ask a running instance where it lives first, then
 * fall back to the common install locations. MFP ships as a portable folder as
 * often as an installer, and a portable copy can sit anywhere — asking the
 * running process is the only way to find those.
 */
export async function detectMfpExecutablePath(): Promise<string | null> {
  return (await runningMfpPath()) ?? detectMfpExecutable()
}

export type MfpRestartResult = 'restarted' | 'launched' | 'still_running' | 'unavailable'

/**
 * Close MFP and start it again — the plugin panel only picks up a newly
 * installed ManagerBridge.cs on a fresh load. The close is a plain WM_CLOSE
 * (no /F): MFP persists its config on exit, and killing it would lose the
 * user's settings. If it does not go away we say so rather than force it.
 */
export async function restartMfp(mfpExePath: string): Promise<MfpRestartResult> {
  const running = await runningMfpPath()
  const exe = running ?? (mfpExePath && existsSync(mfpExePath) ? mfpExePath : detectMfpExecutable())
  if (!exe) return 'unavailable'

  if (running) {
    try {
      await execAsync(`taskkill /IM ${MFP_EXE}`, { windowsHide: true })
    } catch {
      // already gone, or refused the close — the wait below decides
    }
    const deadline = Date.now() + 10_000
    while (await isMfpRunning()) {
      if (Date.now() > deadline) return 'still_running'
      await new Promise((r) => setTimeout(r, 400))
    }
  }

  try {
    const proc = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: join(exe, '..') })
    proc.on('error', (e) => console.error(`[mfp] failed to launch ${exe}:`, e))
    proc.unref()
  } catch {
    return 'unavailable'
  }
  return running ? 'restarted' : 'launched'
}

/**
 * Make sure MFP is up: already running → 'running'; else launch the
 * configured exe → 'launched'; nothing configured/found → 'unavailable'.
 */
export async function ensureMfp(mfpExePath: string): Promise<MfpStatus> {
  if (await isMfpRunning()) return 'running'
  const exe = mfpExePath && existsSync(mfpExePath) ? mfpExePath : detectMfpExecutable()
  if (!exe) return 'unavailable'
  try {
    // cwd matters: MFP resolves its config/plugins relative to the exe.
    const proc = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: join(exe, '..') })
    // A configured path that exists but will not start (wrong file, missing
    // permissions) reports spawn failure asynchronously; without a listener
    // that 'error' event would take the main process down.
    proc.on('error', (e) => console.error(`[mfp] failed to launch ${exe}:`, e))
    proc.unref()
    return 'launched'
  } catch {
    return 'unavailable'
  }
}
