import { EventEmitter } from 'node:events'
import { app } from 'electron'
import { HttpSource, UpdateManager, VelopackApp, type UpdateInfo, type VelopackAsset } from 'velopack'
import { AppError } from '@shared/errors'
import { compareVersions } from '@shared/semver'
import type { Settings } from '@shared/schemas/app-config'
import type { ReleaseSummary, UpdateState } from '@shared/schemas/updates'
import { getSettings } from '../config/config-service'
import { proxyForUrl } from '../net/proxy'
import { listReleases, newestFor, releaseBaseUrl, releasePageUrl, VELOPACK_CHANNEL } from './releases'
import { rememberWhatsNew } from './notices'
import { showInstallingCard } from '../startup/splash-window'

/**
 * Replacing the running app with another release.
 *
 * Velopack does the replacing: it downloads a release's package (or the delta
 * from the installed one), and a separate updater process swaps the files once
 * this app has exited, then optionally starts it again. Everything about
 * *which* release is decided here, from the GitHub release list.
 *
 * Nothing downloads on its own. An automatic check only finds out; the user
 * chooses to download, and a downloaded update is applied either by restarting
 * now or, failing that, when the app quits.
 */

export const updateEvents = new EventEmitter()

const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Where a check came from, which decides whether its answer may interrupt.
 * `startup` runs behind the startup card, so what it finds is part of the
 * first screen; `auto` is the periodic one and only ever updates the badge.
 */
type CheckOrigin = 'startup' | 'auto' | 'manual'

/**
 * True until the main window is handed to the user. Nothing asks for their
 * attention after that: an offer that arrives mid-task is an interruption,
 * and it keeps until the next start.
 */
let opening = true

/** The window is the user's now; unprompted dialogs stop here. */
export function endStartupPhase(): void {
  opening = false
}

/**
 * Whether to open the offer, answered once. The window asks as it loads, and
 * the flag is cleared with the answer: reopening the window later in the
 * session must not bring the dialog back with it.
 */
export function takePrompt(): boolean {
  const offer = state.prompt
  if (offer) setState({ prompt: false })
  return offer
}

/** What Velopack needs to apply: a checked update, or a package left from last run. */
type Applicable = UpdateInfo | VelopackAsset

let state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  supported: false,
  release: null,
  downgrade: false,
  progress: null,
  error: null,
  checkedAt: null,
  prompt: false
}

let manager: UpdateManager | null = null
let applicable: Applicable | null = null
let applying = false
let running: Promise<void> | null = null
let autoTimer: NodeJS.Timeout | null = null

function setState(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  updateEvents.emit('state', state)
}

export function updateState(): UpdateState {
  return state
}

/**
 * Must run before anything else in the main process. When the updater starts
 * the app to run an install or uninstall step, this handles it and exits.
 */
export function runUpdaterStartup(): void {
  try {
    VelopackApp.build()
      // A package downloaded last run waits for the user instead of being
      // applied the moment the app opens.
      .setAutoApplyOnStartup(false)
      .setLogger((level, message) => {
        if (level === 'error' || level === 'warn') console.warn(`[updates] ${message}`)
        else if (level === 'info') console.log(`[updates] ${message}`)
      })
      .run()
  } catch (e) {
    console.error('[updates] startup hook failed:', e)
  }
}

/** Called once the app is ready: learn what this copy is and what it has pending. */
export async function initUpdates(settings: Settings | null): Promise<void> {
  try {
    const probe = new UpdateManager(new HttpSource(releaseBaseUrlPlaceholder()))
    setState({ supported: true, currentVersion: probe.getCurrentVersion() })
    const pending = probe.getUpdatePendingRestart()
    if (pending) {
      manager = probe
      applicable = pending
      setState({
        phase: 'ready',
        release: {
          version: pending.Version,
          tag: `v${pending.Version}`,
          channel: pending.Version.includes('-') ? 'beta' : 'stable',
          publishedAt: null,
          url: releasePageUrl(`v${pending.Version}`),
          notes: pending.NotesMarkdown ?? ''
        },
        downgrade: compareVersions(pending.Version, state.currentVersion) < 0
      })
    }
  } catch (e) {
    // Not installed by the updater: a development run or a hand-copied folder.
    console.log('[updates] this copy cannot update itself:', String(e))
  }
  configureAutoCheck(settings)
}

/** Any valid source will do when only asking about the installed copy. */
function releaseBaseUrlPlaceholder(): string {
  return releaseBaseUrl({ version: '0.0.0', tag: 'v0.0.0', channel: 'stable', publishedAt: null, url: '', notes: '' })
}

/** Start, stop or keep the periodic check to match the setting. */
export function configureAutoCheck(settings: Settings | null): void {
  const wanted = settings?.updates.autoCheck ?? true
  if (!wanted) {
    if (autoTimer) clearTimeout(autoTimer)
    autoTimer = null
    return
  }
  if (autoTimer) return
  const schedule = (): void => {
    autoTimer = setTimeout(() => {
      void checkForUpdates('auto').finally(() => {
        if (autoTimer) schedule()
      })
    }, AUTO_CHECK_INTERVAL_MS)
  }
  // The first check of a run happens behind the startup card; this one only
  // covers an app left open for hours.
  schedule()
}

/** One operation at a time; a second request while one runs gets the first. */
function exclusive(task: () => Promise<void>): Promise<void> {
  if (running) return running
  running = task().finally(() => {
    running = null
  })
  return running
}

function busy(): boolean {
  return state.phase === 'downloading' || state.phase === 'ready' || applying
}

/** Look for a newer release on the configured channel. */
export function checkForUpdates(origin: CheckOrigin): Promise<void> {
  // A download in progress or waiting to be applied already is the answer.
  if (busy()) return Promise.resolve()
  return exclusive(async () => {
    setState({ phase: 'checking', error: null, prompt: false })
    try {
      const settings = await getSettings()
      const releases = await listReleases(origin === 'manual')
      const newest = newestFor(releases, settings.updates.channel)
      setState({ checkedAt: new Date().toISOString() })
      if (!newest || compareVersions(newest.version, state.currentVersion) <= 0) {
        setState({ phase: 'upToDate', release: null })
        return
      }
      if (state.supported) {
        const found = await prepare(newest, false)
        if (!found) {
          setState({ phase: 'upToDate', release: null })
          return
        }
      }
      setState({
        phase: 'available',
        release: newest,
        downgrade: false,
        // Only the check behind the startup card may put a dialog on screen,
        // and only if the window has not been handed over while it ran.
        prompt: origin === 'startup' && opening && settings.updates.skippedVersion !== newest.version
      })
    } catch (e) {
      failWith(e, 'update_check_failed', origin !== 'manual')
    }
  })
}

/**
 * Point the updater at one release and ask what applying it would take.
 * Null when the release's feed offers nothing to move to.
 */
async function prepare(release: ReleaseSummary, allowDowngrade: boolean): Promise<UpdateInfo | null> {
  // An `HttpSource`, explicitly: handed a plain string, the updater sees
  // github.com and talks to the GitHub API instead — and a release's download
  // folder is not an API path, so every check came back 404.
  const next = new UpdateManager(new HttpSource(releaseBaseUrl(release)), {
    AllowVersionDowngrade: allowDowngrade,
    // Always explicit: left out, the updater looks for the channel this copy
    // was installed from, which is the wrong feed after switching channels.
    ExplicitChannel: VELOPACK_CHANNEL[release.channel],
    MaximumDeltasBeforeFallback: 10
  })
  const info = await withProxy(() => next.checkForUpdatesAsync())
  if (!info || info.TargetFullRelease.Version !== release.version) {
    if (info) console.warn(`[updates] ${release.tag} feed offered ${info.TargetFullRelease.Version}`)
    return null
  }
  manager = next
  applicable = info
  return info
}

/** Download the release the last check found. */
export function downloadUpdate(): Promise<void> {
  return exclusive(async () => {
    if (state.phase !== 'available' || !state.release) return
    if (!state.supported) throw new AppError('update_not_supported')
    await download(state.release, state.downgrade)
  })
}

/** Download any published release, older ones included, to replace this one. */
export function installRelease(version: string): Promise<void> {
  if (busy()) return Promise.resolve()
  return exclusive(async () => {
    if (!state.supported) throw new AppError('update_not_supported')
    setState({ phase: 'checking', error: null, prompt: false })
    try {
      const release = (await listReleases()).find((r) => r.version === version)
      if (!release) throw new AppError('update_release_not_found')
      const info = await prepare(release, true)
      if (!info) throw new AppError('update_release_not_found')
      await download(release, info.IsDowngrade)
    } catch (e) {
      failWith(e, 'update_download_failed', false)
    }
  })
}

async function download(release: ReleaseSummary, downgrade: boolean): Promise<void> {
  const target = manager
  const info = applicable
  if (!target || !info || !('TargetFullRelease' in info)) throw new AppError('update_download_failed')
  setState({ phase: 'downloading', release, downgrade, progress: 0, error: null, prompt: false })
  try {
    let last = -1
    await withProxy(() =>
      target.downloadUpdateAsync(info, (percent) => {
        // The updater reports often; the window only needs whole steps.
        const rounded = Math.floor(percent)
        if (rounded === last) return
        last = rounded
        setState({ progress: rounded })
      })
    )
    setState({ phase: 'ready', progress: 100 })
  } catch (e) {
    failWith(e, 'update_download_failed', false)
  }
}

/** Restart into the downloaded release now. */
export async function restartToUpdate(): Promise<void> {
  if (state.phase !== 'ready' || !manager || !applicable || applying) return
  // The app is about to be gone for a few seconds while its files are
  // replaced. The card says so; without it the screen just empties.
  await showInstallingCard()
  apply(true)
  app.quit()
}

/**
 * Called while the app quits. A downloaded update the user did not restart
 * for is applied on the way out, so the next start is already the new version.
 */
export function applyPendingOnQuit(): void {
  if (state.phase !== 'ready' || !manager || !applicable || applying) return
  apply(false)
}

function apply(restart: boolean): void {
  if (!manager || !applicable || !state.release) return
  applying = true
  try {
    rememberWhatsNew(state.release.version, state.release.notes)
    // The updater process waits for this one to exit before touching files.
    manager.waitExitThenApplyUpdate(applicable, true, restart, [])
  } catch (e) {
    applying = false
    failWith(e, 'update_download_failed', false)
  }
}

function failWith(e: unknown, fallback: 'update_check_failed' | 'update_download_failed', quiet: boolean): void {
  const code = e instanceof AppError ? e.code : fallback
  if (!(e instanceof AppError)) console.warn('[updates]', e)
  // An automatic check that could not reach GitHub is not worth an error on
  // screen; the settings page still shows the last good answer.
  if (quiet) setState({ phase: state.release ? 'available' : 'idle', error: null })
  else setState({ phase: 'error', error: code, progress: null })
}

/**
 * Run an updater request with the app's proxy in the environment.
 *
 * The updater's HTTP client reads the standard proxy variables and nothing
 * else — not Chromium's session, not Windows' proxy setting. So the address is
 * worked out the way the rest of the app would reach GitHub (the configured
 * proxy, else whatever the system resolves for it) and set for the length of
 * the request. Child processes started meanwhile inherit it, which sends them
 * the same way the app already goes.
 */
async function withProxy<T>(request: () => Promise<T>): Promise<T> {
  const proxy = await proxyForUpdates()
  const keys = ['HTTPS_PROXY', 'HTTP_PROXY'] as const
  const saved = keys.map((k) => process.env[k])
  for (const k of keys) {
    if (proxy) process.env[k] = proxy
    else delete process.env[k]
  }
  try {
    return await request()
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) delete process.env[k]
      else process.env[k] = saved[i]
    })
  }
}

async function proxyForUpdates(): Promise<string | null> {
  return (await proxyForUrl('https://github.com/')) || null
}
