/**
 * String comparison exactly as SQLite orders text.
 *
 * A list across several libraries is merged here from pages each index sorted
 * by itself. Each index is asked for its first N rows, and those are only the
 * right N if the merge ranks rows the way SQLite did. `localeCompare` does not:
 * it folds case and weighs punctuation differently, so an index handed over a
 * prefix the merge did not consider the smallest, and consecutive pages
 * overlapped — the same media on two pages, others on none.
 */

/**
 * The BINARY collation: UTF-8 byte order, which is code point order. Not the
 * same as comparing UTF-16 units with `<`, which puts characters above the
 * Basic Multilingual Plane (emoji) before U+E000–U+FFFF (full-width forms).
 */
export function compareBinary(a: string, b: string): number {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!
    const cb = b.codePointAt(j)!
    if (ca !== cb) return ca < cb ? -1 : 1
    i += ca > 0xffff ? 2 : 1
    j += cb > 0xffff ? 2 : 1
  }
  if (i < a.length) return 1
  if (j < b.length) return -1
  return 0
}

/** The NOCASE collation: ASCII letters folded to lower case, then BINARY. */
export function compareNocase(a: string, b: string): number {
  return compareBinary(foldAscii(a), foldAscii(b))
}

function foldAscii(s: string): string {
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase())
}
