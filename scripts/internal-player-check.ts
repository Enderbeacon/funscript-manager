import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import {
  BUILT_IN_SOURCE_ID,
  DEFAULT_MPV_SOURCE_ID,
  SettingsSchema
} from '../src/shared/schemas/app-config'
import { InternalSource } from '../src/main/services/playback/sources/internal-source'
import {
  configureMediaSources,
  disposeMediaSources,
  mediaSourceStatus
} from '../src/main/services/playback/sources/registry'
import {
  claimVideoSurface,
  hasVideoSurface,
  releaseVideoSurface,
  reportVideoState,
  videoIntent,
  videoSurfaceEvents
} from '../src/main/services/playback/internal/surface'

/**
 * The built-in picture, from the main process's side.
 *
 * None of this has a visible symptom to check by eye: the picture either shows
 * the right file or it does not, and the ways it can be wrong — a report from
 * the file before last moving the bar, an ended file counted twice, the player
 * declaring itself gone during the moment the picture is being moved between
 * windows — all look like "it glitched" from the outside.
 *
 * The surface is stood in for by a plain emitter. The real one is a renderer,
 * and what this side knows about it is exactly what is exercised here: it can
 * be claimed, it can go away, and it sends reports.
 */

let failures = 0

function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok   ${name}`)
    return
  }
  failures++
  console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Enough of a WebContents for the surface: an id and a `destroyed` event. */
function fakeWindow(): WebContents {
  const emitter = new EventEmitter() as EventEmitter & { isDestroyed: () => boolean }
  emitter.isDestroyed = () => false
  return emitter as unknown as WebContents
}

async function settings(): Promise<void> {
  console.log('settings')

  const fresh = SettingsSchema.parse({})
  check('a fresh install has the built-in player', fresh.playback.sources[0]?.kind === 'internal')
  check('and it is the one in use', fresh.playback.currentSourceId === BUILT_IN_SOURCE_ID)
  check('mpv is there too', fresh.playback.sources.some((s) => s.kind === 'mpv'))

  // A settings file written before the built-in player existed.
  const older = SettingsSchema.parse({
    playback: {
      sources: [
        {
          id: DEFAULT_MPV_SOURCE_ID,
          name: 'mpv',
          kind: 'mpv',
          exePath: 'C:/mpv/mpv.exe',
          host: '127.0.0.1',
          port: 13579
        }
      ],
      currentSourceId: DEFAULT_MPV_SOURCE_ID
    }
  })
  check('an older settings file gains it', older.playback.sources[0]?.kind === 'internal')
  check('at the top of the list', older.playback.sources.length === 2)
  check(
    'without disturbing what was chosen',
    older.playback.currentSourceId === DEFAULT_MPV_SOURCE_ID
  )
  check(
    'or the paths already set',
    older.playback.sources.find((s) => s.kind === 'mpv')?.exePath === 'C:/mpv/mpv.exe'
  )

  const doubled = SettingsSchema.parse({
    playback: {
      sources: [
        { id: BUILT_IN_SOURCE_ID, name: 'Built-in player', kind: 'internal' },
        { id: '696e7472-0000-4000-8000-000000000009', name: 'Another', kind: 'internal' }
      ]
    }
  })
  check(
    'there is only ever one of it',
    doubled.playback.sources.filter((s) => s.kind === 'internal').length === 1
  )

  check(
    'closing the picture stops playback by default',
    fresh.playback.keepPlayingWhenClosed === false
  )
}

async function connecting(): Promise<void> {
  console.log('connecting')

  const source = new InternalSource()
  let failed = false
  await source.connect({ launch: false }).catch(() => {
    failed = true
  })
  check('the background scan never opens a picture', failed)
  check('and asks for none', videoIntent().active === false)

  // Pressing play asks for one, and waits for the window to answer.
  const window = fakeWindow()
  const connecting = source.connect({ launch: true })
  await wait(80)
  check('pressing play asks for a picture', videoIntent().active === true)
  claimVideoSurface(window)
  await connecting
  check('and connects once a window has it', hasVideoSurface())

  await source.disconnect()
  check('letting go leaves nothing on screen', videoIntent().active === false)
  check('and nothing loaded', videoIntent().media === null)
  releaseVideoSurface(window)
}

async function playing(): Promise<void> {
  console.log('playing')

  const source = new InternalSource()
  const window = fakeWindow()
  claimVideoSurface(window)
  await source.connect({ launch: true })

  await source.open('F:/Video/Scene-03.mp4', 90_000)
  const intent = videoIntent()
  check('the picture is told the path', intent.media?.path === 'F:/Video/Scene-03.mp4')
  check('and the name to show', intent.media?.fileName === 'Scene-03.mp4')
  check('resuming asks for the position', intent.seekMs === 90_000)
  check('and starts it playing', intent.paused === false)

  const report = (path: string | null, positionMs: number, ended = false): void =>
    reportVideoState({
      path,
      positionMs,
      durationMs: 600_000,
      paused: false,
      volume: 80,
      ended,
      error: null
    })

  report('F:/Video/Scene-03.mp4', 91_000)
  check('the position comes back', Math.abs((source.read().positionMs ?? 0) - 91_000) < 60)
  check('so does the length', source.read().durationMs === 600_000)
  check('and the volume', source.read().volume === 80)

  // A report about a file we have already left behind.
  report('F:/Video/Something-else.mp4', 5_000)
  check(
    'a report about another file is dropped',
    Math.abs((source.read().positionMs ?? 0) - 91_000) < 200
  )

  let ended = 0
  source.on('ended', () => {
    ended++
  })
  report('F:/Video/Scene-03.mp4', 600_000, true)
  report('F:/Video/Scene-03.mp4', 600_000, true)
  report('F:/Video/Scene-03.mp4', 600_000, true)
  check('a finished file is reported once', ended === 1, { ended })

  // Seeking is an edge: the same position asked for twice is two requests.
  const before = videoIntent().seekToken
  await source.seek(120_000)
  await source.seek(120_000)
  check('every seek is its own request', videoIntent().seekToken === before + 2)
  check('and carries where to', videoIntent().seekMs === 120_000)
  check(
    'the clock moves without waiting to be told',
    Math.abs((source.read().positionMs ?? 0) - 120_000) < 60
  )

  await source.setPaused(true)
  check('pausing reaches the picture', videoIntent().paused === true)
  await source.setVolume(35)
  check('so does the volume', videoIntent().volume === 35)

  await source.disconnect()
  releaseVideoSurface(window)
}

async function atRest(): Promise<void> {
  console.log('at rest')

  configureMediaSources(
    [
      {
        id: BUILT_IN_SOURCE_ID,
        name: 'Built-in player',
        kind: 'internal',
        exePath: '',
        host: '127.0.0.1',
        port: 13579
      }
    ],
    BUILT_IN_SOURCE_ID
  )
  // Long enough for the retry scan to have had its first go.
  await wait(2200)
  const row = mediaSourceStatus().find((s) => s.kind === 'internal')
  check('a closed picture is not a broken player', row?.state !== 'error', row?.state)
  check('nothing opened one in the background', videoIntent().active === false)
  await disposeMediaSources()
}

async function handover(): Promise<void> {
  console.log('moving the picture between windows')

  const source = new InternalSource()
  const docked = fakeWindow()
  claimVideoSurface(docked)
  await source.connect({ launch: true })
  await source.open('F:/Video/Scene-03.mp4', 0)

  let lost = 0
  source.on('closed', () => {
    lost++
  })

  // Popping out: the docked element unmounts before the new window mounts, so
  // there is always a moment with no picture anywhere.
  releaseVideoSurface(docked)
  await wait(200)
  const detached = fakeWindow()
  claimVideoSurface(detached)
  await wait(1600)
  check('moving it to its own window is not losing the player', lost === 0, { lost })
  check('and the file stays loaded', videoIntent().media?.path === 'F:/Video/Scene-03.mp4')

  // A window that goes away with nothing taking over is the player going away.
  releaseVideoSurface(detached)
  await wait(1800)
  check('but a picture that is gone for good is', lost === 1, { lost })

  await source.disconnect()
}

await settings()
await connecting()
await playing()
await atRest()
await handover()

videoSurfaceEvents.removeAllListeners()

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
if (failures > 0) process.exitCode = 1
