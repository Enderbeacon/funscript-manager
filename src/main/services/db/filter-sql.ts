import { parseFolderRef, type FilterNode, type FilterRule } from '@shared/schemas/taxonomy'

/**
 * Filter tree → SQL, for the advanced search's nested AND/OR conditions.
 *
 * Every rule becomes a condition on `m.id`, so a group is nothing more than
 * AND/OR over those conditions and nesting costs nothing. Values are always
 * bound, never interpolated: the names come from the user's own library, but
 * they still travel through a text field.
 *
 * `includeDescendants` is resolved before this runs — the caller expands a tag
 * to itself plus everything under it, because only the taxonomy knows the tree.
 *
 * One rule needs to know which library it is being compiled for: a folder is
 * named by a path, and a path only means something inside one library. Every
 * other rule ignores it.
 */

/** Which table holds each name kind. */
const NAME_TABLE: Record<string, string> = {
  tags: 'media_tag',
  videoAuthors: 'media_video_author',
  scriptAuthors: 'media_script_author',
  studios: 'media_studio',
  playlists: 'media_playlist'
}

export interface CompiledFilter {
  /** A boolean SQL expression over alias `m`; `1` when nothing is filtered. */
  sql: string
  params: Record<string, unknown>
}

class Binder {
  private n = 0
  readonly params: Record<string, unknown> = {}
  bind(value: unknown): string {
    const key = `p${this.n++}`
    this.params[key] = value
    return `@${key}`
  }
}

/** `EXISTS (SELECT 1 FROM <table> WHERE media_id = m.id AND name IN (…))`. */
function nameExists(table: string, values: string[], binder: Binder): string {
  if (values.length === 0) return '0'
  const list = values.map((v) => binder.bind(v)).join(', ')
  return `EXISTS (SELECT 1 FROM ${table} x WHERE x.media_id = m.id AND x.name IN (${list}))`
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (value === undefined || value === null || value === '') return []
  return [String(value)]
}

function numeric(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** A per-media count of script versions, used by two different rules. */
const SCRIPT_COUNT = '(SELECT COUNT(*) FROM script_version sv WHERE sv.media_id = m.id)'

/** LIKE reads `%` and `_` as wildcards, and folder names are full of both. */
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/**
 * Media filed under any of these folders, subfolders included.
 *
 * Folders belonging to another library are dropped rather than matched loosely:
 * this expression only ever runs against one library's index, and a path from a
 * different one says nothing about the rows here. Picking folders in two
 * libraries therefore leaves each index answering only for its own.
 */
function underFolders(refs: string[], libraryId: string, binder: Binder): string {
  const paths: string[] = []
  for (const ref of refs) {
    const parsed = parseFolderRef(ref)
    if (!parsed || parsed.libraryId !== libraryId) continue
    // The root holds everything, so it cannot be narrowed any further.
    if (parsed.path === '') return '1'
    paths.push(parsed.path)
  }
  if (paths.length === 0) return '0'
  const parts = paths.map((path) => {
    const prefix = binder.bind(`${likeLiteral(path)}/%`)
    return `m.file_path LIKE ${prefix} ESCAPE '\\'`
  })
  return `(${parts.join(' OR ')})`
}

function compileRule(rule: FilterRule, binder: Binder, libraryId: string): string {
  const { field, op, value } = rule

  const table = NAME_TABLE[field]
  if (table) {
    const values = asArray(value)
    switch (op) {
      case 'includes':
      case 'is':
        return nameExists(table, values, binder)
      case 'excludes':
      case 'isNot':
        return values.length === 0 ? '1' : `NOT ${nameExists(table, values, binder)}`
      case 'isEmpty':
        return `NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.media_id = m.id)`
      case 'isNotEmpty':
        return `EXISTS (SELECT 1 FROM ${table} x WHERE x.media_id = m.id)`
      default:
        return '1'
    }
  }

  switch (field) {
    case 'title': {
      const text = String(value ?? '')
      if (!text) return '1'
      const like = binder.bind(`%${text}%`)
      // The file name is part of the title as far as a person searching is
      // concerned; plenty of media never got one typed in.
      return `(COALESCE(m.title, '') LIKE ${like} OR m.file_path LIKE ${like})`
    }
    case 'sourceUrl': {
      const text = String(value ?? '')
      if (!text) return '1'
      return `EXISTS (SELECT 1 FROM media_source s WHERE s.media_id = m.id AND s.source_url LIKE ${binder.bind(`%${text}%`)})`
    }
    case 'durationMs':
    case 'fileSize':
    case 'rating':
    case 'scriptCount': {
      const column =
        field === 'durationMs'
          ? 'm.duration_ms'
          : field === 'fileSize'
            ? 'm.file_size'
            : field === 'rating'
              ? 'm.rating'
              : SCRIPT_COUNT
      if (op === 'between') {
        const [lo, hi] = Array.isArray(value) ? value : []
        const low = numeric(lo)
        const high = numeric(hi)
        if (low === null && high === null) return '1'
        const parts: string[] = []
        if (low !== null) parts.push(`${column} >= ${binder.bind(low)}`)
        if (high !== null) parts.push(`${column} <= ${binder.bind(high)}`)
        // A null column cannot satisfy a range; saying so beats matching it.
        return `(${column} IS NOT NULL AND ${parts.join(' AND ')})`
      }
      const n = numeric(value)
      if (n === null) return '1'
      if (op === 'gt') return `(${column} IS NOT NULL AND ${column} > ${binder.bind(n)})`
      if (op === 'lt') return `(${column} IS NOT NULL AND ${column} < ${binder.bind(n)})`
      return `${column} = ${binder.bind(n)}`
    }
    case 'favorite':
    case 'multiAxis':
    case 'missing':
    case 'wanted': {
      const wanted = value === undefined ? true : Boolean(value)
      const expr =
        field === 'multiAxis'
          ? `EXISTS (SELECT 1 FROM script_version sv WHERE sv.media_id = m.id AND sv.is_multi_axis = 1)`
          : field === 'favorite'
            ? 'm.favorite = 1'
            : field === 'missing'
              ? 'm.missing = 1'
              : 'm.wanted = 1'
      const negate = op === 'isNot' || op === 'excludes'
      return negate === wanted ? `NOT (${expr})` : expr
    }
    case 'addedAt': {
      const text = String(value ?? '')
      if (!text) return '1'
      const bound = binder.bind(text)
      if (op === 'lt') return `m.created_at < ${bound}`
      return `m.created_at > ${bound}`
    }
    case 'folder': {
      const refs = asArray(value)
      if (refs.length === 0) return op === 'excludes' || op === 'isNot' ? '1' : '0'
      const under = underFolders(refs, libraryId, binder)
      // Several folders always mean "any of them": a media sits in exactly one,
      // so requiring all of them would match nothing.
      if (op === 'excludes' || op === 'isNot') return under === '0' ? '1' : `NOT ${under}`
      return under
    }
    default:
      return '1'
  }
}

function compileNode(node: FilterNode, binder: Binder, libraryId: string): string {
  if (node.kind === 'rule') return compileRule(node, binder, libraryId)
  const parts = node.children
    .map((child) => compileNode(child, binder, libraryId))
    .filter((p) => p !== '1')
  // An empty group narrows nothing, whichever way it matches.
  if (parts.length === 0) return '1'
  return `(${parts.join(node.match === 'any' ? ' OR ' : ' AND ')})`
}

export function compileFilter(
  filter: FilterNode | null | undefined,
  libraryId: string
): CompiledFilter {
  if (!filter) return { sql: '1', params: {} }
  const binder = new Binder()
  const sql = compileNode(filter, binder, libraryId)
  return { sql, params: binder.params }
}
