import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { app, shell } from 'electron'
import { AppError } from '@shared/errors'
import {
  ENTITY_KINDS,
  TaxonomyFileSchema,
  type Entity,
  type EntityKind,
  type FilterNode,
  type TaxonomyFile
} from '@shared/schemas/taxonomy'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'
import { setAsideUnreadable } from '../../util/persisted'

/**
 * The tag tree, the author and studio lists, the playlists, and the filters
 * the user saved — everything that gives the names in sidecars a structure.
 *
 * Persisted as one app-level `taxonomy.json`. It is authored data, not a
 * cache: writes are atomic, and a file that fails to parse is replaced with an
 * empty one rather than thrown away silently — the names themselves are in the
 * sidecars and nothing is lost but the arrangement.
 *
 * Entities are created on demand: naming a tag on a media that the taxonomy
 * has never heard of is normal, and the tree simply gains a top-level entry.
 */

export const taxonomyEvents = new EventEmitter()

function filePath(): string {
  return join(app.getPath('userData'), 'taxonomy.json')
}

let cache: TaxonomyFile | null = null

export async function getTaxonomy(): Promise<TaxonomyFile> {
  if (cache) return cache
  const raw = await readJsonOr(filePath(), {})
  const parsed = TaxonomyFileSchema.safeParse(raw)
  if (!parsed.success) {
    // Starting empty is survivable; overwriting the user's whole vocabulary
    // with empty is not, and the next edit would do exactly that.
    console.warn('[taxonomy] taxonomy.json did not validate:', parsed.error.issues)
    await setAsideUnreadable(filePath())
  }
  cache = parsed.success ? parsed.data : TaxonomyFileSchema.parse({})
  return cache
}

async function save(next: TaxonomyFile): Promise<TaxonomyFile> {
  cache = TaxonomyFileSchema.parse(next)
  await atomicWriteJson(filePath(), cache)
  taxonomyEvents.emit('changed')
  return cache
}

function lower(value: string): string {
  return value.trim().toLowerCase()
}

function assertKind(kind: string): asserts kind is EntityKind {
  if (!(ENTITY_KINDS as readonly string[]).includes(kind)) {
    throw new AppError('taxonomy_unknown_kind', { kind })
  }
}

/* ------------------------------------------------------------------ *
 * The write lock
 * ------------------------------------------------------------------ */

/**
 * Every write runs on its own.
 *
 * All of them read the whole file, decide, and write the whole thing back, with
 * awaits in the middle. Two in flight read the same list, and the second write
 * puts back a version computed before the first one existed — the earlier edit
 * is simply gone, with nothing on screen to say so. Renames and merges make it
 * worse: they spend a long time rewriting sidecars, and the taxonomy is only
 * touched at the end.
 *
 * So writes queue. The lock is reentrant, because a caller holding it does
 * reach back in here — rewriting a sidecar registers names, and setting a cover
 * updates the entity — and a plain queue would wait for itself forever.
 */
let writes: Promise<unknown> = Promise.resolve()
const holding = new AsyncLocalStorage<true>()

export function withTaxonomyLock<T>(work: () => Promise<T>): Promise<T> {
  if (holding.getStore()) return work()
  const run = writes.then(() => holding.run(true, work))
  // Keep the queue alive when one write throws.
  writes = run.catch(() => undefined)
  return run
}

export async function listEntities(kind: EntityKind): Promise<Entity[]> {
  const taxonomy = await getTaxonomy()
  return taxonomy.entities[kind]
}

/**
 * Names in a kind, in tree order (parents before their children), so the UI
 * can render a tree without walking the list itself.
 */
export function orderTree(entities: Entity[]): { entity: Entity; depth: number }[] {
  const byParent = new Map<string, Entity[]>()
  const known = new Set(entities.map((e) => lower(e.name)))
  for (const entity of entities) {
    // A parent that no longer exists would hide its children entirely; treat
    // it as top level instead.
    const key = entity.parent && known.has(lower(entity.parent)) ? lower(entity.parent) : ''
    byParent.set(key, [...(byParent.get(key) ?? []), entity])
  }
  const sort = (list: Entity[]): Entity[] =>
    [...list].sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name))

  const out: { entity: Entity; depth: number }[] = []
  const walk = (parentKey: string, depth: number, seen: Set<string>): void => {
    for (const entity of sort(byParent.get(parentKey) ?? [])) {
      const key = lower(entity.name)
      if (seen.has(key)) continue // a cycle survived an edit; show it once
      seen.add(key)
      out.push({ entity, depth })
      walk(key, depth + 1, seen)
    }
  }
  walk('', 0, new Set())
  return out
}

/** Every name at or below `name`, for a tag rule that includes descendants. */
export function withDescendants(entities: Entity[], name: string): string[] {
  const children = new Map<string, string[]>()
  for (const entity of entities) {
    if (!entity.parent) continue
    const key = lower(entity.parent)
    children.set(key, [...(children.get(key) ?? []), entity.name])
  }
  const out: string[] = []
  const walk = (current: string, seen: Set<string>): void => {
    const key = lower(current)
    if (seen.has(key)) return
    seen.add(key)
    out.push(current)
    for (const child of children.get(key) ?? []) walk(child, seen)
  }
  walk(name, new Set())
  return out
}

/**
 * Resolve `includeDescendants` on every rule that carries it: a rule naming a
 * parent becomes a rule naming the parent and everything under it.
 *
 * The SQL compiler expects this to have happened already — it matches names
 * literally, and only the taxonomy knows the tree. Without this pass, filtering
 * on a parent tag asked for media carrying that exact name, which is normally
 * none of them: the parent is the heading, the children are what media wear.
 */
export async function expandFilter(node: FilterNode | null | undefined): Promise<FilterNode | null> {
  if (!node) return null
  const taxonomy = await getTaxonomy()

  const expand = (current: FilterNode): FilterNode => {
    if (current.kind === 'group') return { ...current, children: current.children.map(expand) }
    if (!current.includeDescendants) return current
    if (!(ENTITY_KINDS as readonly string[]).includes(current.field)) return current

    const entities = taxonomy.entities[current.field as EntityKind]
    const raw = Array.isArray(current.value)
      ? current.value
      : current.value === undefined
        ? []
        : [current.value]
    // A name rule carries names; a stray boolean is not one, and has no tree.
    const values = raw.filter((v): v is string => typeof v === 'string')
    if (values.length !== raw.length) return current

    const out: string[] = []
    const seen = new Set<string>()
    for (const value of values) {
      for (const name of withDescendants(entities, value)) {
        if (seen.has(lower(name))) continue
        seen.add(lower(name))
        out.push(name)
      }
    }
    return { ...current, value: out }
  }

  return expand(node)
}

/**
 * The canonical name for something the user typed or a post supplied: an exact
 * match wins, then an alias. Unknown names come back unchanged — they are new
 * entities, not errors.
 */
export async function canonicalName(kind: EntityKind, name: string): Promise<string> {
  const entities = await listEntities(kind)
  const target = lower(name)
  const exact = entities.find((e) => lower(e.name) === target)
  if (exact) return exact.name
  const aliased = entities.find((e) => e.aliases.some((a) => lower(a) === target))
  return aliased?.name ?? name.trim()
}

/** Make sure every name exists as an entity, adding the ones that do not. */
export async function ensureEntities(kind: EntityKind, names: string[]): Promise<void> {
  assertKind(kind)
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    const existing = new Set(taxonomy.entities[kind].map((e) => lower(e.name)))
    const missing = names.map((n) => n.trim()).filter((n) => n && !existing.has(lower(n)))
    if (missing.length === 0) return
    const added = [...new Set(missing.map(lower))].map(
      (key) => ({ name: missing.find((n) => lower(n) === key)!, aliases: [] }) satisfies Entity
    )
    await save({
      ...taxonomy,
      entities: { ...taxonomy.entities, [kind]: [...taxonomy.entities[kind], ...added] }
    })
  })
}

function dedupeNames(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/**
 * Canonicalise a list of names, drop duplicates, and register anything new.
 *
 * Every path that writes names into a sidecar goes through here — the detail
 * panel, batch editing, and the post ingest alike. The ingest used to skip it,
 * which meant a tag that arrived with a download existed on the media and
 * nowhere else: not in the taxonomy, so not in the filter sidebar, and an alias
 * from a forum post landed beside the canonical name instead of on it.
 */
export async function normaliseNames(kind: EntityKind, names: string[]): Promise<string[]> {
  const final = await canonicalNames(kind, names)
  await ensureEntities(kind, final)
  return final
}

/** What `normaliseNames` would write, without registering anything. */
export async function canonicalNames(kind: EntityKind, names: string[]): Promise<string[]> {
  assertKind(kind)
  const canonical = await Promise.all(dedupeNames(names).map((n) => canonicalName(kind, n)))
  return dedupeNames(canonical)
}

export interface EntityPatch {
  name?: string
  parent?: string | null
  aliases?: string[]
  description?: string
  image?: string
  order?: number
}

/** Would setting `parent` on `name` make a loop? */
function wouldCycle(entities: Entity[], name: string, parent: string): boolean {
  const byName = new Map(entities.map((e) => [lower(e.name), e]))
  let current: string | undefined = parent
  const seen = new Set<string>()
  while (current) {
    const key = lower(current)
    if (key === lower(name)) return true
    if (seen.has(key)) return true
    seen.add(key)
    current = byName.get(key)?.parent
  }
  return false
}

/**
 * Edit one entity. Renaming returns the pair of names so the caller can rewrite
 * the sidecars that carry the old one — this service only owns the structure.
 */
export async function updateEntity(
  kind: EntityKind,
  name: string,
  patch: EntityPatch
): Promise<{ renamedFrom: string | null; entity: Entity }> {
  assertKind(kind)
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    const list = taxonomy.entities[kind]
    const index = list.findIndex((e) => lower(e.name) === lower(name))
    if (index === -1) throw new AppError('taxonomy_not_found', { kind, name })

    const current = list[index]!
    const nextName = patch.name?.trim() || current.name
    if (
      lower(nextName) !== lower(current.name) &&
      list.some((e) => lower(e.name) === lower(nextName))
    ) {
      throw new AppError('taxonomy_name_taken', { name: nextName })
    }
    const nextParent = patch.parent === null ? undefined : (patch.parent?.trim() || current.parent)
    if (nextParent && wouldCycle(list, nextName, nextParent)) {
      throw new AppError('taxonomy_cycle', { name: nextName, parent: nextParent })
    }

    const entity: Entity = {
      ...current,
      name: nextName,
      ...(nextParent ? { parent: nextParent } : {}),
      ...(patch.aliases ? { aliases: patch.aliases.map((a) => a.trim()).filter(Boolean) } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.image !== undefined ? { image: patch.image } : {}),
      ...(patch.order !== undefined ? { order: patch.order } : {})
    }
    if (!nextParent) delete (entity as { parent?: string }).parent

    const renamed = lower(nextName) !== lower(current.name)
    const next = list.map((e, i) => {
      if (i === index) return entity
      // Children follow a rename, or they would all detach at once.
      return renamed && e.parent && lower(e.parent) === lower(current.name)
        ? { ...e, parent: nextName }
        : e
    })

    await save({ ...taxonomy, entities: { ...taxonomy.entities, [kind]: next } })
    return { renamedFrom: renamed ? current.name : null, entity }
  })
}

export async function createEntity(kind: EntityKind, name: string, parent?: string): Promise<Entity> {
  assertKind(kind)
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    const trimmed = name.trim()
    if (!trimmed) throw new AppError('taxonomy_name_required')
    if (taxonomy.entities[kind].some((e) => lower(e.name) === lower(trimmed))) {
      throw new AppError('taxonomy_name_taken', { name: trimmed })
    }
    const entity: Entity = { name: trimmed, aliases: [], ...(parent ? { parent } : {}) }
    await save({
      ...taxonomy,
      entities: { ...taxonomy.entities, [kind]: [...taxonomy.entities[kind], entity] }
    })
    return entity
  })
}

/**
 * Remove an entity from the taxonomy. Children move up to its parent rather
 * than disappearing with it. The caller strips the name from sidecars.
 */
export async function deleteEntity(kind: EntityKind, name: string): Promise<void> {
  assertKind(kind)
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    const list = taxonomy.entities[kind]
    const target = list.find((e) => lower(e.name) === lower(name))
    if (!target) return
    const next = list
      .filter((e) => e !== target)
      .map((e) =>
        e.parent && lower(e.parent) === lower(name)
          ? target.parent
            ? { ...e, parent: target.parent }
            : (({ parent: _p, ...rest }) => rest)(e)
          : e
      )
    await save({ ...taxonomy, entities: { ...taxonomy.entities, [kind]: next } })
  })
}

/**
 * Fold `from` into `into`: the survivor takes the loser's aliases and its old
 * name as one more alias, so anything importing the old spelling still lands
 * correctly. The caller rewrites the sidecars.
 */
export async function mergeEntities(kind: EntityKind, from: string, into: string): Promise<void> {
  assertKind(kind)
  if (lower(from) === lower(into)) return
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    const list = taxonomy.entities[kind]
    const loser = list.find((e) => lower(e.name) === lower(from))
    const winner = list.find((e) => lower(e.name) === lower(into))
    if (!loser || !winner) {
      throw new AppError('taxonomy_not_found', { kind, name: loser ? into : from })
    }

    const aliases = [...new Set([...winner.aliases, ...loser.aliases, loser.name])]
    const next = list
      .filter((e) => e !== loser)
      .map((e) => {
        if (e === winner) return { ...winner, aliases }
        // The loser's children become the winner's.
        return e.parent && lower(e.parent) === lower(from) ? { ...e, parent: winner.name } : e
      })
    await save({ ...taxonomy, entities: { ...taxonomy.entities, [kind]: next } })
  })
}

/* ------------------------------------------------------------------ *
 * Saved filters
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------- cover pictures */

/**
 * Covers live beside taxonomy.json rather than in a library: the taxonomy is
 * app-level, and a picture kept where the user happened to pick it from would
 * be one tidy-up away from a broken cover on every entity that used it.
 */
function imagesDir(): string {
  return join(app.getPath('userData'), 'taxonomy-images')
}

const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif'
}

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME).map((e) => e.slice(1))

async function readAsDataUrl(abs: string): Promise<string | null> {
  const mime = IMAGE_MIME[extname(abs).toLowerCase()]
  if (!mime) return null
  try {
    const bytes = await readFile(abs)
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** The stored file for an entity, or null when it has no cover. */
async function imagePathOf(kind: EntityKind, name: string): Promise<string | null> {
  assertKind(kind)
  const list = (await getTaxonomy()).entities[kind]
  const entity = list.find((e) => lower(e.name) === lower(name))
  if (!entity?.image) return null
  return isAbsolute(entity.image) ? entity.image : join(imagesDir(), entity.image)
}

export async function getEntityImage(kind: EntityKind, name: string): Promise<string | null> {
  const abs = await imagePathOf(kind, name)
  return abs === null ? null : readAsDataUrl(abs)
}

/**
 * Copy a picked image in and point the entity at it. A null source clears the
 * cover; the file it used is trashed rather than unlinked, since it may be the
 * user's only copy of a picture they cropped for this.
 */
export async function setEntityImage(
  kind: EntityKind,
  name: string,
  sourcePath: string | null
): Promise<string | null> {
  assertKind(kind)
  return withTaxonomyLock(async () => {
    const previous = await imagePathOf(kind, name)

    if (sourcePath === null) {
      await updateEntity(kind, name, { image: '' })
      if (previous && previous.startsWith(imagesDir())) {
        await shell.trashItem(previous).catch(() => {})
      }
      return null
    }

    const ext = extname(sourcePath).toLowerCase()
    if (!IMAGE_MIME[ext]) throw new AppError('invalid_file_name')

    // Named by a fresh id rather than by the entity: renaming a tag must not
    // leave its cover behind, and two entities must never race for one file name.
    const fileName = `${randomUUID()}${ext}`
    await mkdir(imagesDir(), { recursive: true })
    await copyFile(sourcePath, join(imagesDir(), fileName))
    await updateEntity(kind, name, { image: fileName })

    if (previous && previous.startsWith(imagesDir())) {
      await rm(previous).catch(() => {})
    }
    return readAsDataUrl(join(imagesDir(), fileName))
  })
}

export async function saveFilter(name: string, filter: FilterNode): Promise<{ id: string }> {
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    const id = randomUUID()
    await save({
      ...taxonomy,
      savedFilters: [
        ...taxonomy.savedFilters,
        { id, name: name.trim() || 'Filter', filter, createdAt: new Date().toISOString() }
      ]
    })
    return { id }
  })
}

export async function deleteFilter(id: string): Promise<void> {
  return withTaxonomyLock(async () => {
    const taxonomy = await getTaxonomy()
    await save({ ...taxonomy, savedFilters: taxonomy.savedFilters.filter((f) => f.id !== id) })
  })
}
