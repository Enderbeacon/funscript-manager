import assert from 'node:assert/strict'
import { interpolateAt, type Point } from '../src/script-player/domain/engine/interpolate'
import { CURSOR_AFTER, CURSOR_BEFORE, CURSOR_INVALID, sampleScript } from '../src/script-player/domain/engine/evaluate'
import {
  createAxisPipelineState,
  resetSync,
  shapeScriptValue,
  stepAxis,
  syncProgress,
  type AxisPipelineInput
} from '../src/script-player/domain/engine/axis-pipeline'
import { applyAxisRange } from '../src/script-player/domain/model/axis'
import { encodeTCode, encodeTCodeTargets, TCODE_STOP } from '../src/script-player/domain/engine/tcode'
import { ScriptPlayerSession } from '../src/script-player/application/services/script-player-session'
import { ScriptEngine } from '../src/script-player/domain/engine/script-engine'
import { CustomCurveProvider, patternValue } from '../src/script-player/domain/engine/motion-providers'
import { OpenSimplex } from '../src/script-player/domain/engine/noise'
import {
  AxisRangeSchema,
  DEFAULT_AXIS_MOTION,
  DEFAULT_AXIS_RANGES,
  ScriptPlayerSettingsSchema,
  type AxisMotion,
  type ScriptPlayerAxis,
  type ScriptPlayerSettings
} from '../src/script-player/shared/config'
import type { ScriptFile } from '../src/script-player/application/ports/script-files'
import { SettingsSchema } from '../src/shared/schemas/app-config'
import type { OutputTransport } from '../src/script-player/application/ports/output'

function close(actual: number, expected: number, epsilon = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  )
}

// ---------------------------------------------------------------- interpolation

const ramp: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 }]

// Every method has to agree with the script exactly where an action sits.
for (const type of ['linear', 'pchip', 'makima', 'step'] as const) {
  close(interpolateAt(ramp, 1, 1, type), 0)
}
close(interpolateAt(ramp, 1, 2, 'linear'), 1)
close(interpolateAt(ramp, 1, 1.5, 'linear'), 0.5)
close(interpolateAt(ramp, 1, 1.75, 'step'), 0)

// Cubic Hermite with both slopes pinned to zero by the flat neighbours: the
// segment becomes a smoothstep, so the quarter point is 0.15625 rather than 0.25.
close(interpolateAt(ramp, 1, 1.5, 'pchip'), 0.5)
close(interpolateAt(ramp, 1, 1.25, 'pchip'), 0.15625)

// Makima weights the same segment differently and, at the head of a script, uses
// upstream's reflected neighbours. This value pins that whole path down.
close(interpolateAt(ramp, 1, 1.5, 'makima'), 0.5178571428571428, 1e-12)

// Monotone data must not overshoot under pchip.
const steps: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0.2 }, { x: 15, y: 0.9 }, { x: 40, y: 1 }]
for (let x = 10; x <= 15; x += 0.5) {
  const value = interpolateAt(steps, 1, x, 'pchip')
  assert.ok(value >= 0.2 - 1e-12 && value <= 0.9 + 1e-12, `pchip overshot at ${x}: ${value}`)
}

// ---------------------------------------------------------------- sampling

const script: Point[] = [{ x: 1000, y: 0 }, { x: 2000, y: 1 }, { x: 3000, y: 0 }]

assert.deepEqual(
  sampleScript(script, CURSOR_INVALID, 500, 'linear'),
  { index: CURSOR_BEFORE, value: null, insideScript: false }
)
assert.deepEqual(
  sampleScript(script, CURSOR_INVALID, 4000, 'linear'),
  { index: CURSOR_AFTER, value: null, insideScript: false }
)
const middle = sampleScript(script, CURSOR_INVALID, 1500, 'linear')
assert.equal(middle.index, 0)
close(middle.value!, 0.5)
// The cursor steps forward without a fresh search, and back-tracking re-searches.
assert.equal(sampleScript(script, 0, 2500, 'linear').index, 1)
assert.equal(sampleScript(script, 1, 1500, 'linear').index, 0)
assert.equal(sampleScript([], CURSOR_INVALID, 0, 'linear').value, null)

// ---------------------------------------------------------------- settings shape

// A settings.json written before axis motion existed has to keep its outputs and
// pick up the new defaults, rather than resetting the user's devices.
{
  const legacy = ScriptPlayerSettingsSchema.parse({
    syncOffsetMs: -120,
    autoConnectScanDelayMs: 2500,
    autoConnectScanIntervalMs: 5000,
    outputs: [{
      id: '4997f22f-45d6-40df-9316-953a1aa78fca',
      name: 'kept',
      transport: 'serial',
      endpoint: 'COM3'
    }]
  })
  assert.equal(legacy.syncOffsetMs, -120)
  assert.equal(legacy.syncDurationMs, 2500)
  assert.equal(legacy.outputs.length, 1)
  assert.equal(legacy.outputs[0]!.name, 'kept')
  assert.deepEqual(legacy.axes, DEFAULT_AXIS_MOTION)
  assert.equal(legacy.axes.main.interpolation, 'pchip')
  assert.equal(legacy.axes.main.autoHome, true)
  assert.equal(legacy.axes.main.speedLimit, false)
  assert.equal(legacy.axes.main.autoHomeDelayMs, 5000)
  assert.equal(legacy.axes.main.autoHomeDurationMs, 3000)
  assert.equal(legacy.axes.twist.motionProvider, null, 'no axis runs a motion provider by default')
}

// Auto-home timing used to be global. Whatever the user had set becomes every
// axis' own value, without overriding an axis that already has one.
{
  const lifted = ScriptPlayerSettingsSchema.parse({
    autoHomeDelayMs: 1500,
    autoHomeDurationMs: 800,
    axes: { roll: { autoHomeDelayMs: 9000 } }
  })
  assert.equal(lifted.axes.main.autoHomeDelayMs, 1500)
  assert.equal(lifted.axes.pitch.autoHomeDurationMs, 800)
  assert.equal(lifted.axes.roll.autoHomeDelayMs, 9000)
  assert.equal(lifted.axes.roll.autoHomeDurationMs, 800)
  assert.equal('autoHomeDelayMs' in lifted, false)
}

// Every range the slider can produce has to survive the schema. A rejected one
// is not an error the user sees — the save just does nothing and the setting is
// gone after a restart. Whole percents are not exact in binary, so this sweeps
// all 100 of the narrowest ranges rather than spot-checking one.
{
  for (let low = 0; low < 100; low++) {
    const parsed = AxisRangeSchema.safeParse({ min: low / 100, max: (low + 1) / 100, enabled: true })
    assert.ok(parsed.success, `a one percent range at ${low}% must be storable`)
  }
  assert.equal(AxisRangeSchema.safeParse({ min: 0.5, max: 0.5, enabled: true }).success, false)
  assert.equal(AxisRangeSchema.safeParse({ min: 0.5, max: 0.504, enabled: true }).success, false)
}

// ---------------------------------------------------------------- axis pipeline

function motion(overrides: Partial<AxisMotion> = {}): AxisMotion {
  return { ...DEFAULT_AXIS_MOTION.main, ...overrides }
}

function input(overrides: Partial<AxisPipelineInput> = {}): AxisPipelineInput {
  const merged = {
    scriptValue: Number.NaN,
    motionValue: Number.NaN,
    insideScript: false,
    playing: false,
    deltaMs: 10,
    motion: motion(),
    syncDurationMs: 2500,
    followedSpeed: Number.NaN,
    smartLimitInput: Number.NaN,
    ...overrides
  }
  // The engine hands the pipeline a script value already shaped by the axis.
  return Number.isFinite(merged.scriptValue)
    ? { ...merged, scriptValue: shapeScriptValue(merged.scriptValue, merged.motion) }
    : merged
}

close(syncProgress(1000, 1000), 2 ** -10)
close(syncProgress(0, 1000), 1)

// Sync: the first tick after a reset stays put, and the axis is fully on script
// once the ease-in has run its course.
{
  const state = createAxisPipelineState(CURSOR_INVALID)
  stepAxis(state, input({ scriptValue: 0, insideScript: true, playing: true }))
  close(state.value, 0)

  resetSync(state, 1000)
  const first = stepAxis(state, input({
    scriptValue: 1, insideScript: true, playing: true, deltaMs: 0, syncDurationMs: 1000
  }))
  close(first, 2 ** -10)

  for (let elapsed = 0; elapsed < 1000; elapsed += 50) {
    stepAxis(state, input({
      scriptValue: 1, insideScript: true, playing: true, deltaMs: 50, syncDurationMs: 1000
    }))
  }
  assert.equal(state.syncTimeMs, 0)
  // The ease is asymptotic inside the window; the tick after it closes is the
  // one that lands exactly on the script.
  close(stepAxis(state, input({
    scriptValue: 1, insideScript: true, playing: true, deltaMs: 50, syncDurationMs: 1000
  })), 1)
}

// A playing script keeps auto-home away; pausing lets it take the axis home.
{
  const state = createAxisPipelineState(CURSOR_INVALID)
  for (let step = 0; step < 5; step++) {
    stepAxis(state, input({ scriptValue: 1, insideScript: true, playing: true, syncDurationMs: 0 }))
  }
  close(state.value, 1)
  assert.equal(state.autoHoming, false)

  let elapsed = 0
  while (elapsed < 4000) {
    stepAxis(state, input({ scriptValue: 1, insideScript: true, deltaMs: 50, syncDurationMs: 0 }))
    elapsed += 50
  }
  // Still inside the delay window.
  assert.equal(state.autoHoming, false)
  close(state.value, 1)

  while (elapsed < 9000) {
    stepAxis(state, input({ scriptValue: 1, insideScript: true, deltaMs: 50, syncDurationMs: 0 }))
    elapsed += 50
  }
  assert.equal(state.autoHoming, true)
  close(state.value, 0.5)
}

// Auto-home off leaves the axis where the script abandoned it.
{
  const state = createAxisPipelineState(CURSOR_INVALID)
  const held = motion({ autoHome: false })
  stepAxis(state, input({ scriptValue: 0.8, insideScript: true, playing: true, motion: held, syncDurationMs: 0 }))
  for (let elapsed = 0; elapsed < 20_000; elapsed += 100) {
    stepAxis(state, input({ deltaMs: 100, motion: held, syncDurationMs: 0 }))
  }
  close(state.value, 0.8)
}

// Speed limit: a full-travel jump is served one slice per tick.
{
  const state = createAxisPipelineState(CURSOR_INVALID)
  const limited = motion({ speedLimit: true, speedLimitPerSecond: 1 })
  stepAxis(state, input({ scriptValue: 0, insideScript: true, playing: true, motion: limited, syncDurationMs: 0 }))
  const next = stepAxis(state, input({
    scriptValue: 1, insideScript: true, playing: true, motion: limited, deltaMs: 100, syncDurationMs: 0
  }))
  close(next, 0.1)
}

// Stroke scale pulls the script in towards the centre, symmetrically.
{
  const state = createAxisPipelineState(CURSOR_INVALID)
  const scaled = motion({ scriptScale: 0.5 })
  close(stepAxis(state, input({
    scriptValue: 1, insideScript: true, playing: true, motion: scaled, syncDurationMs: 0
  })), 0.75)
  close(stepAxis(state, input({
    scriptValue: 0, insideScript: true, playing: true, motion: scaled, syncDurationMs: 0
  })), 0.25)
}

// ---------------------------------------------------------------- encoding

close(applyAxisRange(0.25, { min: 0.2, max: 0.8, enabled: true }), 0.35, 1e-12)

assert.equal(encodeTCode({ main: 0.5, roll: 0.1 }, 50), 'L05000I50 R11000I50\n')
assert.equal(encodeTCode({ pitch: 2, surge: -1 }, 33.6), 'R29999I34 L10000I34\n')
assert.equal(encodeTCode({ main: 0.5 }, null, 3), 'L0500\n')
// Upstream's floor(ms + 0.75): a sub-millisecond interval must not become I0.
assert.equal(encodeTCode({ main: 1 }, 0.3), 'L09999I1\n')
assert.equal(encodeTCode({}, 50), '')

assert.equal(
  encodeTCodeTargets({ main: { value: 0.5, durationMs: 250 }, roll: { value: 0, durationMs: 80 } }, false),
  'L05000I250 R10000I80\n'
)
assert.equal(encodeTCodeTargets({ main: { value: 1, durationMs: 250 } }, true, 3), 'L0999\n')
assert.equal(encodeTCodeTargets({}, false), '')
assert.equal(TCODE_STOP, 'DSTOP\n')

// ---------------------------------------------------------------- session

class FakeTransport implements OutputTransport {
  readonly sent: string[] = []
  connected = false
  setEvents(): void {}
  async connect(): Promise<void> { this.connected = true }
  async send(payload: string): Promise<void> { this.sent.push(payload) }
  async disconnect(): Promise<void> { this.connected = false }
}

function scriptFile(actions: { at: number; pos: number }[], name = 'test.funscript'): ScriptFile {
  return {
    path: `C:/scripts/${name}`,
    name,
    script: { actions, durationMs: actions[actions.length - 1]!.at }
  }
}

function withAxis(axis: ScriptPlayerAxis, patch: Partial<AxisMotion>): ScriptPlayerSettings['axes'] {
  return { ...DEFAULT_AXIS_MOTION, [axis]: { ...DEFAULT_AXIS_MOTION[axis], ...patch } }
}

const OUTPUT_ID = '4997f22f-45d6-40df-9316-953a1aa78fca'
const MEDIA_ID = '7e66db32-5f4c-4d86-a1b2-90665657b29b'
const VERSION_ID = '5901f56c-1a65-45c1-8f78-8d7acf58e760'

const fake = new FakeTransport()
const session = new ScriptPlayerSession(() => fake)
let paused = false
session.setClock({
  sample: () => ({ mediaId: MEDIA_ID, scriptVersionId: VERSION_ID, positionMs: 0, paused })
})

const settings: ScriptPlayerSettings = {
  syncOffsetMs: 0,
  autoConnectScanDelayMs: 2500,
  autoConnectScanIntervalMs: 5000,
  // Ease-in is covered above; a session run has to be deterministic.
  syncDurationMs: 0,
  axes: DEFAULT_AXIS_MOTION,
  outputs: [{
    id: OUTPUT_ID,
    name: 'fake',
    transport: 'tcp',
    protocol: 'v0.3',
    endpoint: '127.0.0.1',
    port: 8000,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    dtr: true,
    rts: true,
    connectionKey: '',
    sourceAxis: 'main',
    autoConnect: false,
    updateMode: 'fixed',
    updateIntervalMs: 20,
    sendDirtyValuesOnly: true,
    offloadElapsedTime: false,
    ranges: DEFAULT_AXIS_RANGES
  }]
}
session.configure(settings)
session.load(MEDIA_ID, VERSION_ID, {
  main: scriptFile([{ at: 0, pos: 0 }, { at: 100, pos: 100 }])
})
await session.connect(OUTPUT_ID)
await new Promise((resolve) => setTimeout(resolve, 45))
assert.ok(fake.sent.some((payload) => payload.startsWith('L0')), 'playing sends a stroke value')

paused = true
await new Promise((resolve) => setTimeout(resolve, 40))
// Pausing hands the axis to auto-home instead of cutting the device off; DSTOP
// is reserved for disconnecting, clearing and quitting.
assert.ok(!fake.sent.includes(TCODE_STOP), 'pause must not stop the device')
assert.equal(session.status().phase, 'paused')

session.previewRanges(OUTPUT_ID, {
  ...DEFAULT_AXIS_RANGES,
  main: { ...DEFAULT_AXIS_RANGES.main, min: 0.64 }
})
await Promise.resolve()
assert.ok(fake.sent.some((payload) => payload.startsWith('L06399I')), 'range preview remaps while paused')

// Auto-home end to end: paused, the axis walks to centre and then stops
// reporting itself as homing, so the fast tick can stand down again.
session.configure({ ...settings, axes: withAxis('main', { autoHomeDelayMs: 0, autoHomeDurationMs: 60 }) })
await new Promise((resolve) => setTimeout(resolve, 250))
close(session.status().axes.main!, 0.5, 0.001)
assert.equal(session.status().homing, false, 'a parked axis is not still homing')

// Closing a video is not a reason to cut the device off: the axes walk home and
// hold there. Only disconnecting and quitting stop it.
session.clear()
await new Promise((resolve) => setTimeout(resolve, 30))
assert.ok(!fake.sent.includes(TCODE_STOP), 'clearing the script must not stop the device')

await session.disconnect(OUTPUT_ID)
assert.ok(fake.sent.includes(TCODE_STOP), 'disconnect stops the device')
await session.dispose()
assert.equal(fake.connected, false)

// ------------------------------------------------- connected, nothing playing

// The state the user configures in: a device connected with no script anywhere.
// Every enabled axis still has to be driven, or its range slider does nothing
// and the machine sits whereever it was last left.
{
  const idle = new FakeTransport()
  const session = new ScriptPlayerSession(() => idle)
  session.configure(settings)
  await session.connect(OUTPUT_ID)
  await new Promise((resolve) => setTimeout(resolve, 60))

  assert.equal(session.status().phase, 'idle')
  const first = idle.sent[0]
  assert.ok(first, 'a connected output is driven with no script loaded')
  // Centre of a full 0–100 range, on every axis the device has.
  for (const channel of ['L0', 'L1', 'L2', 'R0', 'R1', 'R2']) {
    assert.ok(first!.includes(`${channel}5000`), `${channel} rests at centre: ${first}`)
  }

  // Steady state is quiet: nothing moved, so nothing is resent.
  const settled = idle.sent.length
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(idle.sent.length, settled, 'an idle axis is not resent every tick')

  // Narrowing the range moves the machine right away, with nothing playing.
  session.previewRanges(OUTPUT_ID, {
    ...DEFAULT_AXIS_RANGES,
    main: { ...DEFAULT_AXIS_RANGES.main, min: 0.6 }
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  // Centre of 60–100 is 80%.
  assert.ok(
    idle.sent.some((payload) => payload.includes('L07999')),
    `range change reaches the device while idle: ${idle.sent.join(' | ')}`
  )

  await session.dispose()
}

// ------------------------------------------------- the cable comes out

// The plug is pulled mid-script and put back. The device stops where it was,
// the script does not, and on the way back the device must be walked to a known
// position and eased in from there rather than dropped into the live stroke.
{
  class Droppable implements OutputTransport {
    readonly sent: string[] = []
    live = true
    setEvents(): void {}
    async connect(): Promise<void> {}
    async send(payload: string): Promise<void> {
      // What Windows says when the port being written to has gone away.
      if (!this.live) throw new Error('Writing to COM3 (Access is denied.)')
      this.sent.push(payload)
    }
    async disconnect(): Promise<void> {}
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** The last value this port was told to put the stroke axis at. */
  const strokeValue = (port: Droppable): number => {
    for (let index = port.sent.length - 1; index >= 0; index--) {
      const command = port.sent[index]!.trim().split(' ').find((part) => part.startsWith('L0'))
      if (command) return Number(command.slice(2, 6)) / 9999
    }
    return Number.NaN
  }

  const ports: Droppable[] = []
  const session = new ScriptPlayerSession(() => {
    const port = new Droppable()
    ports.push(port)
    return port
  })
  let positionMs = 1000
  session.setClock({
    sample: () => ({ mediaId: MEDIA_ID, scriptVersionId: VERSION_ID, positionMs, paused: false })
  })
  // Linear, so the position the clock reports is the position on the axis.
  session.configure({
    ...settings,
    syncDurationMs: 400,
    axes: withAxis('main', { interpolation: 'linear' })
  })
  session.load(MEDIA_ID, VERSION_ID, {
    main: scriptFile([{ at: 0, pos: 0 }, { at: 10_000, pos: 100 }])
  })

  await session.connect(OUTPUT_ID)
  await wait(20)
  const first = ports[0]!
  // Even a first connect opens with one slow move to a known position: where
  // the device is standing is unknown, and a streamed command gives it 20ms.
  assert.ok(first.sent[0]?.includes('L05000I1000'), `connect settles to centre: ${first.sent[0]}`)
  await wait(1500)
  close(strokeValue(first), 0.1, 0.01)

  // The plug comes out, and the next stroke is the one that finds out.
  first.live = false
  positionMs = 1200
  await wait(60)
  const dropped = session.status().outputs[0]!
  assert.equal(dropped.state, 'error', 'a failed send drops the output')
  assert.equal(dropped.retrying, false, 'an output without auto-connect is not reconnected on its own')

  // The script runs on without the device for eight seconds of stroke.
  positionMs = 9000
  await wait(500)
  close(session.status().axes.main!, 0.9, 0.01)

  await session.connect(OUTPUT_ID)
  await wait(20)
  const second = ports[1]!
  assert.equal(second.sent.length, 1, 'a reconnect says one thing first')
  assert.ok(
    second.sent[0]?.includes('L01000I1000'),
    `reconnect walks back to where the device was left: ${second.sent[0]}`
  )
  await wait(300)
  assert.equal(second.sent.length, 1, 'nothing is streamed while the device is still travelling')

  await wait(800)
  assert.ok(session.status().syncing, 'the panel says the output is easing in')
  const resumed = strokeValue(second)
  assert.ok(resumed > 0.05 && resumed < 0.3, `eases in from the device, not the script: ${resumed}`)

  await wait(700)
  close(strokeValue(second), 0.9, 0.01)
  assert.equal(session.status().syncing, false, 'the ease-in ends')

  await session.dispose()
}

// ------------------------------------------------- script route

// Fresh install: the built-in player has the script, and MFP is not involved.
assert.equal(SettingsSchema.parse({}).playback.scriptRoute, 'internal')

// UI choices added after the first settings.json release pick up defaults
// without dropping older UI preferences, then round-trip once the user picks.
{
  const legacy = SettingsSchema.parse({ ui: { mediaView: 'list' } })
  assert.equal(legacy.ui.mediaView, 'list')
  assert.equal(legacy.ui.mediaLibraryId, '')
  assert.equal(legacy.ui.mediaSort, 'path')
  assert.equal(legacy.ui.postDownloadLibraryId, '')

  const remembered = SettingsSchema.parse({
    ui: {
      mediaLibraryId: '4997f22f-45d6-40df-9316-953a1aa78fca',
      mediaSort: 'rating',
      postDownloadLibraryId: 'f5ab36dc-9029-477d-a6b5-20e41039384b'
    }
  })
  assert.equal(remembered.ui.mediaLibraryId, '4997f22f-45d6-40df-9316-953a1aa78fca')
  assert.equal(remembered.ui.mediaSort, 'rating')
  assert.equal(remembered.ui.postDownloadLibraryId, 'f5ab36dc-9029-477d-a6b5-20e41039384b')
}

// The old config carried an unused `defaultRoute` that defaulted to 'mfp'.
// Everyone lands on the built-in player regardless — before this release both
// players ran at once, so there is no previous choice to preserve. What must
// survive is the MFP path itself, or switching back means finding the exe again.
{
  const migrated = SettingsSchema.parse({
    playback: { defaultRoute: 'mfp', mfpExePath: 'D:/portable/MultiFunPlayer.exe' }
  })
  assert.equal(migrated.playback.scriptRoute, 'internal')
  assert.equal(migrated.playback.mfpExePath, 'D:/portable/MultiFunPlayer.exe')
}

// Standing down for MFP has to mean actually letting go of the hardware: a
// serial port is held by one process, so a player that merely stopped sending
// would still lock MFP out of the device.
{
  const held = new FakeTransport()
  const session = new ScriptPlayerSession(() => held)
  session.setClock({
    sample: () => ({ mediaId: MEDIA_ID, scriptVersionId: VERSION_ID, positionMs: 0, paused: false })
  })
  session.configure({ ...settings, outputs: [{ ...settings.outputs[0]!, autoConnect: true }] })
  await session.connect(OUTPUT_ID)
  assert.equal(session.status().outputs[0]!.state, 'connected')

  session.setEnabled(false)
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(session.status().enabled, false)
  assert.equal(session.status().outputs[0]!.state, 'disconnected')
  assert.equal(held.connected, false, 'the transport is closed, not just idled')
  assert.ok(held.sent.includes(TCODE_STOP), 'the device is stopped on the way out')

  // Nothing may pull it back up while MFP has the script — not a play, and not
  // the auto-connect scanner, which is why that output has autoConnect on.
  session.load(MEDIA_ID, VERSION_ID, { main: scriptFile([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]) })
  await session.connect(OUTPUT_ID)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(session.status().outputs[0]!.state, 'disconnected')
  assert.equal(session.status().phase, 'idle', 'no script is held while standing down')

  // Switching back in settings makes it usable again.
  session.setEnabled(true)
  await session.connect(OUTPUT_ID)
  assert.equal(session.status().enabled, true)
  assert.equal(session.status().outputs[0]!.state, 'connected')

  await session.dispose()
}

// ------------------------------------------------- per-axis shaping

close(shapeScriptValue(0.2, motion({ invert: true })), 0.8)
// Scale first, then invert: 0.5 + (0.2 - 0.5) * 0.5 = 0.35, inverted 0.65.
close(shapeScriptValue(0.2, motion({ invert: true, scriptScale: 0.5 })), 0.65)

function engineSettings(axes: ScriptPlayerSettings['axes']): ScriptPlayerSettings {
  return { ...settings, syncDurationMs: 0, axes, outputs: [] }
}

function parsed(actions: { at: number; pos: number }[]): ScriptFile['script'] {
  return { actions, durationMs: actions[actions.length - 1]!.at }
}

// Offset moves one axis' script in time without touching the others.
{
  const engine = new ScriptEngine()
  const ramp = parsed([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }])
  engine.load({ main: ramp, roll: ramp })
  const axes = {
    ...withAxis('main', { interpolation: 'linear', offsetMs: 250 }),
    roll: { ...DEFAULT_AXIS_MOTION.roll, interpolation: 'linear' as const }
  }
  const updates = engine.update({ positionMs: 500, playing: true, deltaMs: 10, settings: engineSettings(axes) })
  close(updates.main!.value, 0.75)
  close(updates.roll!.value, 0.5)
}

// Bypass keeps the script loaded but out of the axis.
{
  const engine = new ScriptEngine()
  engine.load({ main: parsed([{ at: 0, pos: 0 }, { at: 1000, pos: 100 }]) })
  const bypassed = engineSettings(withAxis('main', { bypassScript: true }))
  const updates = engine.update({ positionMs: 500, playing: true, deltaMs: 10, settings: bypassed })
  assert.equal(Number.isNaN(updates.main!.value), true, 'a bypassed script does not drive its axis')
  assert.deepEqual(engine.axes(), ['main'])
}

// ------------------------------------------------- motion providers

// Noise has to be the same function, not merely noise-like: a seed, a sample
// point and the octave settings pin every stage of it. The expected values are
// what the original C# prints for the same inputs.
{
  const expected: [bigint, number[]][] = [
    [12345n, [0, -0.210835331250639, -0.7118509374717094, 0.7798242004755125, -0.23357593020804407, -0.01081970423470448, -0.2703394250263737, -0.5763761421383103, -0.11668511993674849, -0.02468584663058426, -0.08822086729740929]],
    [-987654321n, [0, -0.26248908914440755, -0.0035563000738243547, -0.4816034359308693, -0.10711028450967579, -0.0014244422950863704, -0.24651076071227598, -0.5678319182159086, -0.11044075847839734, -0.23133685814069402, -0.42494649197797524]],
    [4611686018427387903n, [0, -0.2619688463151409, 0.0010015366271531245, -0.25079063188433304, 0.291283435524581, -0.008657933373958258, -0.28537996297755636, 0.3469678893919996, -0.19118285945531763, 0.23055871606537048, -0.4051867281235703]]
  ]
  for (const [seed, values] of expected) {
    const noise = new OpenSimplex(seed)
    const actual = [
      ...[0, 0.07, 0.31, 1.5, 2.25, 17.9, 123.456, -3.3].map((t) => noise.calculate2D(t, t)),
      ...[0.5, 4.2, 33.3].map((t) => noise.calculate2DOctaves(t, t, 3, 0.6, 1.8))
    ]
    for (const [index, value] of values.entries()) close(actual[index]!, value, 1e-12)
  }
}

// The six patterns over one period, at the quarter points.
close(patternValue('triangle', 0), 0.5)
close(patternValue('triangle', 1), 0)
close(patternValue('triangle', 3), 1)
close(patternValue('sine', 1), 0)
close(patternValue('sine', 3), 1)
close(patternValue('saw', 2), 0.5)
assert.equal(patternValue('square', 1), 1)
assert.equal(patternValue('square', 3), 0)

// A pattern on an axis with no script: it only runs when told to run without
// one, and then it plays at its own speed inside its own range.
{
  const engine = new ScriptEngine()
  const pattern = (patch: Partial<AxisMotion>): ScriptPlayerSettings => engineSettings(withAxis('twist', {
    motionProvider: 'pattern',
    autoHome: false,
    providers: {
      ...DEFAULT_AXIS_MOTION.twist.providers,
      pattern: { ...DEFAULT_AXIS_MOTION.twist.providers.pattern, minimum: 0.2, maximum: 0.6 }
    },
    ...patch
  }))

  let updates = engine.update({ positionMs: 0, playing: true, deltaMs: 1000, settings: pattern({}) })
  assert.equal(updates.twist, undefined, 'without "no script" the provider waits for a script')

  const values: number[] = []
  for (let tick = 0; tick < 4; tick++) {
    updates = engine.update({ positionMs: 0, playing: true, deltaMs: 1000, settings: pattern({ updateWithoutScript: true }) })
    values.push(updates.twist!.value)
  }
  // Triangle at 0, 1, 2, 3 seconds: 0.5, 0, 0.5, 1 — mapped into 0.2..0.6.
  for (const [index, expected] of [0.4, 0.2, 0.4, 0.6].entries()) close(values[index]!, expected)

  // Paused, it holds its last value rather than carrying on.
  updates = engine.update({ positionMs: 0, playing: false, deltaMs: 1000, settings: pattern({ updateWithoutScript: true }) })
  close(updates.twist!.value, 0.6)
}

// Following another axis: the provider runs only while that axis moves.
{
  const engine = new ScriptEngine()
  engine.load({ main: parsed([{ at: 0, pos: 0 }, { at: 10_000, pos: 100 }, { at: 20_000, pos: 100 }]) })
  const follow = engineSettings({
    ...withAxis('twist', { motionProvider: 'pattern', updateWithoutScript: true, updateWithAxis: 'main', matchAxisSpeed: false, autoHome: false }),
    main: { ...DEFAULT_AXIS_MOTION.main, interpolation: 'linear', autoHome: false }
  })
  engine.update({ positionMs: 0, playing: true, deltaMs: 10, settings: follow })
  let updates = engine.update({ positionMs: 1000, playing: true, deltaMs: 10, settings: follow })
  assert.ok(Number.isFinite(updates.twist!.value), 'moving main lets the provider run')
  // Main is flat from 10s on; one tick later it is no longer dirty.
  engine.update({ positionMs: 15_000, playing: true, deltaMs: 10, settings: follow })
  engine.update({ positionMs: 15_010, playing: true, deltaMs: 10, settings: follow })
  const held = engine.update({ positionMs: 15_020, playing: true, deltaMs: 10, settings: follow }).twist!.value
  updates = engine.update({ positionMs: 15_030, playing: true, deltaMs: 10, settings: follow })
  close(updates.twist!.value, held, 0)
}

// Blend mixes script and provider inside the script; gap fill hands a long flat
// stretch to the provider entirely.
{
  const engine = new ScriptEngine()
  engine.load({ main: parsed([{ at: 0, pos: 0 }, { at: 1000, pos: 0 }, { at: 1100, pos: 100 }, { at: 20_000, pos: 100 }, { at: 20_100, pos: 0 }]) })
  const base = {
    interpolation: 'linear' as const,
    motionProvider: 'pattern' as const,
    autoHome: false,
    motionBlend: 0.25,
    providers: {
      ...DEFAULT_AXIS_MOTION.main.providers,
      pattern: { ...DEFAULT_AXIS_MOTION.main.providers.pattern, pattern: 'square' as const, speed: 0.01 }
    }
  }
  // Square starts high: the provider says 1 throughout.
  let updates = engine.update({ positionMs: 500, playing: true, deltaMs: 10, settings: engineSettings(withAxis('main', base)) })
  close(updates.main!.value, 0.25, 1e-9)

  // 1100..20000 is flat for 18.9s; with a 5s minimum the provider takes it over,
  // but the first second (0..1000, also flat) is too short to count.
  const filled = engineSettings(withAxis('main', { ...base, fillGaps: true, minGapMs: 5000, providers: {
    ...base.providers, pattern: { ...base.providers.pattern, pattern: 'square' as const, maximum: 0.5 }
  } }))
  engine.invalidateCursors()
  updates = engine.update({ positionMs: 10_000, playing: true, deltaMs: 10, settings: filled })
  close(updates.main!.value, 0.5)
  engine.invalidateCursors()
  updates = engine.update({ positionMs: 500, playing: true, deltaMs: 10, settings: filled })
  close(updates.main!.value, 0.125, 1e-9)
}

// Smart limit: roll is pulled towards its target by how far main has travelled.
{
  const engine = new ScriptEngine()
  engine.load({
    main: parsed([{ at: 0, pos: 100 }, { at: 1000, pos: 100 }]),
    roll: parsed([{ at: 0, pos: 0 }, { at: 1000, pos: 0 }])
  })
  const limited = engineSettings({
    ...withAxis('roll', { smartLimitAxis: 'main', smartLimitTarget: 0.5, autoHome: false }),
    main: { ...DEFAULT_AXIS_MOTION.main, autoHome: false }
  })
  let updates = engine.update({ positionMs: 100, playing: true, deltaMs: 10, settings: limited })
  // Main has no value yet on the first tick, so roll passes untouched.
  close(updates.roll!.value, 0)
  updates = engine.update({ positionMs: 110, playing: true, deltaMs: 10, settings: limited })
  // Main sits at 100%: past the curve's 90% point, factor 0, all the way to target.
  close(updates.roll!.value, 0.5)
  assert.equal(engine.activity().roll.smartLimited, true)
}

// A looping custom curve wraps smoothly: the stretch after the last point
// continues towards the first one again.
{
  const curve = new CustomCurveProvider()
  const settingsFor = { ...DEFAULT_AXIS_MOTION.main.providers.customCurve, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], durationS: 2 }
  const seen: number[] = []
  for (let tick = 0; tick < 8; tick++) {
    curve.update(0.25, settingsFor)
    seen.push(curve.value)
  }
  for (const [index, expected] of [0, 0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25].entries()) close(seen[index]!, expected)

  // Without looping it plays once, asks to be eased back in, and goes quiet.
  const once = new CustomCurveProvider()
  const single = { ...settingsFor, loop: false }
  let asked = false
  for (let tick = 0; tick < 9; tick++) asked = once.update(0.25, single) || asked
  assert.equal(asked, true)
  assert.equal(Number.isNaN(once.value), true)
}

// ------------------------------------------------- which script each axis plays

{
  const session = new ScriptPlayerSession(() => new FakeTransport())
  const linked = { ...settings, axes: withAxis('twist', { linkAxis: 'main' }), outputs: [] }
  session.configure(linked)
  const firstMain = scriptFile([{ at: 0, pos: 0 }, { at: 100, pos: 100 }], 'first.funscript')
  session.load(MEDIA_ID, VERSION_ID, { main: firstMain })
  let scripts = session.status().scripts
  assert.equal(scripts.twist.name, 'first.funscript', 'twist borrows main when it has no script')
  assert.equal(scripts.twist.linkedFrom, 'main')

  // Its own script wins, until the link is given priority.
  const ownTwist = scriptFile([{ at: 0, pos: 50 }, { at: 100, pos: 60 }], 'twist.funscript')
  session.load(MEDIA_ID, VERSION_ID, { main: firstMain, twist: ownTwist })
  assert.equal(session.status().scripts.twist.name, 'twist.funscript')
  session.configure({ ...linked, axes: withAxis('twist', { linkAxis: 'main', linkPriority: true }) })
  assert.equal(session.status().scripts.twist.linkedFrom, 'main')
  session.configure(linked)
  assert.equal(session.status().scripts.twist.name, 'twist.funscript')

  // A file loaded by hand plays until reload puts the library's pick back, and
  // links follow it.
  session.loadAxisScript('main', scriptFile([{ at: 0, pos: 10 }, { at: 100, pos: 90 }], 'hand.funscript'))
  scripts = session.status().scripts
  assert.equal(scripts.main.name, 'hand.funscript')
  assert.equal(scripts.main.manual, true)
  session.reloadAxisScript('main')
  scripts = session.status().scripts
  assert.equal(scripts.main.name, 'first.funscript')
  assert.equal(scripts.main.manual, false)

  // Cleared by hand: empty until the next media, which starts from its own pick.
  session.clearAxisScript('main')
  assert.equal(session.status().scripts.main.name, null)
  const nextMain = scriptFile([{ at: 0, pos: 0 }, { at: 100, pos: 100 }], 'next.funscript')
  session.load(MEDIA_ID, VERSION_ID, { main: nextMain })
  assert.equal(session.status().scripts.main.name, 'next.funscript')

  // Locked, the axis keeps its script through a media change and ignores a clear.
  session.setAxisLocked('main', true)
  session.load(MEDIA_ID, VERSION_ID, { main: firstMain })
  assert.equal(session.status().scripts.main.name, 'next.funscript')
  session.clearAxisScript('main')
  assert.equal(session.status().scripts.main.name, 'next.funscript')
  session.clear()
  assert.equal(session.status().scripts.main.name, 'next.funscript')
  session.setAxisLocked('main', false)
  session.clear()
  assert.equal(session.status().scripts.main.name, null)

  // A link that leads back to itself is treated as no link.
  session.configure({ ...settings, outputs: [], axes: {
    ...withAxis('twist', { linkAxis: 'roll' }),
    roll: { ...DEFAULT_AXIS_MOTION.roll, linkAxis: 'twist' }
  } })
  session.load(MEDIA_ID, VERSION_ID, { main: firstMain })
  assert.equal(session.status().scripts.twist.name, null)
  assert.equal(session.status().scripts.roll.name, null)

  await session.dispose()
}

console.log('script-player protocol checks passed')
