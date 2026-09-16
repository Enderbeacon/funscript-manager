import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import type { SyncProgress } from '@shared/schemas/media-index'
import { getSettings, listLibraries } from '../config/config-service'
import {
  libraryEvents,
  librariesReady,
  markLibrariesReady,
  startAllLibraries
} from '../library/library-manager'
import { createMainWindow, revealMainWindow } from '../main-window'
import { applyProxySettings } from '../net/proxy'
import { abandonPrefetch, justUpdatedTo, prefetchNotices } from '../updates/notices'
import { listReleases } from '../updates/releases'
import { checkForUpdates, endStartupPhase, initUpdates } from '../updates/updater'
import { closeCard, openCard, setStartupStatus } from './splash-window'
import {
  enableStartupArtworkPreparation,
  scheduleStartupArtworkPreparation
} from './artwork-pool'

/**
 * Getting the app ready before the user is handed a window.
 *
 * Two kinds of work happen here. Some has a known end — the settings, the
 * proxy, the window's first paint — and is simply waited for. The rest has no
 * upper bound: a library scan is as long as the library is, and a network
 * answer is as long as the network feels like. Those get a deadline and carry
 * on behind the window, because a card that sits there for three minutes is
 * indistinguishable from a hung app.
 *
 * The one thing that must not be pushed behind the window is asking about
 * releases and notices: an offer that arrives while someone is working is an
 * interruption, and one that arrives with the window is a greeting.
 */

/** Long enough for one round trip, short enough not to be felt. */
const UPDATE_DEADLINE_MS = 3_000

/** A small library finishes inside this; a large one carries on behind. */
const LIBRARY_DEADLINE_MS = 8_000

/** Only a renderer that never paints reaches this; the window opens anyway. */
const WINDOW_DEADLINE_MS = 20_000

/** Where each stage leaves the bar, so it only ever moves forwards. */
const BAND = {
  starting: [0, 8],
  updates: [8, 30],
  library: [30, 80],
  window: [80, 100]
} as const

function along(band: readonly [number, number], fraction: number): number {
  return Math.round(band[0] + (band[1] - band[0]) * Math.min(Math.max(fraction, 0), 1))
}

let paint = (): void => {}
const painted = new Promise<void>((resolve) => {
  paint = resolve
})

let settle = (): void => {}
/** Resolves once the release check and the notices have had their deadline. */
const greeting = new Promise<void>((resolve) => {
  settle = resolve
})

/**
 * What the window may say when it opens, once it is known. The window loads
 * while the asking is still going on, so whoever draws the opening screen
 * waits for this rather than for whichever answer happened to arrive first.
 */
export function greetingSettled(): Promise<void> {
  return greeting
}

/** The main window has drawn its first screen (IPC `app:windowReady`). */
export function markWindowReady(): void {
  paint()
}

/** Wait for `work`, but never longer than `ms`; it runs on either way. */
function withDeadline(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    void work.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** Turn library sync events into a step the card can show. */
function followLibraries(libraries: RegisteredLibrary[]): () => void {
  const names = new Map(libraries.map((library) => [library.id, library.name]))
  const count = Math.max(libraries.length, 1)
  let finished = 0
  const onProgress = (p: SyncProgress): void => {
    if (p.phase === 'done') {
      finished = Math.min(finished + 1, libraries.length)
      return
    }
    const within = p.total > 0 ? p.processed / p.total : 0
    setStartupStatus({
      step: 'library',
      library: names.get(p.libraryId) ?? null,
      processed: p.processed,
      total: p.total,
      progress: along(BAND.library, (finished + within) / count)
    })
  }
  libraryEvents.on('sync-progress', onProgress)
  return () => void libraryEvents.off('sync-progress', onProgress)
}

export async function runStartup(settings: Settings | null): Promise<void> {
  const updated = justUpdatedTo()
  await openCard(settings)
  setStartupStatus({
    step: updated ? 'updated' : 'starting',
    version: updated,
    progress: along(BAND.starting, 0.5)
  })

  // Before anything reaches the network: the release check below, the
  // libraries and the download queue all go out through whatever this puts
  // in place.
  await applyProxySettings().catch((e) => console.error('[proxy] setup failed:', e))
  await initUpdates(settings)

  /*
   * The window starts loading here rather than at its own step below. Its
   * bundle is the slowest thing in this whole sequence and nothing else here
   * waits on it, so it loads hidden alongside the work that follows; by the
   * time the libraries are done it has usually already painted.
   */
  createMainWindow(settings?.ui.theme ?? 'system', false)

  // Releases and notices together, under one deadline. A card that opened on
  // `updated` keeps saying so — the run right after an install has its own news.
  // The release list is fetched outright, not only through the check: a check
  // skipped because an update is already downloaded would leave the version
  // list in the updates card empty until it was opened. The two share a request.
  setStartupStatus({ step: updated ? 'updated' : 'updates', progress: along(BAND.updates, 0) })
  await withDeadline(
    Promise.allSettled([
      listReleases(),
      checkForUpdates('startup'),
      prefetchNotices().catch((e) => console.warn('[updates] notices unavailable:', e))
    ]),
    UPDATE_DEADLINE_MS
  )
  abandonPrefetch()
  settle()

  // The libraries. Whatever is left when the deadline passes keeps running,
  // and the window shows its progress from then on.
  setStartupStatus({ step: 'library', version: null, progress: along(BAND.library, 0) })
  const libraries = await listLibraries().catch((e) => {
    console.error('[library] list unavailable:', e)
    return [] as RegisteredLibrary[]
  })
  const stopFollowing = followLibraries(libraries)
  const sync = startAllLibraries(libraries).catch((e) => {
    console.error('[library] startup sync failed:', e)
    // Whoever is waiting for the libraries waits forever otherwise.
    markLibrariesReady()
  })
  await withDeadline(sync, LIBRARY_DEADLINE_MS)
  stopFollowing()

  // Whatever is left of the window's own loading; usually nothing by now.
  setStartupStatus({
    step: 'window',
    library: null,
    processed: 0,
    total: 0,
    progress: along(BAND.window, 0)
  })
  await withDeadline(painted, WINDOW_DEADLINE_MS)

  setStartupStatus({ progress: 100 })
  revealMainWindow()
  closeCard()
  // From here the app answers, it does not interrupt.
  endStartupPhase()

  // High-resolution artwork is strictly after startup and after the initial
  // library pass. A settings change made while that pass was still running
  // wins over the routine refresh for the next launch.
  void librariesReady().then(async () => {
    const hadPendingSelection = enableStartupArtworkPreparation()
    if (hadPendingSelection) return
    const [latest, currentLibraries] = await Promise.all([getSettings(), listLibraries()])
    scheduleStartupArtworkPreparation(latest.ui, currentLibraries, undefined, true)
  }).catch((e) => console.error('[startup-artwork] activation failed:', e))
}
