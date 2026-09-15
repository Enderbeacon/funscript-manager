import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createTcpServer, type Socket } from 'node:net'
import { AddressInfo } from 'node:net'
import { MediaClock } from '../src/main/services/playback/sources/clock'
import { MpcSource } from '../src/main/services/playback/sources/mpc-source'
import { HereSphereSource } from '../src/main/services/playback/sources/heresphere-source'

/**
 * Protocol check for the two players we cannot see from here.
 *
 * Each one gets a stand-in that speaks its side of the wire — an MPC-HC web
 * interface and a HereSphere sync socket — so what is verified is the parsing,
 * the framing and the exact requests we send, without either program being
 * installed. What it cannot verify is that the real programs agree with their
 * own documentation; that is the run on the user's machine.
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

function near(actual: number | null, expected: number, tolerance: number): boolean {
  return actual !== null && Math.abs(actual - expected) <= tolerance
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ clock */

async function checkClock(): Promise<void> {
  console.log('clock')
  const clock = new MediaClock()
  clock.setPaused(false)
  clock.setPosition(10_000)
  await wait(120)
  check('extrapolates while playing', near(clock.positionMs(), 10_120, 60), clock.positionMs())

  clock.setPaused(true)
  const frozen = clock.positionMs()
  await wait(80)
  check('freezes while paused', clock.positionMs() === frozen, clock.positionMs())

  clock.setPaused(false)
  clock.setSpeed(2)
  clock.setPosition(0)
  await wait(100)
  check('follows playback speed', near(clock.positionMs(), 200, 80), clock.positionMs())

  clock.invalidatePosition()
  check('a seek clears the baseline', clock.positionMs() === null)
}

/* ----------------------------------------------------------------- MPC-HC */

interface MpcState {
  state: number
  filepath: string
  position: number
  duration: number
  volumelevel: number
  muted: number
}

async function checkMpc(): Promise<void> {
  console.log('MPC-HC')
  const state: MpcState = {
    state: 2,
    filepath: 'C:\\clips\\a.mp4',
    position: 1000,
    duration: 60_000,
    volumelevel: 70,
    muted: 0
  }
  const commands: string[] = []

  const server = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? ''
    if (url.startsWith('/variables.html')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(
        `<p id="state">${state.state}</p><p id="statestring">x</p>` +
          `<p id="position">${state.position}</p><p id="duration">${state.duration}</p>` +
          `<p id="filepath">${state.filepath}</p><p id="playbackrate">1</p>` +
          `<p id="volumelevel">${state.volumelevel}</p><p id="muted">${state.muted}</p>`
      )
      return
    }
    commands.push(url)
    res.writeHead(200)
    res.end('ok')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  const source = new MpcSource('127.0.0.1', port, '')
  const paths: (string | null)[] = []
  let ended = 0
  source.on('path-changed', ({ path }) => paths.push(path))
  source.on('ended', () => ended++)

  try {
    await source.connect({ launch: false })
    check('connects to the web interface', source.read().path === state.filepath, source.read())
    check('reports the file it is on', paths[0] === state.filepath, paths)
    check('reads duration', source.read().durationMs === 60_000, source.read().durationMs)
    check('playing means not paused', source.read().paused === false)

    await source.setPaused(true)
    check('pause is command 888', commands.some((c) => c.includes('wm_command=888')), commands)
    await source.setPaused(false)
    check('play is command 887', commands.some((c) => c.includes('wm_command=887')), commands)

    check('reads the volume', source.read().volume === 70, source.read().volume)
    state.muted = 1
    await wait(320)
    check('muted reads as zero', source.read().volume === 0, source.read().volume)
    state.muted = 0

    await source.setVolume(35)
    check(
      'volume is command -2',
      commands.some((c) => c.includes('wm_command=-2&volume=35')),
      commands
    )
    check('and shows straight away', source.read().volume === 35, source.read().volume)

    await source.seek(3_725_000)
    check(
      'seek sends hh:mm:ss',
      commands.some((c) => c.includes('wm_command=-1&position=01:02:05')),
      commands
    )

    // A different file: the app has to hear about it to follow the player.
    state.filepath = 'C:\\clips\\b.mp4'
    state.position = 59_900
    await wait(320)
    check('follows a file the user opened', paths.includes('C:\\clips\\b.mp4'), paths)

    // Ending: it stops with the position at the end of the file.
    state.state = 0
    await wait(320)
    check('reports a file that ran out', ended === 1, ended)

    // Stopping in the middle is not the file ending.
    state.filepath = 'C:\\clips\\c.mp4'
    state.state = 2
    state.position = 1000
    await wait(320)
    state.state = 0
    await wait(320)
    check('a stop in the middle is not an ending', ended === 1, ended)

    await source.open('C:\\clips\\d.mp4', null)
    check(
      'open uses the file browser endpoint',
      commands.some((c) => c.startsWith('/browser.html?path=C%3A%5Cclips%5Cd.mp4')),
      commands.filter((c) => c.startsWith('/browser'))
    )
  } finally {
    await source.disconnect()
    server.close()
  }
}

/* ------------------------------------------------------------- HereSphere */

function frame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

async function checkHereSphere(): Promise<void> {
  console.log('HereSphere')
  const received: unknown[] = []
  let keepAlives = 0
  let client: Socket | null = null

  const server = createTcpServer((socket) => {
    client = socket
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (buffer.length < 4) return
        const length = buffer.readInt32LE(0)
        if (length === 0) {
          keepAlives++
          buffer = buffer.subarray(4)
          continue
        }
        if (buffer.length < 4 + length) return
        received.push(JSON.parse(buffer.subarray(4, 4 + length).toString('utf-8')))
        buffer = buffer.subarray(4 + length)
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port

  const source = new HereSphereSource('127.0.0.1', port)
  const paths: (string | null)[] = []
  let ended = 0
  source.on('path-changed', ({ path }) => paths.push(path))
  source.on('ended', () => ended++)

  try {
    await source.connect({ launch: false })
    // The client's connect event can beat the server's accept handler.
    await wait(80)
    check('connects to the sync socket', client !== null)

    client!.write(
      frame({ resource: 'C:\\vr\\scene.mp4', playerState: 0, duration: 600, currentTime: 12.5 })
    )
    await wait(120)
    check('reads the file it is on', source.read().path === 'C:\\vr\\scene.mp4', source.read())
    check('seconds become milliseconds', near(source.read().positionMs, 12_500, 200), source.read())
    check('duration in milliseconds', source.read().durationMs === 600_000, source.read())
    check('state 0 means playing', source.read().paused === false)

    // Two frames split across one packet, and one packet split across two
    // frames: the length prefix is the only thing separating them.
    const a = frame({ resource: 'C:\\vr\\scene.mp4', playerState: 1, currentTime: 20 })
    const b = frame({ resource: 'C:\\vr\\other.mp4', playerState: 0, currentTime: 0, duration: 300 })
    client!.write(Buffer.concat([a, b.subarray(0, 5)]))
    await wait(60)
    client!.write(b.subarray(5))
    await wait(120)
    check('reassembles split frames', paths.includes('C:\\vr\\other.mp4'), paths)

    // A zero length is how it says nothing is loaded.
    client!.write(Buffer.alloc(4))
    await wait(120)
    check('an empty frame means no file', source.read().path === null, source.read())

    await source.setPaused(true)
    await wait(60)
    check(
      'pause sends playerState 1',
      received.some((m) => (m as { playerState?: number }).playerState === 1),
      received
    )

    await source.seek(45_000)
    await wait(60)
    check(
      'seek sends seconds',
      received.some((m) => (m as { currentTime?: number }).currentTime === 45),
      received
    )

    void source.open('C:\\vr\\next.mp4', null)
    await wait(60)
    check(
      'open sends the path',
      received.some((m) => (m as { path?: string }).path === 'C:\\vr\\next.mp4'),
      received
    )

    // Running out: the last position with the file no longer advancing.
    client!.write(frame({ resource: 'C:\\vr\\end.mp4', playerState: 0, duration: 100, currentTime: 0 }))
    await wait(80)
    client!.write(frame({ resource: 'C:\\vr\\end.mp4', playerState: 1, currentTime: 99.8 }))
    await wait(120)
    check('reports a file that ran out', ended === 1, ended)

    await wait(1100)
    check('sends a keep-alive', keepAlives >= 1, keepAlives)

    client!.destroy()
    await wait(150)
    check('a dropped socket is not a live player', source.read().path === null)
  } finally {
    await source.disconnect()
    server.close()
  }
}

async function main(): Promise<void> {
  await checkClock()
  await checkMpc()
  await checkHereSphere()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  // Not process.exit: the runner imports these one after another.
  if (failures > 0) process.exitCode = 1
}

await main()
