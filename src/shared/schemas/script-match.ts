import { z } from 'zod'

export const ScriptMatchCandidateSchema = z.object({
  mediaId: z.uuid(),
  filePath: z.string(),
  kind: z.enum(['exact', 'similar'])
})

export const ScriptMatchGroupSchema = z.object({
  id: z.string(),
  scriptPath: z.string(),
  files: z.array(z.string()),
  copy: z.boolean(),
  candidates: z.array(ScriptMatchCandidateSchema),
  suggestedMediaId: z.uuid().nullable()
})

export const ScriptMatchPreviewSchema = z.object({
  folders: z.array(z.string()),
  unreachable: z.array(z.string()),
  groups: z.array(ScriptMatchGroupSchema),
  unmatched: z.number().int().nonnegative()
})

export const ScriptMatchChoiceSchema = z.object({ groupId: z.string(), mediaId: z.uuid() })
export const ScriptMatchApplyResultSchema = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative()
})

export type ScriptMatchCandidate = z.infer<typeof ScriptMatchCandidateSchema>
export type ScriptMatchGroup = z.infer<typeof ScriptMatchGroupSchema>
export type ScriptMatchPreview = z.infer<typeof ScriptMatchPreviewSchema>
export type ScriptMatchChoice = z.infer<typeof ScriptMatchChoiceSchema>
export type ScriptMatchApplyResult = z.infer<typeof ScriptMatchApplyResultSchema>
