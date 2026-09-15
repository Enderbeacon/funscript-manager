/**
 * Video quality preference, and what to do when a source has not got it.
 *
 * The rule, in the user's words: take the resolution asked for; if it is not
 * on offer, go **up** to the first one that is; only if there is nothing above
 * do you come back **down**. Erring upwards costs disk space, erring downwards
 * costs picture — and the file is kept for years either way.
 *
 * Shared because three places have to agree on it: the page-direct parsers pick
 * from a list of offers, hanime.tv picks a row in a panel, and yt-dlp is told
 * the same order in its own language.
 */

/** Selectable preferences, best first. `best` means "whatever is highest". */
export const QUALITY_CHOICES = ['best', '2160p', '1440p', '1080p', '720p', '480p', '360p'] as const

export type QualityPreference = (typeof QUALITY_CHOICES)[number]

/** The ladder the choices name, ascending. */
export const QUALITY_LADDER = [360, 480, 720, 1080, 1440, 2160] as const

/** The height a preference asks for; null when it asks for the highest there is. */
export function preferredHeight(preference: QualityPreference): number | null {
  return preference === 'best' ? null : Number(preference.replace('p', ''))
}

/**
 * Order candidates by how well they answer the preference: the exact height
 * first, then upwards from it, then downwards. Heights off the ladder (a source
 * offering 900p) sort into the same order — nothing here assumes the ladder.
 */
export function byPreference<T>(
  items: T[],
  heightOf: (item: T) => number,
  preference: QualityPreference
): T[] {
  const wanted = preferredHeight(preference)
  const sorted = [...items].sort((a, b) => heightOf(b) - heightOf(a))
  if (wanted === null) return sorted
  const atOrAbove = sorted.filter((i) => heightOf(i) >= wanted).reverse()
  const below = sorted.filter((i) => heightOf(i) < wanted)
  return [...atOrAbove, ...below]
}

/**
 * The same order as a list of height bands, for handing to something that
 * speaks in ranges rather than in a list of files — yt-dlp, which does its own
 * extraction and never shows us the formats we would be choosing between.
 *
 * Each band is one rung of the ladder: `[floor, ceiling)`, ceiling null at the
 * top. A source with an unusual height lands in the band around it, so 900p is
 * reached by asking for 720p and is preferred over 1080p, exactly as a real
 * 720p-or-better list would be.
 */
export function bandsByPreference(preference: QualityPreference): { min: number; max: number | null }[] {
  const wanted = preferredHeight(preference)
  if (wanted === null) return []
  const rungs: number[] = [...QUALITY_LADDER]
  if (!rungs.includes(wanted)) {
    rungs.push(wanted)
    rungs.sort((a, b) => a - b)
  }
  const band = (index: number): { min: number; max: number | null } => ({
    min: rungs[index]!,
    max: rungs[index + 1] ?? null
  })
  const at = rungs.indexOf(wanted)
  const up = rungs.slice(at).map((_, i) => band(at + i))
  // Downwards: the rung just below first, and finally everything under the
  // bottom rung, so a source with only 240p is still reachable.
  const down = rungs
    .slice(0, at)
    .reverse()
    .map((_, i) => band(at - 1 - i))
  return [...up, ...down, { min: 0, max: rungs[0]! }]
}
