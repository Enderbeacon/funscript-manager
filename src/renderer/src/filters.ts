import { NAME_FIELDS, type NameField } from '@shared/schemas/media-meta'
import { parseFolderRef, type FilterNode, type FilterRule } from '@shared/schemas/taxonomy'

/**
 * The filter sidebar's state, and how it becomes a filter the main side can
 * run.
 *
 * Two inputs produce one filter: the sidebar, which is structured because its
 * controls are, and the condition builder, which is a free tree. They are
 * ANDed — ticking VR in the sidebar narrows whatever the builder already said,
 * which is what someone doing both at once expects.
 *
 * The condition row above the grid is generated from this same state, so
 * anything showing there can be removed there.
 */

/**
 * The name kinds the sidebar draws rows for, and the chip editors offer.
 *
 * `playlists` is deliberately absent. It is still a name field — filtering by
 * one, renaming one, counting one all go through the same machinery — but a
 * playlist is a place you go rather than a property of the media, so it lives
 * in the panel on the right with the rest of the playing controls. It is also
 * ordered, and adding to it has to work out where in the order the media goes,
 * which the generic "add a name" chip cannot do.
 *
 * The sidebar *state* still carries all five: a playlist picked in that panel
 * narrows the grid through the same filter as everything else.
 */
export const NAME_FIELDS_UI: NameField[] = ['tags', 'videoAuthors', 'scriptAuthors', 'studios']

export interface NameFilter {
  include: string[]
  exclude: string[]
  /** Applies to `include` only; excluding two names always means neither. */
  match: 'all' | 'any'
}

/**
 * Folders picked in the sidebar, as `<library id>/<path>` (see `folderRef`).
 *
 * No `match` here, unlike a name filter: a media sits in exactly one folder, so
 * "all of them" would always come back empty. Several picks always mean any of
 * them.
 */
export interface FolderFilter {
  include: string[]
  exclude: string[]
}

export interface SidebarState {
  names: Record<NameField, NameFilter>
  folders: FolderFilter
  /**
   * As typed, not as parsed: someone who wrote `1h30m` gets `1h30m` back when
   * they return to the box. Empty — or unreadable — is open-ended.
   */
  duration: { min: string; max: string }
  /** Minimum stars, null = any. */
  rating: number | null
  flags: {
    multiAxis: boolean
    multiVersion: boolean
    noScript: boolean
    wanted: boolean
    favorite: boolean
  }
}

export function emptySidebar(): SidebarState {
  const names = {} as Record<NameField, NameFilter>
  // Every field, not just the ones with a row in the sidebar — a playlist
  // picked in the right-hand panel writes here too.
  for (const field of NAME_FIELDS) names[field] = { include: [], exclude: [], match: 'all' }
  return {
    names,
    folders: { include: [], exclude: [] },
    duration: { min: '', max: '' },
    rating: null,
    flags: { multiAxis: false, multiVersion: false, noScript: false, wanted: false, favorite: false }
  }
}

export function isEmptySidebar(state: SidebarState): boolean {
  return (
    NAME_FIELDS.every((f) => state.names[f].include.length === 0 && state.names[f].exclude.length === 0) &&
    state.folders.include.length === 0 &&
    state.folders.exclude.length === 0 &&
    state.duration.min.trim() === '' &&
    state.duration.max.trim() === '' &&
    state.rating === null &&
    !Object.values(state.flags).some(Boolean)
  )
}

const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 }

/**
 * A length as the sidebar takes it, in seconds.
 *
 * A bare number is minutes — that is what people reach for when they mean "an
 * hour and a half" — and anything carrying its own unit is taken at its word:
 * `2h`, `45s`, `1h30m`, in any combination. Null covers both an empty box and
 * something unreadable, which the box says for itself.
 */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!value) return null
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 60)
  if (!/^(\d+(\.\d+)?[hms])+$/.test(value)) return null
  let total = 0
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
    total += Number(amount) * UNIT_SECONDS[unit!]!
  }
  return Math.round(total)
}

/** The short form a summary shows: 1h30m, 45s, 2h. */
export function formatDuration(seconds: number): string {
  const parts: string[] = []
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.round(seconds % 60)
  if (hours) parts.push(`${hours}h`)
  if (minutes) parts.push(`${minutes}m`)
  if (rest) parts.push(`${rest}s`)
  return parts.join('') || '0m'
}

/**
 * Picking names, one gesture each.
 *
 * The left button used to cycle include → exclude → off, which made excluding
 * something the price of un-picking it: the common gesture, clicking a name off
 * again, ran through a state nobody asked for. So the two decisions are now two
 * buttons — left picks, right excludes — and each is its own toggle.
 */

const has = (list: string[], name: string): boolean =>
  list.some((n) => n.toLowerCase() === name.toLowerCase())

const without = (list: string[], name: string): string[] =>
  list.filter((n) => n.toLowerCase() !== name.toLowerCase())

/** Left click: picked, then not. */
export function toggleName(current: NameFilter, name: string): NameFilter {
  if (has(current.include, name)) return { ...current, include: without(current.include, name) }
  // Picking something currently excluded means picking it, not stacking both.
  return { ...current, include: [...current.include, name], exclude: without(current.exclude, name) }
}

/** Right click: excluded, then not. */
export function toggleExclude(current: NameFilter, name: string): NameFilter {
  if (has(current.exclude, name)) return { ...current, exclude: without(current.exclude, name) }
  return { ...current, exclude: [...current.exclude, name], include: without(current.include, name) }
}

/** Every name and folder pick cleared, keeping the match modes. */
function clearedPicks(state: SidebarState): Pick<SidebarState, 'names' | 'folders'> {
  const names = {} as Record<NameField, NameFilter>
  for (const other of NAME_FIELDS) {
    names[other] = { include: [], exclude: [], match: state.names[other].match }
  }
  return { names, folders: { include: [], exclude: [] } }
}

/**
 * Alt+left click: this name and nothing else. Every other name goes, across all
 * five kinds, and so does every folder — the gesture is "show me just this",
 * and leaving an author ticked three groups down would quietly make it a lie.
 * Duration, rating and the script flags are separate controls and are left
 * alone.
 */
export function soloName(state: SidebarState, field: NameField, name: string): SidebarState {
  const cleared = clearedPicks(state)
  cleared.names[field] = { ...cleared.names[field]!, include: [name] }
  return { ...state, ...cleared }
}

/** The same gesture on a folder row. */
export function soloFolder(state: SidebarState, ref: string): SidebarState {
  const cleared = clearedPicks(state)
  return { ...state, ...cleared, folders: { include: [ref], exclude: [] } }
}

/**
 * The same three gestures wherever a name is shown — the sidebar, a card's
 * tags, the detail panel's chips. Written once here so a tag behaves the same
 * whichever of them it was clicked in.
 */
export type NamePick = 'toggle' | 'exclude' | 'solo'

export function namePickFromEvent(e: {
  type: string
  altKey: boolean
  detail: number
}): NamePick {
  if (e.type === 'contextmenu') return 'exclude'
  // `detail` is the click count, so the second click of a double click means
  // the same as Alt. The first one has already run its toggle — that is what
  // keeps a single click immediate — and soloing overwrites it.
  return e.altKey || e.detail >= 2 ? 'solo' : 'toggle'
}

export function applyNamePick(
  state: SidebarState,
  field: NameField,
  name: string,
  pick: NamePick
): SidebarState {
  if (pick === 'solo') return soloName(state, field, name)
  const current = state.names[field]
  return {
    ...state,
    names: {
      ...state.names,
      [field]: pick === 'exclude' ? toggleExclude(current, name) : toggleName(current, name)
    }
  }
}

/** The same three gestures on a folder row; refs are matched case-insensitively
 *  because a Windows path is the same folder however it was typed. */
export function applyFolderPick(state: SidebarState, ref: string, pick: NamePick): SidebarState {
  if (pick === 'solo') return soloFolder(state, ref)
  const current = state.folders
  const folders =
    pick === 'exclude'
      ? has(current.exclude, ref)
        ? { ...current, exclude: without(current.exclude, ref) }
        : { include: without(current.include, ref), exclude: [...current.exclude, ref] }
      : has(current.include, ref)
        ? { ...current, include: without(current.include, ref) }
        : { include: [...current.include, ref], exclude: without(current.exclude, ref) }
  return { ...state, folders }
}

/**
 * Folder picks belonging to other libraries, dropped.
 *
 * Called when the page narrows to one library: a pick naming a folder that is
 * no longer anywhere in the list would keep filtering with no row on screen
 * showing why, and it can only ever match nothing.
 */
export function keepFoldersIn(state: SidebarState, libraryId: string): SidebarState {
  const mine = (ref: string): boolean => parseFolderRef(ref)?.libraryId === libraryId
  const include = state.folders.include.filter(mine)
  const exclude = state.folders.exclude.filter(mine)
  if (include.length === state.folders.include.length && exclude.length === state.folders.exclude.length) {
    return state
  }
  return { ...state, folders: { include, exclude } }
}

/** Sidebar + builder → one filter, or null when nothing is narrowed. */
export function toFilterNode(state: SidebarState, advanced: FilterNode | null): FilterNode | null {
  const children: FilterNode[] = []

  for (const field of NAME_FIELDS) {
    const { include, exclude, match } = state.names[field]
    if (include.length > 0) {
      // `all` means every name must be present, which is one rule each; `any`
      // is a single rule holding the whole list.
      if (match === 'all') {
        for (const name of include) {
          children.push({ kind: 'rule', field, op: 'includes', value: [name], includeDescendants: true })
        }
      } else {
        children.push({ kind: 'rule', field, op: 'includes', value: include, includeDescendants: true })
      }
    }
    if (exclude.length > 0) {
      children.push({ kind: 'rule', field, op: 'excludes', value: exclude, includeDescendants: true })
    }
  }

  // One rule for the lot: several folders mean any of them, since a media sits
  // in exactly one.
  if (state.folders.include.length > 0) {
    children.push({ kind: 'rule', field: 'folder', op: 'includes', value: state.folders.include })
  }
  if (state.folders.exclude.length > 0) {
    children.push({ kind: 'rule', field: 'folder', op: 'excludes', value: state.folders.exclude })
  }

  const min = parseDuration(state.duration.min)
  const max = parseDuration(state.duration.max)
  if (min !== null || max !== null) {
    children.push({
      kind: 'rule',
      field: 'durationMs',
      op: 'between',
      value: [min === null ? 0 : min * 1000, max === null ? Number.MAX_SAFE_INTEGER : max * 1000]
    })
  }
  if (state.rating !== null) {
    children.push({ kind: 'rule', field: 'rating', op: 'gt', value: state.rating - 1 })
  }
  if (state.flags.multiAxis) children.push({ kind: 'rule', field: 'multiAxis', op: 'is', value: true })
  if (state.flags.multiVersion) children.push({ kind: 'rule', field: 'scriptCount', op: 'gt', value: 1 })
  if (state.flags.noScript) children.push({ kind: 'rule', field: 'scriptCount', op: 'lt', value: 1 })
  if (state.flags.wanted) children.push({ kind: 'rule', field: 'wanted', op: 'is', value: true })
  if (state.flags.favorite) children.push({ kind: 'rule', field: 'favorite', op: 'is', value: true })

  if (advanced) children.push(advanced)
  if (children.length === 0) return null
  return { kind: 'group', match: 'all', children }
}

/* ------------------------------------------------------------------ *
 * The condition row
 * ------------------------------------------------------------------ */

export interface Pill {
  id: string
  /** Which control it came from, so the row can label it. */
  kind: NameField | 'folder' | 'duration' | 'rating' | 'flag' | 'advanced'
  label: string
  negated: boolean
}

type Label = (key: string, params?: Record<string, unknown>) => string

/** The length being asked for, in the short form; null when neither end is set. */
export function durationLabel(state: SidebarState, label: Label): string | null {
  const min = parseDuration(state.duration.min)
  const max = parseDuration(state.duration.max)
  if (min === null && max === null) return null
  if (min !== null && max !== null) {
    return label('media.filter.durationRange', {
      min: formatDuration(min),
      max: formatDuration(max)
    })
  }
  return min !== null
    ? label('media.filter.durationFrom', { min: formatDuration(min) })
    : label('media.filter.durationTo', { max: formatDuration(max!) })
}

/**
 * What the attributes block is narrowing, in the same words as the pills.
 * Folded away, this is all the block can say for itself — and a control that
 * is filtering silently is why people think the app is broken.
 */
export function attributeLabels(state: SidebarState, label: Label): string[] {
  const out: string[] = []
  const duration = durationLabel(state, label)
  if (duration) out.push(duration)
  if (state.rating !== null) out.push(label('media.filter.ratingAtLeast', { n: state.rating }))
  for (const flag of ['multiAxis', 'multiVersion'] as const) {
    if (state.flags[flag]) out.push(label(`media.filter.flag.${flag}`))
  }
  return out
}

export function describePills(
  state: SidebarState,
  advanced: FilterNode | null,
  label: (key: string, params?: Record<string, unknown>) => string,
  /** A folder ref as the user knows it; only the page has the library names. */
  folderLabel: (ref: string) => string = defaultFolderLabel
): Pill[] {
  const pills: Pill[] = []
  for (const field of NAME_FIELDS) {
    for (const name of state.names[field].include) {
      pills.push({ id: `${field}:+${name}`, kind: field, label: name, negated: false })
    }
    for (const name of state.names[field].exclude) {
      pills.push({ id: `${field}:-${name}`, kind: field, label: name, negated: true })
    }
  }
  for (const ref of state.folders.include) {
    pills.push({ id: `folder:+${ref}`, kind: 'folder', label: folderLabel(ref), negated: false })
  }
  for (const ref of state.folders.exclude) {
    pills.push({ id: `folder:-${ref}`, kind: 'folder', label: folderLabel(ref), negated: true })
  }
  const duration = durationLabel(state, label)
  if (duration) pills.push({ id: 'duration', kind: 'duration', label: duration, negated: false })
  if (state.rating !== null) {
    pills.push({ id: 'rating', kind: 'rating', label: label('media.filter.ratingAtLeast', { n: state.rating }), negated: false })
  }
  for (const [flag, on] of Object.entries(state.flags)) {
    if (on) pills.push({ id: `flag:${flag}`, kind: 'flag', label: label(`media.filter.flag.${flag}`), negated: false })
  }
  if (advanced) {
    pills.push({
      id: 'advanced',
      kind: 'advanced',
      label: label('media.filter.advancedCount', { n: countRules(advanced) }),
      negated: false
    })
  }
  return pills
}

export function countRules(node: FilterNode): number {
  return node.kind === 'rule' ? 1 : node.children.reduce((n, c) => n + countRules(c), 0)
}

/** The path alone, for callers with no library names to hand. */
function defaultFolderLabel(ref: string): string {
  return parseFolderRef(ref)?.path || ref
}

/** Undo one pill; the id is the same one `describePills` handed out. */
export function removePill(state: SidebarState, id: string): SidebarState {
  if (id === 'duration') return { ...state, duration: { min: '', max: '' } }
  if (id === 'rating') return { ...state, rating: null }
  if (id.startsWith('flag:')) {
    const flag = id.slice(5) as keyof SidebarState['flags']
    return { ...state, flags: { ...state.flags, [flag]: false } }
  }
  // Folders first: a ref carries a path, which may hold the colon this split
  // is looking for.
  if (id.startsWith('folder:')) {
    const rest = id.slice('folder:'.length)
    const ref = rest.slice(1)
    const drop = (list: string[]): string[] => list.filter((r) => r !== ref)
    return {
      ...state,
      folders:
        rest[0] === '+'
          ? { ...state.folders, include: drop(state.folders.include) }
          : { ...state.folders, exclude: drop(state.folders.exclude) }
    }
  }
  const [field, rest] = id.split(':')
  if (!field || !rest) return state
  const sign = rest[0]
  const name = rest.slice(1)
  const current = state.names[field as NameField]
  if (!current) return state
  const drop = (list: string[]): string[] => list.filter((n) => n !== name)
  return {
    ...state,
    names: {
      ...state.names,
      [field]: sign === '+' ? { ...current, include: drop(current.include) } : { ...current, exclude: drop(current.exclude) }
    }
  }
}

/** A rule with sensible defaults, for the builder's "add condition". */
export function newRule(): FilterRule {
  return { kind: 'rule', field: 'tags', op: 'includes', value: '' }
}
