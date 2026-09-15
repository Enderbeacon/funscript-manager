/**
 * Semantic version ordering, for release tags like `1.4.0` and `1.5.0-beta.2`.
 *
 * Only what release tags use: three numeric parts, an optional prerelease
 * after `-`, build metadata after `+` ignored. A prerelease sorts below the
 * same version without one, and its dot-separated parts compare numerically
 * when both are numbers, so `beta.10` comes after `beta.9`.
 */

interface Parsed {
  core: [number, number, number]
  pre: string[]
}

function parse(version: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!m) return null
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : []
  }
}

export function isValidVersion(version: string): boolean {
  return parse(version) !== null
}

/** Negative when a < b, positive when a > b, 0 when equal or either is unparseable. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    const diff = pa.core[i]! - pb.core[i]!
    if (diff !== 0) return diff
  }
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x) ? Number(x) : null
    const ny = /^\d+$/.test(y) ? Number(y) : null
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny
    } else if (nx !== null) {
      return -1
    } else if (ny !== null) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}
