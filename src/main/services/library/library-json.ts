import { join } from 'node:path'
import { LIBRARY_CACHE_DIR, LIBRARY_JSON } from '@shared/constants'
import { LibraryJsonSchema, emptyLibraryJson, type LibraryJson } from '@shared/schemas/library'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'
import { setAsideUnreadable } from '../../util/persisted'

/** `<library root>/.fsmgr-cache/library.json` load/save. */

export function libraryJsonPath(libraryRoot: string): string {
  return join(libraryRoot, LIBRARY_CACHE_DIR, LIBRARY_JSON)
}

/**
 * Load library.json, creating an empty one when absent — the first step of a
 * library's startup sync. It is source of truth, so a file that does not
 * validate is moved aside rather than written over, and the library starts
 * from an empty structure.
 */
export async function loadOrCreateLibraryJson(libraryRoot: string): Promise<LibraryJson> {
  const path = libraryJsonPath(libraryRoot)
  const raw = await readJsonOr(path, null)
  if (raw === null) {
    const fresh = emptyLibraryJson()
    await atomicWriteJson(path, fresh)
    return fresh
  }
  const parsed = LibraryJsonSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  console.warn(`[library] ${path} did not validate:`, parsed.error.issues)
  await setAsideUnreadable(path)
  return emptyLibraryJson()
}

export async function saveLibraryJson(libraryRoot: string, data: LibraryJson): Promise<void> {
  await atomicWriteJson(libraryJsonPath(libraryRoot), LibraryJsonSchema.parse(data))
}
