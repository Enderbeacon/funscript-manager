import type { MediaMeta } from '@shared/schemas/media-meta'

/**
 * The media-level `scriptAuthors` list, derived from the script versions.
 *
 * Each version already records who wrote it. That is the fact; the media's
 * list is a summary of it, and the two had no code keeping them in step — so a
 * library full of versions credited to real people showed no script authors at
 * all in the filter sidebar. Deriving it rather than asking anyone to maintain
 * it is what stops them drifting apart again.
 *
 * **Only asserted authors count.** Companion grouping names a version after
 * the variant part of its file name and copies that into `author` too, so
 * `clip.remix2.funscript` claims an author called `remix2`. Those are file
 * names, not people, and letting them in would put them in the vocabulary
 * permanently. The tell is that the guess makes `author` and `name` identical
 * and leaves no `sourceUrl` — a version that came from a post carries the post
 * link, and one whose name happens to equal its author's is kept on that basis.
 */
export function deriveScriptAuthors(meta: MediaMeta): string[] {
  const out = [...meta.scriptAuthors]
  const seen = new Set(out.map((n) => n.toLowerCase()))
  for (const version of meta.scriptVersions) {
    const author = version.author?.trim()
    if (!author) continue
    const guessedFromFileName = author === version.name && !version.sourceUrl
    if (guessedFromFileName) continue
    if (seen.has(author.toLowerCase())) continue
    seen.add(author.toLowerCase())
    out.push(author)
  }
  return out
}

/** The derived list, or null when the sidecar already agrees with it. */
export function scriptAuthorsUpdate(meta: MediaMeta): string[] | null {
  const derived = deriveScriptAuthors(meta)
  return derived.length === meta.scriptAuthors.length ? null : derived
}
