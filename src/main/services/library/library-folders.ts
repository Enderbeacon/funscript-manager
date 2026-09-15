/**
 * The folder view of a library, over library-relative paths only.
 *
 * Pure functions with no I/O, for the same reason companion-grouping is: the
 * page offers a button that removes everything under a folder, and the count
 * beside it has to be exactly what that button will take.
 */

export interface LibraryFolder {
  /** Library-relative, forward slashes; '' is the library root. */
  path: string
  /** Depth below the root, so a flat list can be drawn as a tree. */
  depth: number
  /** Entries filed directly in this folder. */
  entries: number
  /** Entries here and anywhere below — what removing this folder would take. */
  total: number
}

/** Every folder above `dir`, nearest first; '' (the root) always last. */
function ancestorsOf(dir: string): string[] {
  const out: string[] = []
  for (let at = dir.lastIndexOf('/'); at !== -1; at = dir.lastIndexOf('/', at - 1)) {
    out.push(dir.slice(0, at))
  }
  if (dir !== '') out.push('')
  return out
}

/**
 * The folders that hold entries, with how many each accounts for.
 *
 * Built from what is indexed rather than from the disk: the point of the list
 * is to decide what to take out of the library, and a folder holding nothing
 * the library knows about is not something there is a decision to make about.
 */
export function foldersOf(filePaths: string[]): LibraryFolder[] {
  const direct = new Map<string, number>()
  const totals = new Map<string, number>()

  for (const filePath of filePaths) {
    const slash = filePath.lastIndexOf('/')
    const dir = slash === -1 ? '' : filePath.slice(0, slash)
    direct.set(dir, (direct.get(dir) ?? 0) + 1)
    totals.set(dir, (totals.get(dir) ?? 0) + 1)
    // Ancestors have to be listed even when nothing sits directly in them, or a
    // folder whose entries all live one level down would be unremovable.
    for (const ancestor of ancestorsOf(dir)) {
      if (!direct.has(ancestor)) direct.set(ancestor, 0)
      totals.set(ancestor, (totals.get(ancestor) ?? 0) + 1)
    }
  }
  if (direct.size === 0) return []

  return [...direct.keys()]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      depth: path === '' ? 0 : path.split('/').length,
      entries: direct.get(path) ?? 0,
      total: totals.get(path) ?? 0
    }))
}

/** Is `filePath` filed in `folder` or anywhere below it? */
export function isUnder(folder: string, filePath: string): boolean {
  if (folder === '') return true
  // The trailing slash is what keeps `GAME` from taking `GAMEPLAY/clip.mp4`.
  return filePath.toLowerCase().startsWith(`${folder.toLowerCase()}/`)
}
