import { z } from 'zod'
import {
  SCRIPT_PLAYER_AXES,
  ScriptPlayerSettingsSchema,
  TCodeOutputProfileSchema
} from '../../shared/config'

const OutputRuntimeStatusSchema = z.object({
  id: z.uuid(),
  /** Carried here so a status subscriber can name the output without also
   *  holding the settings; the sidebar list is one such subscriber. */
  name: z.string(),
  state: z.enum(['disconnected', 'connecting', 'connected', 'disconnecting', 'error']),
  error: z.enum(['connect_failed', 'send_failed', 'connection_lost']).nullable(),
  sentMessages: z.number().int().nonnegative(),
  receivedMessages: z.number().int().nonnegative(),
  lastSentAt: z.number().nullable(),
  lastReceivedAt: z.number().nullable(),
  lastResponse: z.string().nullable(),
  updateRate: z.number().int().nonnegative(),
  retrying: z.boolean()
})

const AxisSchema = z.enum(SCRIPT_PLAYER_AXES)

const AxisScriptStatusSchema = z.object({
  name: z.string().nullable(),
  path: z.string().nullable(),
  linkedFrom: AxisSchema.nullable(),
  manual: z.boolean(),
  locked: z.boolean()
})

const AxisActivitySchema = z.object({
  speedLimited: z.boolean(),
  smartLimited: z.boolean(),
  curveTime: z.number().nullable()
})

export const ScriptPlayerStatusSchema = z.object({
  /** False when the script route hands the script to MultiFunPlayer instead. */
  enabled: z.boolean(),
  phase: z.enum(['idle', 'ready', 'playing', 'paused']),
  mediaId: z.uuid().nullable(),
  scriptVersionId: z.uuid().nullable(),
  positionMs: z.number().nullable(),
  axes: z.partialRecord(z.enum(SCRIPT_PLAYER_AXES), z.number().min(0).max(1)),
  syncing: z.boolean(),
  homing: z.boolean(),
  scripts: z.record(AxisSchema, AxisScriptStatusSchema),
  activity: z.record(AxisSchema, AxisActivitySchema),
  outputs: z.array(OutputRuntimeStatusSchema)
})

export const scriptPlayerIpcContract = {
  'script-player:status': {
    input: z.void(),
    output: ScriptPlayerStatusSchema
  },
  'script-player:settings': {
    input: z.void(),
    output: ScriptPlayerSettingsSchema
  },
  'script-player:updateSettings': {
    input: ScriptPlayerSettingsSchema,
    output: ScriptPlayerSettingsSchema
  },
  'script-player:saveOutput': {
    input: TCodeOutputProfileSchema,
    output: ScriptPlayerSettingsSchema
  },
  'script-player:previewRanges': {
    input: z.object({
      id: z.uuid(),
      ranges: TCodeOutputProfileSchema.shape.ranges
    }),
    output: z.void()
  },
  'script-player:removeOutput': {
    input: z.object({ id: z.uuid() }),
    output: ScriptPlayerSettingsSchema
  },
  'script-player:connect': {
    input: z.object({ id: z.uuid() }),
    output: ScriptPlayerStatusSchema
  },
  'script-player:disconnect': {
    input: z.object({ id: z.uuid() }),
    output: ScriptPlayerStatusSchema
  },
  /** A single .funscript picked from disk; null when the dialog was cancelled. */
  'script-player:pickScript': {
    input: z.void(),
    output: z.object({ path: z.string().nullable() })
  },
  /** Play this file on one axis until the media changes. */
  'script-player:axisLoad': {
    input: z.object({ axis: AxisSchema, path: z.string().min(1) }),
    output: ScriptPlayerStatusSchema
  },
  'script-player:axisClear': {
    input: z.object({ axis: AxisSchema }),
    output: ScriptPlayerStatusSchema
  },
  /** Back to the library's script for this axis. */
  'script-player:axisReload': {
    input: z.object({ axis: AxisSchema }),
    output: ScriptPlayerStatusSchema
  },
  'script-player:axisLock': {
    input: z.object({ axis: AxisSchema, locked: z.boolean() }),
    output: ScriptPlayerStatusSchema
  },
  'script-player:axisReveal': {
    input: z.object({ axis: AxisSchema }),
    output: z.void()
  },
  'script-player:resetCurve': {
    input: z.object({ axis: AxisSchema }),
    output: z.void()
  },
  'script-player:listSerialPorts': {
    input: z.void(),
    output: z.object({ ports: z.array(z.object({ path: z.string(), label: z.string() })) })
  },
  'script-player:detach': {
    input: z.void(),
    output: z.object({ detached: z.boolean() })
  },
  'script-player:attach': {
    input: z.void(),
    output: z.object({ detached: z.boolean() })
  },
  'script-player:surface': {
    input: z.void(),
    output: z.object({ detached: z.boolean() })
  }
} as const

export const scriptPlayerIpcEvents = {
  'event:script-player-changed': ScriptPlayerStatusSchema,
  'event:script-player-surface': z.object({ detached: z.boolean() })
} as const
