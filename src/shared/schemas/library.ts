import { z } from 'zod'

/**
 * Library-wide metadata (`<library root>/.fsmgr-cache/library.json`).
 * Source of truth alongside sidecars; index.db is a derived cache.
 */

export const TagNodeSchema = z.object({
  parent: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([])
})

export const PerformerSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  /** Path relative to the library root. */
  avatar: z.string().optional(),
  notes: z.string().optional()
})

export const StudioSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  url: z.url().optional(),
  parent: z.string().nullable().default(null)
})

export const CollectionSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  mediaIds: z.array(z.uuid()).default([]),
  createdAt: z.iso.datetime()
})

export const LibraryJsonSchema = z.object({
  schemaVersion: z.literal(1),
  tagHierarchy: z.record(z.string(), TagNodeSchema).default({}),
  performers: z.array(PerformerSchema).default([]),
  studios: z.array(StudioSchema).default([]),
  collections: z.array(CollectionSchema).default([])
})

export type LibraryJson = z.infer<typeof LibraryJsonSchema>
export type Performer = z.infer<typeof PerformerSchema>
export type Studio = z.infer<typeof StudioSchema>
export type Collection = z.infer<typeof CollectionSchema>

export function emptyLibraryJson(): LibraryJson {
  return LibraryJsonSchema.parse({ schemaVersion: 1 })
}
