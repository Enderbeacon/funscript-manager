import { z } from 'zod'
import { NAME_FIELDS } from './media-meta'

/**
 * Taxonomy: the structure laid over the names sidecars carry.
 *
 * Sidecars store plain names — `tags: ['VR', '180°']`. This file adds what a
 * name alone cannot say: which tag sits under which, what else a tag has been
 * called, what a collection is for. Two consequences worth stating:
 *
 * - Losing taxonomy.json loses structure, never data. Every tag still exists,
 *   as a flat list, and the library keeps working.
 * - Renaming here rewrites the sidecars that use the old name. That is the
 *   cost of names-not-ids, and it buys a sidecar that reads correctly on its
 *   own, forever.
 *
 * It is app-level, not per library: one person has one vocabulary, and the
 * same tag means the same thing in every library they registered.
 */

/** The kinds of name a media can carry; the taxonomy describes all of them. */
export const ENTITY_KINDS = NAME_FIELDS
export type EntityKind = (typeof ENTITY_KINDS)[number]

export const EntitySchema = z.looseObject({
  name: z.string().min(1),
  /**
   * Parent name within the same kind, for the kinds that nest (tags and
   * playlists). Absent = top level. A cycle is rejected at write time.
   */
  parent: z.string().optional(),
  /**
   * Other spellings that mean this one. Used when metadata arrives from a
   * forum post: `Virtual Reality` lands on `VR` instead of beside it.
   */
  aliases: z.array(z.string()).default([]),
  description: z.string().optional(),
  /** Media-relative or absolute image path; the organise page shows it. */
  image: z.string().optional(),
  /** Sort key inside the parent; ties fall back to name order. */
  order: z.number().int().optional(),
  /**
   * When the name was pinned, epoch ms; absent = not pinned. Pinned names are
   * kept within reach — the media page and the VR panel offer them as one-tap
   * filters and list them first — the latest pinned at the top.
   */
  pinnedAt: z.number().int().optional()
})

const TaxonomyBodySchema = z.looseObject({
  schemaVersion: z.literal(1).default(1),
  entities: z
    .looseObject({
      tags: z.array(EntitySchema).default([]),
      videoAuthors: z.array(EntitySchema).default([]),
      scriptAuthors: z.array(EntitySchema).default([]),
      studios: z.array(EntitySchema).default([]),
      playlists: z.array(EntitySchema).default([])
    })
    .prefault({}),
  /** Filters the user chose to keep; the sidebar lists them as playlists do. */
  savedFilters: z
    .array(
      z.looseObject({
        id: z.uuid(),
        name: z.string().min(1),
        /** A FilterNode, stored as given; validated when it is applied. */
        filter: z.unknown(),
        createdAt: z.iso.datetime()
      })
    )
    .default([])
})

/**
 * `collections` became `playlists` alongside the sidecar's own v2 → v3 move.
 * Renamed on read, so a taxonomy.json written by an older build keeps every
 * cover image, alias and parent it had rather than silently starting over.
 */
export const TaxonomyFileSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw
  const record = raw as Record<string, unknown>
  const entities = record.entities
  if (!entities || typeof entities !== 'object') return record
  const kinds = entities as Record<string, unknown>
  if (!('collections' in kinds) || 'playlists' in kinds) return record
  const { collections, ...rest } = kinds
  return { ...record, entities: { ...rest, playlists: collections } }
}, TaxonomyBodySchema)

export type Entity = z.infer<typeof EntitySchema>
export type TaxonomyFile = z.infer<typeof TaxonomyBodySchema>

/* ------------------------------------------------------------------ *
 * Filters
 * ------------------------------------------------------------------ */

/**
 * One rule: a field, an operator, and a value. Kept deliberately flat — the
 * builder shows exactly this, so anything expressible in the UI is expressible
 * here and nothing else is.
 */
export const FILTER_FIELDS = [
  'tags',
  'videoAuthors',
  'scriptAuthors',
  'studios',
  'playlists',
  'title',
  'durationMs',
  'fileSize',
  'rating',
  'favorite',
  'scriptCount',
  'multiAxis',
  'missing',
  'wanted',
  'addedAt',
  'sourceUrl',
  'folder'
] as const

export const FILTER_OPERATORS = [
  'includes',
  'excludes',
  'is',
  'isNot',
  'contains',
  'gt',
  'lt',
  'between',
  'isEmpty',
  'isNotEmpty'
] as const

export const FilterRuleSchema = z.looseObject({
  kind: z.literal('rule'),
  field: z.enum(FILTER_FIELDS),
  op: z.enum(FILTER_OPERATORS),
  /** Strings for names, numbers for ranges, booleans for flags. */
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
  /**
   * Tag rules only: a parent tag also matches everything under it, which is the
   * point of a hierarchy. Off for "this exact tag and nothing below it".
   */
  includeDescendants: z.boolean().optional()
})

export type FilterRule = z.infer<typeof FilterRuleSchema>

export interface FilterGroup {
  kind: 'group'
  /** `all` = every child must match; `any` = at least one. */
  match: 'all' | 'any'
  children: FilterNode[]
}

export type FilterNode = FilterRule | FilterGroup

export const FilterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.looseObject({
    kind: z.literal('group'),
    match: z.enum(['all', 'any']),
    children: z.array(FilterNodeSchema)
  })
)

export const FilterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([FilterRuleSchema, FilterGroupSchema])
)

/** An empty group matches everything, which is the unfiltered library. */
export function emptyFilter(): FilterGroup {
  return { kind: 'group', match: 'all', children: [] }
}

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

/**
 * A `folder` rule names folders as `<library id>/<library-relative path>`.
 *
 * The library has to travel with the path because a path alone means nothing:
 * every library has its own index and two of them can hold a `VR/180°`. Ids
 * carry no slash and a library-relative path never starts with one, so the
 * first slash splits the two apart; the library root is the empty path.
 */
export function folderRef(libraryId: string, path: string): string {
  return `${libraryId}/${path}`
}

export function parseFolderRef(ref: string): { libraryId: string; path: string } | null {
  const at = ref.indexOf('/')
  if (at <= 0) return null
  return { libraryId: ref.slice(0, at), path: ref.slice(at + 1) }
}
