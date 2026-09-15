import { request } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { detectMfpExecutable } from './mfp'

/**
 * MultiFunPlayer control-plugin bridge.
 *
 * Talks to the ManagerBridge.cs plugin (resources/mfp-plugin) over loopback
 * HTTP. When the plugin is loaded, we push the exact script → axis assignment
 * for the video being played, so MFP loads precisely the version the user
 * chose without relying on filename auto-matching. Every call degrades to
 * "unavailable" instead of throwing — the staged playback session directory
 * (playback-session.ts), which MFP matches by filename, is the guaranteed fallback.
 */

const DEFAULT_PORT = 57944
const PLUGIN_FILE = 'ManagerBridge.cs'
const CONFIG_FILE = 'managerbridge.json'

/** Our axis keys → MFP device-axis names (TCode channel names). */
const AXIS_TO_MFP: Record<string, string> = {
  main: 'L0',
  surge: 'L1',
  sway: 'L2',
  twist: 'R0',
  roll: 'R1',
  pitch: 'R2'
}

export interface MfpPluginStatus {
  installed: boolean
  reachable: boolean
  version: string | null
}

/** The ManagerBridge.cs shipped with the app (bundled under resources). */
function bundledPluginPath(): string {
  const packaged = join(process.resourcesPath ?? '', 'mfp-plugin', PLUGIN_FILE)
  if (app.isPackaged && existsSync(packaged)) return packaged
  return join(app.getAppPath(), 'resources', 'mfp-plugin', PLUGIN_FILE)
}

/** MFP install directory from the configured/detected exe (null if unknown). */
function mfpDir(mfpExePath?: string): string | null {
  const exe = mfpExePath && existsSync(mfpExePath) ? mfpExePath : detectMfpExecutable()
  return exe ? dirname(exe) : null
}

function pluginsDirFor(dir: string): string {
  return join(dir, 'Plugins')
}

async function readPort(dir: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(join(pluginsDirFor(dir), CONFIG_FILE), 'utf-8'))
    if (typeof raw?.port === 'number' && Number.isInteger(raw.port)) return raw.port
  } catch {
    // missing/invalid config → default port
  }
  return DEFAULT_PORT
}

/** Minimal loopback HTTP call; resolves null on any failure/timeout. */
function httpJson(
  port: number,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 1500
): Promise<{ status: number; text: string } | null> {
  return new Promise((resolve) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : undefined,
        timeout: timeoutMs
      },
      (res) => {
        let text = ''
        res.setEncoding('utf-8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      }
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/** GET /ping → plugin version, or null when not reachable. */
async function ping(port: number): Promise<string | null> {
  const res = await httpJson(port, 'GET', '/ping')
  if (!res || res.status !== 200) return null
  try {
    const parsed = JSON.parse(res.text)
    return typeof parsed?.version === 'string' ? parsed.version : '?'
  } catch {
    return null
  }
}

/** Is the plugin file installed and the HTTP endpoint answering? */
export async function pluginStatus(mfpExePath?: string): Promise<MfpPluginStatus> {
  const dir = mfpDir(mfpExePath)
  const installed = dir ? existsSync(join(pluginsDirFor(dir), PLUGIN_FILE)) : false
  const port = dir ? await readPort(dir) : DEFAULT_PORT
  const version = await ping(port)
  return { installed, reachable: version !== null, version }
}

const MFP_AXES = Object.values(AXIS_TO_MFP)

/**
 * Apply one script→axis assignment to the plugin: load the axes this version
 * uses and clear every other axis. The clear matters — MFP keeps whatever a
 * previous load put on an axis, so a multi-axis version followed by a
 * single-axis one (or by video-only, `scripts` empty) would otherwise leave
 * stale scripts driving the device.
 *
 * `scripts` is keyed by our axis names (main/roll/…); absolute paths. Returns
 * true when the plugin served it, false when it is unreachable (MFP's filename
 * matching against the session directory covers the load; a stale axis is the price of not having the plugin).
 */
export async function pluginApply(
  scripts: Record<string, string>,
  opts: { video?: string; mediaPath?: string; mfpExePath?: string } = {}
): Promise<boolean> {
  const dir = mfpDir(opts.mfpExePath)
  const port = dir ? await readPort(dir) : DEFAULT_PORT
  const mapped: Record<string, string> = {}
  for (const [axis, path] of Object.entries(scripts)) {
    const mfpAxis = AXIS_TO_MFP[axis]
    if (mfpAxis) mapped[mfpAxis] = path
  }

  // mediaPath scopes the plugin's re-apply (it keeps our assignment through
  // MFP's own script search) to this media, and never publishes a media change.
  const scope = opts.mediaPath ? { mediaPath: opts.mediaPath } : {}

  let served = true
  if (Object.keys(mapped).length > 0) {
    const res = await httpJson(port, 'POST', '/load', {
      ...(opts.video ? { video: opts.video } : {}),
      ...scope,
      scripts: mapped
    })
    served = res !== null && res.status === 200
    if (!served) return false
  }

  const unused = MFP_AXES.filter((a) => mapped[a] === undefined)
  if (unused.length > 0) {
    const res = await httpJson(port, 'POST', '/clear', { ...scope, axes: unused })
    served = served && res !== null && res.status === 200
  }
  return served
}

export interface InstallResult {
  ok: boolean
  pluginPath: string | null
  reason: string | null
}

/**
 * Copy ManagerBridge.cs into MFP's Plugins dir and drop a managerbridge.json
 * with our port. The user still has to enable it in MFP's plugin panel.
 */
export async function installPlugin(mfpExePath?: string): Promise<InstallResult> {
  const dir = mfpDir(mfpExePath)
  if (!dir) return { ok: false, pluginPath: null, reason: 'mfp_not_found' }
  const plugins = pluginsDirFor(dir)
  const target = join(plugins, PLUGIN_FILE)
  try {
    await mkdir(plugins, { recursive: true })
    await copyFile(bundledPluginPath(), target)
    const cfg = join(plugins, CONFIG_FILE)
    if (!existsSync(cfg)) {
      await writeFile(cfg, JSON.stringify({ port: DEFAULT_PORT }, null, 2), 'utf-8')
    }
    return { ok: true, pluginPath: target, reason: null }
  } catch (e) {
    console.error('[mfp-bridge] plugin install failed:', e)
    return { ok: false, pluginPath: null, reason: 'copy_failed' }
  }
}
