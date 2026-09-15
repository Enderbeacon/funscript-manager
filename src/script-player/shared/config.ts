import { z } from 'zod'

/** Logical axes used by sidecars and the script engine. */
export const SCRIPT_PLAYER_AXES = ['main', 'surge', 'sway', 'twist', 'roll', 'pitch'] as const
export const ScriptPlayerAxisSchema = z.enum(SCRIPT_PLAYER_AXES)
export type ScriptPlayerAxis = z.infer<typeof ScriptPlayerAxisSchema>

/** Standard TCode v0.3 channel for each sidecar axis. */
export const TCODE_CHANNEL_BY_AXIS: Record<ScriptPlayerAxis, string> = {
  main: 'L0',
  surge: 'L1',
  sway: 'L2',
  twist: 'R0',
  roll: 'R1',
  pitch: 'R2'
}

/**
 * Interpolation between two script actions. `pchip` is the default: a script
 * whose actions are widely spaced then moves in curves rather than straight
 * ramps, which is how it felt to whoever wrote it.
 */
export const INTERPOLATION_TYPES = ['linear', 'pchip', 'makima', 'step'] as const
export const InterpolationTypeSchema = z.enum(INTERPOLATION_TYPES)
export type InterpolationType = z.infer<typeof InterpolationTypeSchema>

/** Where an axis rests when nothing is driving it: the middle of its travel. */
export const AXIS_CENTRE = 0.5

/** A point on an editable curve. The units belong to whichever curve holds it. */
export const CurvePointSchema = z.object({ x: z.number(), y: z.number() })
export type CurvePoint = z.infer<typeof CurvePointSchema>

/** Programs that move an axis without a script, or alongside one. */
export const MOTION_PROVIDERS = ['random', 'pattern', 'customCurve', 'loopingScript'] as const
export const MotionProviderSchema = z.enum(MOTION_PROVIDERS)
export type MotionProvider = z.infer<typeof MotionProviderSchema>

export const PATTERN_TYPES = ['triangle', 'sine', 'doubleBounce', 'sharpBounce', 'saw', 'square'] as const
export type PatternType = (typeof PATTERN_TYPES)[number]

/**
 * `value` pulls the axis towards a target position; `speed` slows it down. How
 * hard either one bites is read off the smart limit curve.
 */
export const SMART_LIMIT_MODES = ['value', 'speed'] as const
export type SmartLimitMode = (typeof SMART_LIMIT_MODES)[number]

/**
 * Every provider plays at `speed` (1 is its natural rate) and is mapped into
 * `minimum`..`maximum` of the axis.
 */
const providerBase = {
  speed: z.number().min(0.01).max(100).default(1),
  minimum: z.number().min(0).max(1).default(0),
  maximum: z.number().min(0).max(1).default(1)
}

export const RandomProviderSchema = z.object({
  ...providerBase,
  speed: providerBase.speed.default(0.3),
  octaves: z.number().int().min(1).max(8).default(1),
  persistence: z.number().min(0.01).max(100).default(1),
  lacunarity: z.number().min(0.1).max(2).default(1)
})

export const PatternProviderSchema = z.object({
  ...providerBase,
  pattern: z.enum(PATTERN_TYPES).default('triangle')
})

/** Points are `x` seconds into the curve and `y` 0..1 of the axis. */
export const CustomCurveProviderSchema = z.object({
  ...providerBase,
  points: z.array(CurvePointSchema).default([{ x: 0, y: 0 }]),
  interpolation: InterpolationTypeSchema.default('linear'),
  durationS: z.number().min(1).max(60).default(10),
  loop: z.boolean().default(true),
  /** Ease back in to the script when a curve that does not loop runs out. */
  syncOnEnd: z.boolean().default(true)
})

export const LoopingScriptProviderSchema = z.object({
  ...providerBase,
  /** Absolute path of the .funscript to loop; empty when none is chosen. */
  path: z.string().default(''),
  interpolation: InterpolationTypeSchema.default('pchip')
})

export const MotionProvidersSchema = z.object({
  random: RandomProviderSchema.prefault({}),
  pattern: PatternProviderSchema.prefault({}),
  customCurve: CustomCurveProviderSchema.prefault({}),
  loopingScript: LoopingScriptProviderSchema.prefault({})
})
export type MotionProviders = z.infer<typeof MotionProvidersSchema>

/** Per-axis motion settings. These sit on the script side, so one set drives every output. */
export const AxisMotionSchema = z.object({
  interpolation: InterpolationTypeSchema.default('pchip'),
  /** Stroke depth around the axis centre. 1 is the script as authored. */
  scriptScale: z.number().min(0.01).max(4).default(1),
  invert: z.boolean().default(false),
  /** Added to the device offset for this axis alone. */
  offsetMs: z.number().int().min(-600_000).max(600_000).default(0),

  /** Ignore the script on this axis without unloading it. */
  bypassScript: z.boolean().default(false),
  /** Ignore the motion provider on this axis without deselecting it. */
  bypassMotion: z.boolean().default(false),

  /** Borrow another axis' script when this one has none. */
  linkAxis: ScriptPlayerAxisSchema.nullable().default(null),
  /** Borrow it even when this axis has a script of its own. */
  linkPriority: z.boolean().default(false),

  motionProvider: MotionProviderSchema.nullable().default(null),
  /** 0 plays the script, 1 plays the provider; in between mixes the two. */
  motionBlend: z.number().min(0).max(1).default(0),
  /** Let the provider take over during long flat stretches of the script. */
  fillGaps: z.boolean().default(false),
  minGapMs: z.number().int().min(0).max(600_000).default(5000),
  /** Never let the provider outrun the axis it follows. */
  matchAxisSpeed: z.boolean().default(true),
  updateWhenPaused: z.boolean().default(false),
  updateWithoutScript: z.boolean().default(false),
  /** Only run the provider while this other axis is moving. */
  updateWithAxis: ScriptPlayerAxisSchema.nullable().default(null),
  providers: MotionProvidersSchema.prefault({}),

  /** Limit this axis by where another axis currently is. */
  smartLimitAxis: ScriptPlayerAxisSchema.nullable().default(null),
  /** `x` is the input axis 0..100, `y` how much of this axis is let through, 0..100. */
  smartLimitPoints: z.array(CurvePointSchema).min(1).default([{ x: 25, y: 100 }, { x: 90, y: 0 }]),
  smartLimitMode: z.enum(SMART_LIMIT_MODES).default('value'),
  smartLimitTarget: z.number().min(0).max(1).default(AXIS_CENTRE),

  /** Return to a resting position once nothing is driving this axis. */
  autoHome: z.boolean().default(true),
  /** Also home during a still stretch inside a playing script. */
  autoHomeInsideScript: z.boolean().default(false),
  autoHomeDelayMs: z.number().int().min(0).max(600_000).default(5000),
  autoHomeDurationMs: z.number().int().min(0).max(600_000).default(3000),
  autoHomeTarget: z.number().min(0).max(1).default(AXIS_CENTRE),

  speedLimit: z.boolean().default(false),
  /** Full travel (0 to 1) per second. */
  speedLimitPerSecond: z.number().min(0).max(100).default(10)
})

export type AxisMotion = z.infer<typeof AxisMotionSchema>

export const DEFAULT_AXIS_MOTION = Object.fromEntries(
  SCRIPT_PLAYER_AXES.map((axis) => [axis, AxisMotionSchema.parse({})])
) as Record<ScriptPlayerAxis, AxisMotion>

export const AxisRangeSchema = z
  .object({
    min: z.number().min(0).max(1).default(0),
    max: z.number().min(0).max(1).default(1),
    enabled: z.boolean().default(true)
  })
  // One percent is the narrowest range the slider will produce. It has to be
  // spelled with room for float dust: the slider works in whole percent,
  // and 0.03 - 0.02 is 0.009999999999999998, which would fail a bare >= 0.01 and
  // make the save silently do nothing.
  .refine((range) => range.max - range.min >= 0.01 - 1e-9, {
    message: 'axis range must be at least one percent'
  })

export type AxisRange = z.infer<typeof AxisRangeSchema>

export const DEFAULT_AXIS_RANGES = Object.fromEntries(
  SCRIPT_PLAYER_AXES.map((axis) => [axis, { min: 0, max: 1, enabled: true }])
) as Record<ScriptPlayerAxis, AxisRange>

export const TCodeOutputProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80),
  transport: z.enum(['serial', 'udp', 'tcp', 'websocket', 'handy']),
  protocol: z.enum(['v0.2', 'v0.3']).default('v0.3'),
  /** Serial port path, hostname, or ws(s) URL depending on transport. */
  endpoint: z.string().trim().default(''),
  /** Used by UDP/TCP. */
  port: z.number().int().min(1).max(65535).default(8000),
  /** Used by serial. */
  baudRate: z.number().int().min(1200).max(2_000_000).default(115200),
  dataBits: z.union([z.literal(5), z.literal(6), z.literal(7), z.literal(8)]).default(8),
  stopBits: z.union([z.literal(1), z.literal(1.5), z.literal(2)]).default(1),
  parity: z.enum(['none', 'even', 'odd', 'mark', 'space']).default('none'),
  flowControl: z.enum(['none', 'xonxoff', 'rtscts', 'rtscts-xonxoff']).default('none'),
  dtr: z.boolean().default(true),
  rts: z.boolean().default(true),
  /** The renderer may briefly hold a raw value; persistence replaces it with a safeStorage token. */
  connectionKey: z.string().default(''),
  sourceAxis: ScriptPlayerAxisSchema.default('main'),
  /** Reconnect policy belongs to the output, not to the app as a whole. */
  autoConnect: z.boolean().default(false),
  updateMode: z.enum(['fixed', 'polled']).default('fixed'),
  /** 10 ms is close enough for a TCode device to move smoothly. */
  updateIntervalMs: z.number().int().min(3).max(200).default(10),
  sendDirtyValuesOnly: z.boolean().default(true),
  offloadElapsedTime: z.boolean().default(false),
  ranges: z
    .record(ScriptPlayerAxisSchema, AxisRangeSchema)
    .prefault(DEFAULT_AXIS_RANGES)
})

export type TCodeOutputProfile = z.infer<typeof TCodeOutputProfileSchema>

/**
 * Auto-home timing used to be one pair of numbers for the whole player. A
 * settings file from then carries them at the top level; they become every
 * axis' own starting values rather than being dropped for the defaults.
 */
function liftAutoHomeTiming(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw
  const { autoHomeDelayMs, autoHomeDurationMs, ...rest } = raw as Record<string, unknown>
  if (autoHomeDelayMs === undefined && autoHomeDurationMs === undefined) return raw
  const axes = typeof rest.axes === 'object' && rest.axes !== null
    ? rest.axes as Record<string, unknown>
    : {}
  return {
    ...rest,
    axes: Object.fromEntries(SCRIPT_PLAYER_AXES.map((axis) => {
      const existing = typeof axes[axis] === 'object' && axes[axis] !== null
        ? axes[axis] as Record<string, unknown>
        : {}
      return [axis, {
        ...(autoHomeDelayMs !== undefined ? { autoHomeDelayMs } : {}),
        ...(autoHomeDurationMs !== undefined ? { autoHomeDurationMs } : {}),
        ...existing
      }]
    }))
  }
}

export const ScriptPlayerSettingsSchema = z.preprocess(liftAutoHomeTiming, z.object({
  syncOffsetMs: z.number().int().min(-5000).max(5000).default(0),
  autoConnectScanDelayMs: z.number().int().min(0).max(60_000).default(2500),
  autoConnectScanIntervalMs: z.number().int().min(1000).max(60_000).default(5000),
  /** Ease from where the device is to where the script is. 0 disables it. */
  syncDurationMs: z.number().int().min(0).max(20_000).default(2500),
  axes: z.record(ScriptPlayerAxisSchema, AxisMotionSchema).prefault(DEFAULT_AXIS_MOTION),
  outputs: z.array(TCodeOutputProfileSchema).default([])
})).prefault({})

export type ScriptPlayerSettings = z.infer<typeof ScriptPlayerSettingsSchema>
