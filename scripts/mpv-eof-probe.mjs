/*
 * Does mpv actually tell us a video finished?
 *
 * Autoplay rests on one assumption: with `--keep-open`, reaching the end of a
 * file sets `eof-reached` to true rather than firing `end-file`. That is what
 * mpv's documentation says, but this app talks to two different mpvs — the one
 * it starts itself and the one MultiFunPlayer starts, which has different
 * flags — and neither has ever been watched at the moment a video ran out.
 *
 * This connects to the same pipe the app uses and prints, with timestamps,
 * every signal that could plausibly mean "finished". It starts nothing, plays
 * nothing and changes nothing: it only listens.
 *
 * Run it, then in mpv let a short video play to its end, and afterwards try
 * pausing by hand, seeking to the last seconds, and closing the window — the
 * log tells you which of those look the same and which are distinguishable.
 *
 *   node scripts/mpv-eof-probe.mjs
 */

import net from 'node:net'

/*
 * Written the way mpv-ipc.ts writes it. Each backslash in the real name needs
 * two here, and getting that wrong produces a name that looks right when
 * printed and simply never connects.
 */
const PIPE_NAME = process.env.FSM_MPV_PIPE || 'multifunplayer-mpv'
const PIPE = `\\\\.\\pipe\\${PIPE_NAME}`

/** Properties worth watching, and the id each is observed under. */
const WATCH = [
  'eof-reached',
  'idle-active',
  'pause',
  'path',
  'filename',
  'duration',
  'time-pos',
  'playlist-pos',
  'playlist-count',
  'keep-open'
]

const started = Date.now()
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1)}s`.padStart(7)

/** time-pos fires several times a second; only its jumps are interesting. */
let lastPos = null
function noisy(name, value) {
  if (name !== 'time-pos') return false
  if (typeof value !== 'number') return false
  const skip = lastPos !== null && Math.abs(value - lastPos) < 5
  lastPos = value
  return skip
}

const socket = net.createConnection(PIPE)
let buffer = ''
let nextId = 1

socket.on('connect', () => {
  console.log(`${stamp()}  connected to ${PIPE}`)
  console.log(`${stamp()}  watching: ${WATCH.join(', ')}`)
  console.log('')
  console.log('  Now, in mpv: let a video play to its end. Then try pausing by')
  console.log('  hand, seeking into the last seconds, and closing the window.')
  console.log('  Ctrl+C when done.')
  console.log('')
  for (const [i, name] of WATCH.entries()) {
    socket.write(`${JSON.stringify({ command: ['observe_property', i + 1, name], request_id: nextId++ })}\n`)
  }
})

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  for (;;) {
    const cut = buffer.indexOf('\n')
    if (cut < 0) break
    const line = buffer.slice(0, cut).trim()
    buffer = buffer.slice(cut + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.event === 'property-change') {
      const name = WATCH[msg.id - 1] ?? `#${msg.id}`
      if (noisy(name, msg.data)) continue
      console.log(`${stamp()}  ${name} = ${JSON.stringify(msg.data)}`)
    } else if (msg.event) {
      // end-file carries the reason we would most like to have; print it whole.
      console.log(`${stamp()}  EVENT ${JSON.stringify(msg)}`)
    }
  }
})

socket.on('error', (e) => {
  console.error(`${stamp()}  could not connect: ${e.message}`)
  console.error('')
  console.error('  mpv has to be running with --input-ipc-server=multifunplayer-mpv.')
  console.error('  Start it from the app (the connection indicator in the sidebar),')
  console.error('  or let MultiFunPlayer start it, then run this again.')
  process.exit(1)
})

socket.on('close', () => {
  console.log(`${stamp()}  pipe closed — mpv exited or the connection dropped`)
  process.exit(0)
})
