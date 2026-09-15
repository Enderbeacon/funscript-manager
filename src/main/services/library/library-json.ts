import { join } from 'node:path'
import { LIBRARY_CACHE_DIR, LIBRARY_JSON } from '@shared/constants'
import { LibraryJsonSchema, emptyLibraryJson, type LibraryJson } from '@shared/schemas/library'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'

/** `<library root>/.fsmgr-cache/library.json` load/save. */

export function libraryJsonPath(libraryRoot: string): string {
  return join(libraryRoot, LIBRARY_CACHE_DIR, LIBRARY_JSON)
}

/**
 * Load library.json, creating an empty one when absent — the first step of a
 * library's startup sync. An unparseable file is left untouched on disk (it is source of
 * truth, never clobbered automatically) and an empty structure is returned.
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
  return parsed.success ? parsed.data : emptyLibraryJson()
}

export async function saveLibraryJson(libraryRoot: string, data: LibraryJson): Promise<void> {
  await atomicWriteJson(libraryJsonPath(libraryRoot), LibraryJsonSchema.parse(data))
}
