import { FUNSCRIPT_AXES, FUNSCRIPT_EXTENSION } from '@shared/constants'
import { fold, isFileNoise, weightOf, words } from './tokens'

/**
 * What to ask the forum about one library entry, and in what order.
 *
 * The order is the whole design. Measured against real filenames from this
 * library, the forum's search answers a raw filename — resolution suffix, site
 * name, comma-separated tag run, a hundred and ten characters of it — with the
 * one correct topic. So the first rung is the name exactly as it sits on disk,
 * and cleaning it up is what happens *after* that fails, not before it is
 * tried. Every rung costs a request, and most entries never leave the first.
 */

export interface MatchSubject {
  /** Media filename with its extension, as on disk. */
  fileName: string
  /** Sidecar title, when the entry has one of its own. */
  title: string | null
  /** Script filenames belonging to the entry, relative to its folder. */
  scriptFiles: string[]
  durationMs: number | null
}

export interface PlannedQuery {
  query: string
  /** Which rung produced it — carried so a smoke run can score them separately. */
  rung: 'file' | 'title' | 'script' | 'cleaned' | 'rare'
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? name : name.slice(0, dot)
}

/**
 * A script filename reduced to the scene it is for: `clip.roll.funscript` and
 * `clip (Soft).funscript` both become `clip`. The axis has to go because it is
 * never in the post's title; the parenthesised variant label usually is not
 * either, but it is left alone here — `(Azur Lane)` looks exactly the same and
 * is worth searching for.
 */
export function scriptCoreName(path: string): string {
  const name = baseName(path)
  const lower = name.toLowerCase()
  const cut = lower.lastIndexOf(FUNSCRIPT_EXTENSION)
  let core = cut > 0 ? name.slice(0, cut) : withoutExtension(name)
  for (const axis of FUNSCRIPT_AXES) {
    if (core.toLowerCase().endsWith(`.${axis}`)) {
      core = core.slice(0, -(axis.length + 1))
      break
    }
  }
  return core
}

/** The name with file furniture and site names dropped, words kept in order. */
export function cleanedName(value: string): string {
  return words(value)
    .filter((token) => !isFileNoise(token))
    .join(' ')
}

/**
 * The last resort: quote the most distinctive adjacent pair and add the other
 * unusual words loose.
 *
 * Quoting is the right tool for narrowing here — `"Elf Frieren"` finds the one
 * topic. `in:title` is not: it drops every post whose terms sit in the body,
 * which on this forum is most of them.
 */
export function rareQuery(value: string): string {
  const tokens = words(value).filter((t) => weightOf(t) >= 1)
  if (tokens.length === 0) return ''
  if (tokens.length === 1) return tokens[0]!

  let bestPair = 0
  let bestScore = -1
  for (let i = 0; i + 1 < tokens.length; i++) {
    const score = weightOf(tokens[i]!) + weightOf(tokens[i + 1]!)
    if (score > bestScore) {
      bestScore = score
      bestPair = i
    }
  }
  const phrase = `"${tokens[bestPair]} ${tokens[bestPair + 1]}"`
  const rest = tokens
    .filter((_, i) => i !== bestPair && i !== bestPair + 1)
    .sort((a, b) => weightOf(b) - weightOf(a))
    .slice(0, 2)
  return [phrase, ...rest].join(' ')
}

/** Too short and the forum's search has nothing to work with. */
const MIN_QUERY_LENGTH = 3

/**
 * The ladder for one entry, already de-duplicated: two rungs that would send
 * the same words send one request between them.
 */
export function planQueries(subject: MatchSubject): PlannedQuery[] {
  const mediaCore = withoutExtension(baseName(subject.fileName))
  const foldedMedia = fold(mediaCore)

  /**
   * Only scripts whose name is not simply the media's name with a label on it.
   *
   * An entry routinely carries `clip-max`, `clip-normal`, `clip.suckManual`
   * beside `clip` — variants of the same script. Searching each one costs a
   * request and asks the same question the media's own name already asked,
   * three times, with a suffix that guarantees nothing comes back.
   */
  const scriptCores = subject.scriptFiles
    .map(scriptCoreName)
    .filter(Boolean)
    .filter((core) => {
      const folded = fold(core)
      return !folded.startsWith(foldedMedia) && !foldedMedia.startsWith(folded)
    })

  const rungs: PlannedQuery[] = [{ query: mediaCore, rung: 'file' }]
  if (subject.title) rungs.push({ query: subject.title, rung: 'title' })
  // One is enough: past the first, a differently-named script is a different
  // question, and the ladder has a request budget to answer this one.
  if (scriptCores[0]) rungs.push({ query: scriptCores[0], rung: 'script' })
  rungs.push({ query: cleanedName(mediaCore), rung: 'cleaned' })
  rungs.push({ query: rareQuery(subject.title || mediaCore), rung: 'rare' })

  const seen = new Set<string>()
  const planned: PlannedQuery[] = []
  for (const rung of rungs) {
    const query = rung.query.trim()
    if (query.length < MIN_QUERY_LENGTH) continue
    const key = fold(query)
    if (!key || seen.has(key)) continue
    seen.add(key)
    planned.push({ ...rung, query })
  }
  return planned
}

/** Every name the entry is known by locally — what candidates are scored against. */
export function subjectNames(subject: MatchSubject): {
  media: string
  title: string | null
  scripts: string[]
} {
  return {
    media: withoutExtension(baseName(subject.fileName)),
    title: subject.title,
    scripts: subject.scriptFiles.map(scriptCoreName).filter(Boolean)
  }
}
