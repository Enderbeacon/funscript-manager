import { EventEmitter } from 'node:events'
import { ScriptEngine, type AxisActivity, type AxisUpdate } from '../../domain/engine/script-engine'
import { encodeTCode, encodeTCodeTargets, TCODE_STOP } from '../../domain/engine/tcode'
import { syncProgress } from '../../domain/engine/axis-pipeline'
import { applyAxisRange } from '../../domain/model/axis'
import type { PlaybackClockPort } from '../ports/playback-clock'
import type { OutputConnectionState, OutputTransport } from '../ports/output'
import type { ScriptFile, ScriptFilesPort } from '../ports/script-files'
import type { AxisMotion, AxisRange, ScriptPlayerAxis, ScriptPlayerSettings, TCodeOutputProfile } from '../../shared/config'
import { AXIS_CENTRE, DEFAULT_AXIS_MOTION, SCRIPT_PLAYER_AXES } from '../../shared/config'

export interface OutputRuntimeStatus {
  id: string
  name: string
  state: OutputConnectionState
  error: 'connect_failed' | 'send_failed' | 'connection_lost' | null
  sentMessages: number
  receivedMessages: number
  lastSentAt: number | null
  lastReceivedAt: number | null
  lastResponse: string | null
  updateRate: number
  /** The output dropped and is being connected again on its own. */
  retrying: boolean
}

export interface ScriptPlayerStatus {
  /**
   * False when the script route points at MultiFunPlayer instead. Everything
   * here is then standing down, and the panel says so rather than offering
   * controls that would fight MFP for the same port.
   */
  enabled: boolean
  phase: 'idle' | 'ready' | 'playing' | 'paused'
  mediaId: string | null
  scriptVersionId: string | null
  positionMs: number | null
  axes: Partial<Record<ScriptPlayerAxis, number>>
  /** An axis is still easing in towards the script. */
  syncing: boolean
  /** An axis is on its way back to centre. */
  homing: boolean
  scripts: Record<ScriptPlayerAxis, AxisScriptStatus>
  activity: Record<ScriptPlayerAxis, AxisActivity>
  outputs: OutputRuntimeStatus[]
}

export interface AxisScriptStatus {
  name: string | null
  path: string | null
  /** The script is borrowed from this axis. */
  linkedFrom: ScriptPlayerAxis | null
  /** Loaded, cleared or reloaded by hand rather than picked from the library. */
  manual: boolean
  locked: boolean
}

/**
 * What one axis is playing.
 *
 * `base` is what the library picked for the current media; `current` is what
 * actually plays. They part ways when the user loads, clears or links a script
 * in the panel. None of that is written anywhere: the next media starts from
 * its own library pick again, unless the axis is locked.
 *
 * The link, lock and reload rules are derived; origin and licence in
 * THIRD_PARTY_NOTICES.md.
 */
interface AxisSlot {
  base: ScriptFile | null
  current: ScriptFile | null
  linkedFrom: ScriptPlayerAxis | null
  manual: boolean
  locked: boolean
}

/** Changing any of these moves the axis somewhere new, so it is eased in again. */
const SYNC_ON_CHANGE: readonly (keyof AxisMotion)[] = [
  'invert',
  'scriptScale',
  'offsetMs',
  'bypassScript',
  'bypassMotion',
  'updateWhenPaused',
  'updateWithoutScript',
  'fillGaps',
  'autoHome',
  'autoHomeTarget',
  'smartLimitAxis',
  'updateWithAxis',
  'motionProvider'
]

/** Provider settings minus the curve's points, which are dragged continuously. */
function providerSettingsKey(motion: AxisMotion): string {
  const { points: _points, ...curve } = motion.providers.customCurve
  return JSON.stringify({ ...motion.providers, customCurve: curve })
}

interface PendingCommand {
  payload: string
  values: Partial<Record<ScriptPlayerAxis, number>>
}

/**
 * An output on its way back into the script after a connect.
 *
 * `from` is where this output last put the device. The device is either still
 * standing there, or — if it lost power while unplugged — at whatever position
 * it homes itself to, and there is no way to ask it which. So it is first sent
 * `from` with a long travel time and left alone to cover the distance at its
 * own pace, and only then eased the rest of the way to the live script.
 */
interface OutputResume {
  from: Partial<Record<ScriptPlayerAxis, number>>
  /** Time left for the device to reach `from`; nothing is sent until it does. */
  settleMs: number
  /** Time left easing from `from` into the live script. */
  easeMs: number
  durationMs: number
  sent: boolean
}

interface RuntimeOutput {
  profile: TCodeOutputProfile
  transport: OutputTransport | null
  state: OutputConnectionState
  error: OutputRuntimeStatus['error']
  lastTickAt: number
  lastSentAt: number | null
  sending: boolean
  pending: PendingCommand | null
  lastSentValues: Partial<Record<ScriptPlayerAxis, number>>
  sentMessages: number
  receivedMessages: number
  lastReceivedAt: number | null
  lastResponse: string | null
  sendTimes: number[]
  polledSynced: boolean
  resume: OutputResume | null
  generation: number
}

const DEFAULT_SETTINGS: ScriptPlayerSettings = {
  syncOffsetMs: 0,
  autoConnectScanDelayMs: 2500,
  autoConnectScanIntervalMs: 5000,
  syncDurationMs: 2500,
  axes: DEFAULT_AXIS_MOTION,
  outputs: []
}

/** Tick period while anything is moving, and while nothing is. */
const ACTIVE_TICK_MS = 3
const IDLE_TICK_MS = 10

/** How long a freshly connected device is given to reach the position it was left at. */
const RESUME_SETTLE_MS = 1000

export class ScriptPlayerSession extends EventEmitter {
  private readonly engine = new ScriptEngine()
  private settings: ScriptPlayerSettings = DEFAULT_SETTINGS
  private outputs = new Map<string, RuntimeOutput>()
  private clock: PlaybackClockPort = {
    sample: () => ({ mediaId: null, scriptVersionId: null, positionMs: null, paused: null })
  }
  private mediaId: string | null = null
  private scriptVersionId: string | null = null
  private axes: Partial<Record<ScriptPlayerAxis, number>> = {}
  private syncing = false
  private homing = false
  private enabled = true
  private timer: NodeJS.Timeout | null = null
  private autoConnectDelay: NodeJS.Timeout | null = null
  private autoConnectTimer: NodeJS.Timeout | null = null
  private lastTickAt = 0
  private lastPlaying = false
  private lastMatched = false
  private lastPosition: number | null = null
  private lastBroadcastAt = 0
  private readonly slots = new Map<ScriptPlayerAxis, AxisSlot>(SCRIPT_PLAYER_AXES.map((axis) => [
    axis,
    { base: null, current: null, linkedFrom: null, manual: false, locked: false }
  ]))
  /** Which looping-script file each axis has asked for, so a slow read cannot land late. */
  private readonly loopingScriptPaths = new Map<ScriptPlayerAxis, string>()

  constructor(
    private readonly makeTransport: (profile: TCodeOutputProfile) => OutputTransport,
    private readonly scriptFiles: ScriptFilesPort = { read: async () => null }
  ) {
    super()
  }

  setClock(clock: PlaybackClockPort): void {
    this.clock = clock
  }

  /**
   * Hand the script over to MultiFunPlayer, or take it back.
   *
   * The two players are exclusive because they reach for the same hardware —
   * a serial port is held by one process at a time — so standing down means
   * actually letting go: every output disconnects and the auto-connect
   * scanner stops, rather than the app merely promising not to send anything.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) {
      this.restartAutoConnectScanner()
      this.ensureTimer()
    } else {
      this.stopAutoConnectScanner()
      this.engine.clear()
      for (const slot of this.slots.values()) {
        slot.base = null
        slot.current = null
        slot.linkedFrom = null
        slot.manual = false
      }
      this.mediaId = null
      this.scriptVersionId = null
      for (const id of this.outputs.keys()) void this.disconnect(id)
    }
    this.emitChanged()
  }

  configure(settings: ScriptPlayerSettings): void {
    const scanTimingChanged =
      settings.autoConnectScanDelayMs !== this.settings.autoConnectScanDelayMs ||
      settings.autoConnectScanIntervalMs !== this.settings.autoConnectScanIntervalMs
    const previous = this.settings
    this.settings = settings
    this.applyAxisChanges(previous, settings)
    const profiles = new Map(settings.outputs.map((profile) => [profile.id, profile]))
    for (const [id, runtime] of this.outputs) {
      const profile = profiles.get(id)
      if (!profile) {
        void this.disconnect(id)
        this.outputs.delete(id)
      } else {
        const connectionChanged =
          runtime.profile.transport !== profile.transport ||
          runtime.profile.endpoint !== profile.endpoint ||
          runtime.profile.port !== profile.port ||
          runtime.profile.baudRate !== profile.baudRate ||
          runtime.profile.dataBits !== profile.dataBits ||
          runtime.profile.stopBits !== profile.stopBits ||
          runtime.profile.parity !== profile.parity ||
          runtime.profile.flowControl !== profile.flowControl ||
          runtime.profile.dtr !== profile.dtr ||
          runtime.profile.rts !== profile.rts ||
          runtime.profile.connectionKey !== profile.connectionKey ||
          runtime.profile.sourceAxis !== profile.sourceAxis
        if (connectionChanged && runtime.state !== 'disconnected') void this.disconnect(id)
        runtime.profile = profile
      }
    }
    for (const profile of settings.outputs) {
      if (!this.outputs.has(profile.id)) this.outputs.set(profile.id, this.createRuntime(profile))
    }
    if (this.enabled && (!this.autoConnectDelay || scanTimingChanged)) {
      this.restartAutoConnectScanner()
    }
    this.emitChanged()
  }

  private createRuntime(profile: TCodeOutputProfile): RuntimeOutput {
    return {
      profile,
      transport: null,
      state: 'disconnected',
      error: null,
      lastTickAt: 0,
      lastSentAt: null,
      sending: false,
      pending: null,
      lastSentValues: {},
      sentMessages: 0,
      receivedMessages: 0,
      lastReceivedAt: null,
      lastResponse: null,
      sendTimes: [],
      polledSynced: false,
      resume: null,
      generation: 0
    }
  }

  /**
   * React to axis settings that change more than a number the next tick reads:
   * a new link re-resolves which script the axis plays, a looping script has a
   * file to read, and anything that moves the axis eases it in again.
   */
  private applyAxisChanges(previous: ScriptPlayerSettings, next: ScriptPlayerSettings): void {
    const relink: ScriptPlayerAxis[] = []
    const resync: ScriptPlayerAxis[] = []
    for (const axis of SCRIPT_PLAYER_AXES) {
      const before = previous.axes[axis] ?? DEFAULT_AXIS_MOTION[axis]
      const after = next.axes[axis] ?? DEFAULT_AXIS_MOTION[axis]
      if (before.linkAxis !== after.linkAxis || before.linkPriority !== after.linkPriority) relink.push(axis)
      if (
        SYNC_ON_CHANGE.some((key) => before[key] !== after[key]) ||
        providerSettingsKey(before) !== providerSettingsKey(after)
      ) {
        resync.push(axis)
      }
      this.loadLoopingScript(axis, after.providers.loopingScript.path)
    }
    this.engine.resetSync(next.syncDurationMs, resync)
    if (relink.length > 0 && this.enabled) this.reloadAxes(relink)
  }

  private loadLoopingScript(axis: ScriptPlayerAxis, path: string): void {
    if ((this.loopingScriptPaths.get(axis) ?? '') === path) return
    this.loopingScriptPaths.set(axis, path)
    if (!path) {
      this.engine.setLoopingScript(axis, null)
      return
    }
    void this.scriptFiles.read(path).then((file) => {
      if (this.loopingScriptPaths.get(axis) !== path) return
      this.engine.setLoopingScript(axis, file?.script ?? null)
    })
  }

  load(mediaId: string, scriptVersionId: string, scripts: Partial<Record<ScriptPlayerAxis, ScriptFile>>): void {
    if (!this.enabled) return
    this.mediaId = mediaId
    this.scriptVersionId = scriptVersionId
    for (const axis of SCRIPT_PLAYER_AXES) this.slots.get(axis)!.base = scripts[axis] ?? null
    this.reloadAxes(SCRIPT_PLAYER_AXES)
    // A locked axis kept its script but not its place in it: this is new media.
    this.engine.invalidateCursors()
    // The device is still standing wherever the last script left it, so the new
    // one has to be eased into rather than jumped to.
    this.engine.resetSync(this.settings.syncDurationMs)
    for (const runtime of this.outputs.values()) runtime.polledSynced = false
    this.ensureTimer()
    this.emitChanged()
  }

  /**
   * The script is gone; the connection is not. Connected outputs keep being
   * driven — auto-home walks each axis back to centre and holds it there, which
   * is a known resting position rather than the silence a `DSTOP` would leave.
   * Stopping the device is for disconnecting and for quitting.
   *
   * A locked axis keeps its script for whatever plays next.
   */
  clear(): void {
    for (const slot of this.slots.values()) slot.base = null
    this.reloadAxes(SCRIPT_PLAYER_AXES)
    this.mediaId = null
    this.scriptVersionId = null
    this.emitChanged()
  }

  /** Play this file on one axis until the media changes. */
  loadAxisScript(axis: ScriptPlayerAxis, file: ScriptFile): void {
    if (!this.enabled) return
    this.setAxisScript(axis, file, null, true)
    this.ensureTimer()
    this.emitChanged()
  }

  /** Leave one axis without a script until the media changes. */
  clearAxisScript(axis: ScriptPlayerAxis): void {
    this.setAxisScript(axis, null, null, true)
    this.emitChanged()
  }

  /** Put back what the library picked for this axis, undoing a load, clear or link by hand. */
  reloadAxisScript(axis: ScriptPlayerAxis): void {
    if (!this.enabled) return
    this.reloadAxes([axis])
    this.ensureTimer()
    this.emitChanged()
  }

  /** A locked axis keeps its script when the media changes. */
  setAxisLocked(axis: ScriptPlayerAxis, locked: boolean): void {
    this.slots.get(axis)!.locked = locked
    this.emitChanged()
  }

  axisScriptPath(axis: ScriptPlayerAxis): string | null {
    return this.slots.get(axis)!.current?.path ?? null
  }

  resetCurve(axis: ScriptPlayerAxis): void {
    this.engine.resetCurve(axis)
  }

  /**
   * The axis this one borrows from, or null. A link that leads back round to
   * the axis itself counts as none: the panel does not offer one, but a hand-
   * edited settings file could still hold it.
   */
  private linkOf(axis: ScriptPlayerAxis): ScriptPlayerAxis | null {
    const target = this.settings.axes[axis]?.linkAxis ?? null
    let current = target
    for (let hops = 0; current !== null && hops <= SCRIPT_PLAYER_AXES.length; hops++) {
      if (current === axis) return null
      current = this.settings.axes[current]?.linkAxis ?? null
    }
    return target
  }

  /** Priority only means something while there is a link to give it to. */
  private linkHasPriority(axis: ScriptPlayerAxis): boolean {
    return this.linkOf(axis) !== null && (this.settings.axes[axis]?.linkPriority ?? false)
  }

  private setAxisScript(
    axis: ScriptPlayerAxis,
    file: ScriptFile | null,
    linkedFrom: ScriptPlayerAxis | null,
    manual: boolean
  ): void {
    const slot = this.slots.get(axis)!
    if (slot.locked && slot.current) return
    slot.manual = manual
    if (!slot.current && !file) return
    if (slot.current === file && slot.linkedFrom === linkedFrom) return
    slot.current = file
    slot.linkedFrom = file ? linkedFrom : null
    this.engine.setScript(axis, file?.script ?? null)
    this.engine.resetSync(this.settings.syncDurationMs, [axis])
    this.updateLinksTo(axis)
  }

  /** Axes borrowing from `axis` follow it to its new script. */
  private updateLinksTo(axis: ScriptPlayerAxis): void {
    for (const other of SCRIPT_PLAYER_AXES) {
      if (other !== axis && this.linkOf(other) === axis) this.relink(other)
    }
  }

  /** Borrow the linked axis' script, when this axis has none of its own or the link has priority. */
  private relink(axis: ScriptPlayerAxis): void {
    const slot = this.slots.get(axis)!
    if (!this.linkHasPriority(axis) && slot.current && !slot.linkedFrom) return
    const link = this.linkOf(axis)
    if (link === null) this.setAxisScript(axis, null, null, slot.manual)
    else this.setAxisScript(axis, this.slots.get(link)!.current, link, slot.manual)
  }

  /**
   * Resolve these axes from the library again: each gets its own script, or
   * the linked axis' script where it has none or the link has priority. Axes
   * without priority go first so the ones that borrow see their final scripts.
   */
  private reloadAxes(axes: readonly ScriptPlayerAxis[]): void {
    this.engine.resetSync(this.settings.syncDurationMs, axes)
    const ordered = [
      ...axes.filter((axis) => !this.linkHasPriority(axis)),
      ...axes.filter((axis) => this.linkHasPriority(axis))
    ]
    for (const axis of ordered) {
      const slot = this.slots.get(axis)!
      const link = this.linkOf(axis)
      if (slot.base && !this.linkHasPriority(axis)) this.setAxisScript(axis, slot.base, null, false)
      else if (link !== null) this.setAxisScript(axis, this.slots.get(link)!.current, link, false)
      else this.setAxisScript(axis, null, null, false)
    }
  }

  async connect(id: string): Promise<void> {
    if (!this.enabled) return
    const runtime = this.outputs.get(id)
    if (!runtime || runtime.state === 'connected' || runtime.state === 'connecting') return
    if (runtime.profile.transport === 'handy' ? !runtime.profile.connectionKey : !runtime.profile.endpoint) {
      runtime.state = 'error'
      runtime.error = 'connect_failed'
      this.emitChanged()
      return
    }
    const generation = ++runtime.generation
    runtime.state = 'connecting'
    runtime.error = null
    this.emitChanged()
    try {
      const transport = this.makeTransport(runtime.profile)
      transport.setEvents({
        message: (payload) => this.receive(runtime, generation, payload),
        closed: () => this.transportClosed(runtime, generation)
      })
      runtime.transport = transport
      await transport.connect()
      if (generation !== runtime.generation) {
        await transport.disconnect().catch(() => {})
        return
      }
      runtime.transport = transport
      runtime.state = 'connected'
      runtime.error = null
      runtime.lastTickAt = 0
      // The device is wherever this output last left it, and the script has
      // moved on without it. Keep that position to resume from, and forget
      // what was last sent so the first command addresses every axis again.
      runtime.resume = this.settings.syncDurationMs > 0
        ? {
            from: runtime.lastSentValues,
            settleMs: RESUME_SETTLE_MS,
            easeMs: this.settings.syncDurationMs,
            durationMs: this.settings.syncDurationMs,
            sent: false
          }
        : null
      runtime.lastSentValues = {}
      runtime.polledSynced = false
      this.ensureTimer()
    } catch (error) {
      console.error(`[script-player] ${runtime.profile.transport} connect failed:`, error)
      if (generation === runtime.generation) {
        runtime.transport = null
        runtime.state = 'error'
        runtime.error = 'connect_failed'
      }
    }
    this.emitChanged()
  }

  async disconnect(id: string): Promise<void> {
    const runtime = this.outputs.get(id)
    if (!runtime || runtime.state === 'disconnecting' || runtime.state === 'disconnected') return
    ++runtime.generation
    const transport = runtime.transport
    runtime.transport = null
    runtime.pending = null
    runtime.resume = null
    runtime.state = 'disconnecting'
    runtime.error = null
    this.emitChanged()
    if (transport) {
      if (runtime.profile.transport !== 'handy') await transport.send(TCODE_STOP).catch(() => {})
      await transport.disconnect().catch(() => {})
    }
    runtime.state = 'disconnected'
    this.emitChanged()
  }

  status(): ScriptPlayerStatus {
    const sample = this.clock.sample()
    const hasScripts = this.engine.axes().length > 0
    const now = Date.now()
    return {
      enabled: this.enabled,
      phase: !hasScripts ? 'idle' : sample.paused === false ? 'playing' : sample.positionMs === null ? 'ready' : 'paused',
      mediaId: this.mediaId,
      scriptVersionId: this.scriptVersionId,
      positionMs: sample.positionMs,
      axes: { ...this.axes },
      syncing: this.syncing,
      homing: this.homing,
      scripts: Object.fromEntries(SCRIPT_PLAYER_AXES.map((axis) => {
        const slot = this.slots.get(axis)!
        return [axis, {
          name: slot.current?.name ?? null,
          path: slot.current?.path ?? null,
          linkedFrom: slot.linkedFrom,
          manual: slot.manual,
          locked: slot.locked
        }]
      })) as Record<ScriptPlayerAxis, AxisScriptStatus>,
      activity: this.engine.activity(),
      outputs: [...this.outputs.values()].map((runtime) => {
        runtime.sendTimes = runtime.sendTimes.filter((at) => now - at <= 1000)
        return {
          id: runtime.profile.id,
          name: runtime.profile.name,
          state: runtime.state,
          error: runtime.error,
          sentMessages: runtime.sentMessages,
          receivedMessages: runtime.receivedMessages,
          lastSentAt: runtime.lastSentAt,
          lastReceivedAt: runtime.lastReceivedAt,
          lastResponse: runtime.lastResponse,
          updateRate: runtime.sendTimes.length,
          retrying: this.enabled && runtime.profile.autoConnect && runtime.state === 'error'
        }
      })
    }
  }

  /** Apply the live range before persistence and reposition even while paused. */
  previewRanges(id: string, ranges: TCodeOutputProfile['ranges']): void {
    const runtime = this.outputs.get(id)
    if (!runtime) return
    runtime.profile = { ...runtime.profile, ranges }
    if (runtime.state !== 'connected' || !runtime.transport) return
    // No guard on having a script. Setting a range with nothing playing is the
    // one moment the user is deciding where the machine may travel, and it is
    // the moment it has to answer.
    const values = this.engine.values()
    const command = runtime.profile.transport === 'handy'
      ? this.handyCommand(runtime, values[runtime.profile.sourceAxis], 0)
      : this.commandFor(runtime, values, runtime.profile.updateIntervalMs, true)
    // No broadcast here. This runs once per animation frame while a range
    // slider is being dragged, and a status echo at that rate only re-renders
    // the panel under the pointer. The send below reports itself, throttled.
    if (command) this.queueSend(runtime, command)
  }

  /**
   * One self-rescheduling loop rather than a fixed interval: the axis pipeline
   * needs a fine tick while something is moving, and there is no reason to wake
   * the main process 300 times a second while nothing is.
   */
  private ensureTimer(delayMs = ACTIVE_TICK_MS): void {
    if (this.timer) return
    if (!this.hasWork()) {
      // Nothing is being driven, so the last positions are no longer true.
      this.lastTickAt = 0
      this.axes = {}
      this.syncing = false
      this.homing = false
      this.emitChanged()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.ensureTimer(this.tick())
    }, delayMs)
    this.timer.unref()
  }

  /**
   * A connected device is reason enough to keep running, script or no script.
   * It is being told where to rest, and it has to keep hearing it.
   */
  private hasWork(): boolean {
    if (this.engine.axes().length > 0) return true
    for (const runtime of this.outputs.values()) if (runtime.state === 'connected') return true
    return false
  }

  /** Runs the axis pipeline and feeds the outputs. Returns the next tick delay. */
  private tick(): number {
    const now = performance.now()
    const deltaMs = this.lastTickAt === 0 ? 0 : now - this.lastTickAt
    this.lastTickAt = now

    const sample = this.clock.sample()
    const matched =
      sample.mediaId !== null && sample.mediaId === this.mediaId &&
      sample.scriptVersionId === this.scriptVersionId && sample.positionMs !== null
    const playing = matched && sample.paused === false
    const position = matched ? sample.positionMs! + this.settings.syncOffsetMs : null

    // Every way the device can end up somewhere the script did not put it earns
    // a fresh ease-in: a seek, a pause or a resume, and losing or finding media.
    const seeked = position !== null && this.lastPosition !== null &&
      Math.abs(position - this.lastPosition) > 250
    if (seeked) this.engine.invalidateCursors()
    if (seeked || playing !== this.lastPlaying || matched !== this.lastMatched) {
      this.engine.resetSync(this.settings.syncDurationMs)
    }
    this.lastPlaying = playing
    this.lastMatched = matched
    this.lastPosition = position

    const updates = this.engine.update({ positionMs: position, playing, deltaMs, settings: this.settings })

    const axes: Partial<Record<ScriptPlayerAxis, number>> = {}
    let syncing = false
    let homing = false
    let moving = false
    for (const axis of SCRIPT_PLAYER_AXES) {
      const update = updates[axis]
      if (!update) continue
      if (Number.isFinite(update.value)) axes[axis] = update.value
      if (update.syncing) syncing = true
      if (update.dirty) moving = true
      // An axis parked at its resting place is still "auto-homing" as far as the
      // pipeline is concerned. Only count it while it is actually travelling, or
      // the fast tick would never stand down and the badge would never go out.
      const target = (this.settings.axes[axis] ?? DEFAULT_AXIS_MOTION[axis]).autoHomeTarget
      if (update.autoHoming && Math.abs(update.value - target) > 0.00001) homing = true
    }
    this.axes = axes
    this.homing = homing

    let resuming = false
    for (const runtime of this.outputs.values()) {
      if (runtime.state !== 'connected' || !runtime.transport) continue
      if (runtime.resume) resuming = true
      if (this.advanceResume(runtime, deltaMs) || runtime.sending) continue
      if (runtime.profile.updateMode === 'polled') this.sendPolled(runtime, updates)
      else this.sendFixed(runtime, now)
    }
    // An output walking back into the script is easing in as much as an axis is.
    this.syncing = syncing || resuming

    this.maybeBroadcast()
    return playing || syncing || homing || moving || resuming ? ACTIVE_TICK_MS : IDLE_TICK_MS
  }

  /**
   * Move one output's resume along, and say whether it is still travelling to
   * the position it was left at — while it is, it is sent nothing else, or a
   * streamed value would overrule the slow move before the device finished it.
   */
  private advanceResume(runtime: RuntimeOutput, deltaMs: number): boolean {
    const resume = runtime.resume
    if (!resume) return false
    if (!resume.sent) {
      resume.sent = true
      const command = this.settleCommand(runtime, resume)
      if (command) this.queueSend(runtime, command)
      return true
    }
    if (resume.settleMs > 0) {
      resume.settleMs = Math.max(0, resume.settleMs - deltaMs)
      return true
    }
    resume.easeMs -= deltaMs
    if (resume.easeMs <= 0) runtime.resume = null
    return false
  }

  /**
   * "Go back to where you were, and take a second over it." The travel time is
   * spelled out even for an output that leaves timing to the device: this one
   * move has to be slow, because the distance is unknown.
   */
  private settleCommand(runtime: RuntimeOutput, resume: OutputResume): PendingCommand | null {
    if (runtime.profile.transport === 'handy') {
      const axis = runtime.profile.sourceAxis
      const range = runtime.profile.ranges[axis]
      if (!range.enabled) return null
      const position = resume.from[axis] ?? applyAxisRange(AXIS_CENTRE, range)
      return {
        payload: JSON.stringify({
          immediateResponse: true,
          stopOnTarget: true,
          duration: RESUME_SETTLE_MS,
          position: Math.min(100, Math.max(0, position * 100))
        }),
        values: { [axis]: position }
      }
    }
    const values: Partial<Record<ScriptPlayerAxis, number>> = {}
    for (const axis of SCRIPT_PLAYER_AXES) {
      const range = runtime.profile.ranges[axis]
      if (!range.enabled) continue
      values[axis] = resume.from[axis] ?? applyAxisRange(AXIS_CENTRE, range)
    }
    const payload = encodeTCode(values, RESUME_SETTLE_MS, runtime.profile.protocol === 'v0.2' ? 3 : 4)
    return payload ? { payload, values } : null
  }

  /**
   * Where this output should be putting an axis now: the live value, or, during
   * the ease-in that follows a connect, a point on the way to it from where the
   * device was left. The engine's own ease-in cannot cover this — it followed
   * the script the whole time the device was gone, so it has nothing to ease
   * from. This one works in device positions, after the output range, because
   * that is the distance the hardware actually travels.
   */
  private resumed(runtime: RuntimeOutput, axis: ScriptPlayerAxis, live: number, range: AxisRange): number {
    const resume = runtime.resume
    if (!resume) return live
    const from = resume.from[axis] ?? applyAxisRange(AXIS_CENTRE, range)
    return from + (live - from) * syncProgress(resume.easeMs, resume.durationMs)
  }

  /** Stream the current value at the output's own interval. */
  private sendFixed(runtime: RuntimeOutput, now: number): void {
    if (now - runtime.lastTickAt < runtime.profile.updateIntervalMs) return
    const elapsed = runtime.lastTickAt > 0 ? now - runtime.lastTickAt : runtime.profile.updateIntervalMs
    runtime.lastTickAt = now
    const command = this.commandFor(runtime, this.axes, elapsed)
    if (command) this.queueSend(runtime, command)
  }

  /** Send discrete targets: where to go next and how long to take getting there. */
  private sendPolled(
    runtime: RuntimeOutput,
    updates: Partial<Record<ScriptPlayerAxis, AxisUpdate>>
  ): void {
    // A freshly connected device does not know where it should already be.
    if (!runtime.polledSynced) {
      runtime.polledSynced = true
      const command = runtime.profile.transport === 'handy'
        ? this.handyCommand(runtime, this.axes[runtime.profile.sourceAxis], 0)
        : this.commandFor(runtime, this.axes, 0, true)
      if (command) this.queueSend(runtime, command)
      return
    }

    if (runtime.profile.transport === 'handy') {
      const event = updates[runtime.profile.sourceAxis]?.event
      if (!event) return
      const command = this.handyCommand(runtime, event.value, event.durationMs)
      if (command) this.queueSend(runtime, command)
      return
    }

    const targets: Partial<Record<ScriptPlayerAxis, { value: number; durationMs: number }>> = {}
    const values: Partial<Record<ScriptPlayerAxis, number>> = {}
    for (const axis of SCRIPT_PLAYER_AXES) {
      const event = updates[axis]?.event
      const range = runtime.profile.ranges[axis]
      if (!event || !range.enabled) continue
      const output = this.resumed(runtime, axis, applyAxisRange(event.value, range), range)
      targets[axis] = { value: output, durationMs: event.durationMs }
      values[axis] = output
    }
    const payload = encodeTCodeTargets(
      targets,
      runtime.profile.offloadElapsedTime,
      runtime.profile.protocol === 'v0.2' ? 3 : 4
    )
    if (payload) this.queueSend(runtime, { payload, values })
  }

  private async stopOutputs(): Promise<void> {
    await Promise.all([...this.outputs.values()]
      .filter((runtime) => runtime.state === 'connected' && runtime.transport && runtime.profile.transport !== 'handy')
      .map((runtime) => runtime.transport!.send(TCODE_STOP).catch(() => {})))
  }

  private handyCommand(runtime: RuntimeOutput, value: number | undefined, durationMs: number): PendingCommand | null {
    const axis = runtime.profile.sourceAxis
    const range = runtime.profile.ranges[axis]
    if (!range.enabled) return null
    const output = this.resumed(runtime, axis, applyAxisRange(value ?? AXIS_CENTRE, range), range)
    return {
      payload: JSON.stringify({
        immediateResponse: true,
        stopOnTarget: true,
        duration: Math.max(0, Math.round(durationMs)),
        position: Math.min(100, Math.max(0, output * 100))
      }),
      values: { [axis]: output }
    }
  }

  /**
   * Every enabled axis gets a value, whether or not a script drives it.
   *
   * An axis nothing is driving rests at centre, mapped through this output's
   * range. Without that fallback an unscripted axis is never addressed at all:
   * its range slider does nothing, and the device holds whatever position it
   * happened to be left in — including from a previous session.
   */
  private commandFor(runtime: RuntimeOutput, values: Partial<Record<ScriptPlayerAxis, number>>, elapsedMs: number, force = false): PendingCommand | null {
    const mapped: Partial<Record<ScriptPlayerAxis, number>> = {}
    const precision = runtime.profile.protocol === 'v0.2' ? 3 : 4
    for (const axis of SCRIPT_PLAYER_AXES) {
      const range = runtime.profile.ranges[axis]
      if (!range.enabled) continue
      const output = this.resumed(runtime, axis, applyAxisRange(values[axis] ?? AXIS_CENTRE, range), range)
      const previous = runtime.lastSentValues[axis]
      const dirty = previous === undefined || Math.abs(output - previous) * (10 ** precision) >= 1
      if (force || !runtime.profile.sendDirtyValuesOnly || dirty) mapped[axis] = output
    }
    const payload = encodeTCode(mapped, runtime.profile.offloadElapsedTime ? null : elapsedMs, precision)
    return payload ? { payload, values: mapped } : null
  }

  private queueSend(runtime: RuntimeOutput, command: PendingCommand): void {
    if (runtime.sending) {
      runtime.pending = command
      return
    }
    const transport = runtime.transport
    if (!transport || runtime.state !== 'connected') return
    runtime.sending = true
    let failed = false
    void transport.send(command.payload).then(() => {
      Object.assign(runtime.lastSentValues, command.values)
      runtime.sentMessages++
      const now = Date.now()
      runtime.lastSentAt = now
      runtime.sendTimes.push(now)
    }).catch((error) => {
      failed = true
      console.error(`[script-player] ${runtime.profile.transport} send failed:`, error)
      runtime.state = 'error'
      runtime.error = 'send_failed'
      runtime.pending = null
      ++runtime.generation
      void runtime.transport?.disconnect().catch(() => {})
      runtime.transport = null
    }).finally(() => {
      runtime.sending = false
      const pending = runtime.pending
      runtime.pending = null
      if (pending) this.queueSend(runtime, pending)
      // A send at a 10ms interval is 100 of these a second; the counters they
      // carry do not need that rate. A dropped connection does.
      if (failed) this.emitChanged()
      else this.maybeBroadcast()
    })
  }

  private receive(runtime: RuntimeOutput, generation: number, payload: string): void {
    if (generation !== runtime.generation || (runtime.state !== 'connecting' && runtime.state !== 'connected')) return
    runtime.receivedMessages++
    runtime.lastReceivedAt = Date.now()
    runtime.lastResponse = payload.trim().slice(-160) || null
    this.emitChanged()
  }

  private transportClosed(runtime: RuntimeOutput, generation: number): void {
    if (generation !== runtime.generation || runtime.state === 'disconnecting') return
    runtime.transport = null
    runtime.state = 'error'
    runtime.error = 'connection_lost'
    this.emitChanged()
  }

  private stopAutoConnectScanner(): void {
    if (this.autoConnectDelay) clearTimeout(this.autoConnectDelay)
    if (this.autoConnectTimer) clearInterval(this.autoConnectTimer)
    this.autoConnectDelay = null
    this.autoConnectTimer = null
  }

  private restartAutoConnectScanner(): void {
    this.stopAutoConnectScanner()
    const scan = (): void => {
      for (const runtime of this.outputs.values()) {
        if (runtime.profile.autoConnect && (runtime.state === 'disconnected' || runtime.state === 'error')) void this.connect(runtime.profile.id)
      }
    }
    this.autoConnectDelay = setTimeout(() => {
      scan()
      this.autoConnectTimer = setInterval(scan, this.settings.autoConnectScanIntervalMs)
      this.autoConnectTimer.unref()
    }, this.settings.autoConnectScanDelayMs)
    this.autoConnectDelay.unref()
  }

  private maybeBroadcast(): void {
    const now = performance.now()
    if (now - this.lastBroadcastAt < 100) return
    this.lastBroadcastAt = now
    this.emitChanged()
  }

  private emitChanged(): void {
    this.emit('changed', this.status())
  }

  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.stopAutoConnectScanner()
    this.timer = null
    await this.stopOutputs()
    await Promise.all([...this.outputs.keys()].map((id) => this.disconnect(id)))
  }
}
