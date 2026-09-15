import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net'
import type { MediaSourceProfile } from '../src/shared/schemas/app-config'
import {
  activeMediaSource,
  activeReading,
  configureMediaSources,
  disposeMediaSources,
  mediaSourceStatus,
  setCurrentSource
} from '../src/main/services/playback/sources/registry'

/**
 * The player list itself: one player is in use, and only that one is ever
 * connected. What is checked here is the part with no visible symptom — that
 * switching pauses the player being left before letting go of it, and that
 * whatever the new one already has open becomes what the app is on.
 *
 * Two stand-in HereSphere sockets play the part of two players, because the
 * question is about the list, not about any one protocol.
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

function frame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

interface FakePlayer {
  port: number
  /** Announce what it is playing, the way HereSphere does. */
  play: (path: string, playing: boolean) => void
  /** Commands it was sent (keep-alives excluded). */
  received: Record<string, unknown>[]
  /** How many times something connected to it. */
  connections: () => number
  connected: () => boolean
  close: () => void
}

async function fakePlayer(): Promise<FakePlayer> {
  let socket: Socket | null = null
  let connections = 0
  const received: Record<string, unknown>[] = []
  const server = createTcpServer((s) => {
    socket = s
    connections++
    let buffer = Buffer.alloc(0)
    s.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 4) return
        const length = buffer.readInt32LE(0)
        if (length === 0) {
          buffer = buffer.subarray(4)
          continue
        }
        if (buffer.length < 4 + length) return
        received.push(JSON.parse(buffer.subarray(4, 4 + length).toString('utf-8')))
        buffer = buffer.subarray(4 + length)
      }
    })
    s.on('close', () => {
      if (socket === s) socket = null
    })
    s.on('error', () => {})
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    port: (server.address() as AddressInfo).port,
    play: (path, playing) =>
      socket?.write(frame({ path, playerState: playing ? 0 : 1, currentTime: 1, duration: 600 })),
    received,
    connections: () => connections,
    connected: () => socket !== null,
    close: () => {
      socket?.destroy()
      server.close()
    }
  }
}

function profile(id: string, name: string, port: number): MediaSourceProfile {
  return { id, name, kind: 'heresphere', exePath: '', host: '127.0.0.1', port }
}

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'

function statusOf(id: string): ReturnType<typeof mediaSourceStatus>[number] | undefined {
  return mediaSourceStatus().find((s) => s.id === id)
}

async function main(): Promise<void> {
  console.log('player list')
  const a = await fakePlayer()
  const b = await fakePlayer()

  try {
    configureMediaSources([profile(ID_A, 'A', a.port), profile(ID_B, 'B', b.port)], ID_A)
    await wait(2400)

    check('both are listed', mediaSourceStatus().length === 2, mediaSourceStatus().length)
    check('the chosen one is marked', statusOf(ID_A)?.current === true, statusOf(ID_A))
    check('and it is the one connected', statusOf(ID_A)?.state === 'connected', statusOf(ID_A))
    check('the other is never reached for', b.connections() === 0, b.connections())
    check('the other is not connected', statusOf(ID_B)?.state === 'disconnected', statusOf(ID_B))

    a.play('C:\\clips\\a.mp4', true)
    await wait(300)
    check(
      'the app is on what it is playing',
      activeReading().path === 'C:\\clips\\a.mp4',
      activeReading()
    )
    check('the current player is the live one', activeMediaSource()?.id === ID_A)

    // Switching: the one being left is paused, then let go of.
    await setCurrentSource(ID_B)
    await wait(400)
    check(
      'the player being left is paused first',
      a.received.some((m) => m['playerState'] === 1),
      a.received
    )
    check('and then disconnected', statusOf(ID_A)?.state === 'disconnected', statusOf(ID_A))
    check('the new one is connected', statusOf(ID_B)?.state === 'connected', statusOf(ID_B))
    check('only one is live at a time', !a.connected() && b.connected())

    b.play('C:\\vr\\b.mp4', true)
    await wait(300)
    check(
      'what the new one has open is what the app is on',
      activeReading().path === 'C:\\vr\\b.mp4',
      activeReading()
    )

    // Removing the player in use falls back rather than leaving nothing.
    configureMediaSources([profile(ID_A, 'A', a.port)], ID_B)
    await wait(2400)
    check('a removed player is gone from the list', mediaSourceStatus().length === 1)
    check('the remaining one is in use', statusOf(ID_A)?.current === true, statusOf(ID_A))
    check('which means connected', statusOf(ID_A)?.state === 'connected', statusOf(ID_A))

    // A player that drops is reported, not silently forgotten.
    a.close()
    await wait(400)
    check('a lost connection is reported', statusOf(ID_A)?.error === 'connection_lost', statusOf(ID_A))
    check('with nothing live, the app is on nothing', activeReading().path === null)
  } finally {
    await disposeMediaSources()
    a.close()
    b.close()
  }

  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  // Not process.exit: the runner imports these one after another.
  if (failures > 0) process.exitCode = 1
}

await main()
