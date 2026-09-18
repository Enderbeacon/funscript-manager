/**
 * Pinned tags first, the latest pinned at the top; the rest in the order the
 * user arranged them.
 *
 * Works on a tree in display order, where a row's children are the rows after
 * it that are deeper. A pinned tag takes its subtree up with it, re-rooted at
 * depth 0, so the tree still reads as a tree. A pinned tag inside another
 * pinned tag's subtree is lifted on its own, by its own pin time. Unpinning
 * puts a tag back where it always was: its place in the tree never changed,
 * only where it is shown.
 */

export interface PinnableRow {
  depth: number
  pinned: boolean
  pinnedAt: number | null
}

export function pinnedFirst<T extends PinnableRow>(rows: T[]): T[] {
  if (!rows.some((row) => row.pinned)) return rows

  /** The rows below `index`, skipping pinned ones and everything under them. */
  const subtree = (index: number): number[] => {
    const own: number[] = []
    const depth = rows[index]!.depth
    let j = index + 1
    while (j < rows.length && rows[j]!.depth > depth) {
      if (rows[j]!.pinned) {
        const nested = rows[j]!.depth
        j++
        while (j < rows.length && rows[j]!.depth > nested) j++
        continue
      }
      own.push(j)
      j++
    }
    return own
  }

  const pinned = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.pinned)
    .sort((a, b) => (b.row.pinnedAt ?? 0) - (a.row.pinnedAt ?? 0))

  const lifted = new Set<number>()
  const top: T[] = []
  for (const { row, index } of pinned) {
    const base = row.depth
    for (const i of [index, ...subtree(index)]) {
      lifted.add(i)
      top.push({ ...rows[i]!, depth: rows[i]!.depth - base })
    }
  }
  return [...top, ...rows.filter((_, i) => !lifted.has(i))]
}
