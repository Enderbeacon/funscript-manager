import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'

/**
 * Listen to what HereSphere says about itself, and print it.
 *
 * The app follows a player by the file path it reports. When picking a video
 * in the headset does not move the app, the question is what that report
 * actually contains — a Windows path, a URL, or nothing at all. This connects
 * the same way the app does and prints every frame, so the answer is on the
 * screen instead of in a guess.
 *
 *   node scripts/heresphere-probe.mjs [host] [port]
 *
 * Leave it running, change the video in the headset, then stop it (Ctrl+C).
 */

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 23554)

const stamp = () => new Date().toISOString().slice(11, 23)

console.log(`connecting to ${host}:${port} …`)

const socket = createConnection({ host, port })
let buffer = Buffer.alloc(0)
let frames = 0

socket.on('connect', () => {
  console.log(`${stamp()} connected. Change the video in HereSphere; Ctrl+C when done.\n`)
  setInterval(() => socket.write(Buffer.alloc(4)), 1000)
})

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    if (buffer.length < 4) return
    const length = buffer.readInt32LE(0)
    if (length <= 0) {
      buffer = buffer.subarray(4)
      console.log(`${stamp()} empty frame (nothing loaded)`)
      continue
    }
    if (buffer.length < 4 + length) return
    const body = buffer.subarray(4, 4 + length).toString('utf-8')
    buffer = buffer.subarray(4 + length)
    frames++
    report(body)
  }
})

socket.on('error', (error) => {
  console.error(`${stamp()} socket error:`, error.message)
  process.exit(1)
})

socket.on('close', () => {
  console.log(`${stamp()} connection closed after ${frames} frame(s)`)
  process.exit(0)
})

let lastResource = null

function report(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    console.log(`${stamp()} unparseable frame: ${body.slice(0, 200)}`)
    return
  }

  const resource = typeof parsed.resource === 'string' ? parsed.resource : parsed.path
  const state = parsed.playerState
  const time = parsed.currentTime
  const duration = parsed.duration

  // The whole frame, once per file, and a short line for the rest — a video
  // playing sends these constantly and the file is what matters here.
  if (resource !== lastResource) {
    lastResource = resource ?? null
    console.log(`\n${stamp()} NEW FILE`)
    console.log(`  raw frame     ${body.slice(0, 600)}`)
    console.log(`  resource      ${JSON.stringify(resource)}`)
    console.log(`  looks like    ${describe(resource)}`)
    if (parsed.identifier !== undefined) {
      console.log(`  identifier    ${JSON.stringify(parsed.identifier)}`)
    }
    console.log(`  keys          ${Object.keys(parsed).join(', ')}`)
    return
  }

  console.log(
    `${stamp()} state=${state} time=${fmt(time)} duration=${fmt(duration)}`
  )
}

function fmt(value) {
  return typeof value === 'number' ? value.toFixed(2) : String(value)
}

function describe(resource) {
  if (typeof resource !== 'string' || !resource.trim()) return 'nothing'
  if (/^[a-zA-Z]:[\\/]/.test(resource)) {
    return existsSync(resource)
      ? 'a Windows path, and the file is there — the app can match this'
      : 'a Windows path, but no such file on this machine'
  }
  if (resource.startsWith('file://')) return 'a file:// URL (the app does not decode these yet)'
  if (/^[a-z]+:\/\//i.test(resource)) return 'a URL, not a path — the app cannot match this'
  if (resource.startsWith('\\\\')) return 'a UNC network path'
  return 'something else — not an absolute path'
}
