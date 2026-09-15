import { rename } from 'node:fs/promises'

/**
 * Keeping a user's files safe from a build older than the one that wrote them.
 *
 * Going back a version is allowed — the updater offers it — so every file this
 * app owns can be read by a build that has never heard of half of it. Two
 * rules follow, and both live here:
 *
 * - **Nothing unknown is dropped.** Sidecars, library.json and taxonomy.json
 *   parse as loose shapes, so fields from a newer build survive being read and
 *   written back. Settings are validated strictly (their types are used as
 *   lookup keys all over the UI), so what parsing dropped is merged back in on
 *   the way out by `withUnknownKeys`.
 * - **Nothing unreadable is overwritten.** A file that fails to parse is moved
 *   aside before the app writes a fresh one in its place, so the user still has
 *   what they had. Without this, opening an older build once was enough to
 *   replace a whole tag tree with an empty one.
 */

/**
 * `parsed`, plus every key `raw` has that parsing left behind — recursively,
 * for plain objects. Arrays are taken as parsed: their items cannot be paired
 * up reliably, and a merged-in item would be one the app never validated.
 */
export function withUnknownKeys<T>(parsed: T, raw: unknown): T {
  if (!isPlainObject(parsed) || !isPlainObject(raw)) return parsed
  const out: Record<string, unknown> = { ...parsed }
  for (const [key, value] of Object.entries(raw)) {
    if (!(key in out)) out[key] = value
    else out[key] = withUnknownKeys(out[key], value)
  }
  return out as T
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Move a file that could not be read out of the way, so that writing its path
 * again does not destroy it.
 *
 * One copy per file, and the latest failure wins it: each unreadable file is
 * the newest state of that data, and a copy from an earlier failure is by then
 * older than what the app itself has written since.
 */
export async function setAsideUnreadable(path: string): Promise<void> {
  const kept = `${path}.unreadable`
  try {
    await rename(path, kept)
    console.warn(`[persisted] ${path} could not be read; the file is now at ${kept}`)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    console.error(`[persisted] ${path} could not be read, and could not be moved aside:`, e)
  }
}
