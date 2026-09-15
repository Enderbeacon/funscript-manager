import { folderRef } from '@shared/schemas/taxonomy'

/**
 * The library's folders as the filter sidebar draws them.
 *
 * The main side answers with a flat list per library — path, depth, and how
 * many entries sit at or below it. Everything here is about presentation: what
 * a row is called, where it sits in the tree, and whether the library it
 * belongs to needs a row of its own.
 *
 * Folders are not a taxonomy. Nobody arranged them here, and there is nothing
 * to rename or merge — they are where the files already are, which is exactly
 * why someone who filed a series in one folder wants to ask for it that way.
 */

/** One row as `library:folders` returns it. */
export interface FolderCount {
  libraryId: string
  /** Library-relative, forward slashes; '' is the library root. */
  path: string
  depth: number
  entries: number
  total: number
}

export interface FolderRow {
  /** `<library id>/<path>`; what a folder filter stores. */
  ref: string
  /** Basename, or the library's name for a root row. */
  label: string
  /** Indentation level as drawn, root at 0. */
  depth: number
  /** Entries here and anywhere below — what picking this row would show. */
  count: number
  /** Library name and path, for the filter box and the row's tooltip. */
  fullPath: string
  isRoot: boolean
}

/** Path order that is also tree order: compare segment by segment. */
function comparePaths(a: string, b: string): number {
  const left = a === '' ? [] : a.split('/')
  const right = b === '' ? [] : b.split('/')
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const cmp = left[i]!.localeCompare(right[i]!)
    if (cmp !== 0) return cmp
  }
  return left.length - right.length
}

/**
 * The rows to draw, in tree order.
 *
 * A library only gets a row of its own when there is more than one to tell
 * apart — with a single library on screen its root row would be a heading over
 * the whole list, saying nothing that the library picker above does not.
 */
export function folderRows(
  counts: FolderCount[],
  libraries: { id: string; name: string }[]
): FolderRow[] {
  const byLibrary = new Map<string, FolderCount[]>()
  for (const count of counts) {
    const list = byLibrary.get(count.libraryId)
    if (list) list.push(count)
    else byLibrary.set(count.libraryId, [count])
  }

  // Registered order, and only the libraries that actually answered: one that
  // is still starting has no folders yet rather than an empty tree.
  const shown = libraries.filter((library) => byLibrary.has(library.id))
  const withRoots = shown.length > 1
  const out: FolderRow[] = []

  for (const library of shown) {
    const list = [...byLibrary.get(library.id)!].sort((a, b) => comparePaths(a.path, b.path))
    for (const folder of list) {
      const isRoot = folder.path === ''
      if (isRoot && !withRoots) continue
      out.push({
        ref: folderRef(library.id, folder.path),
        label: isRoot ? library.name : (folder.path.split('/').pop() ?? folder.path),
        depth: withRoots ? folder.depth : folder.depth - 1,
        count: folder.total,
        fullPath: isRoot ? library.name : `${library.name}/${folder.path}`,
        isRoot
      })
    }
  }
  return out
}
