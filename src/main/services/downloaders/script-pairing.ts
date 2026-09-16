import { DEFAULT_COMPANION_MATCH, FUNSCRIPT_AXES, FUNSCRIPT_EXTENSION } from '@shared/constants'
import { scriptOwner } from '../library/companion-grouping'

/**
 * Which video each script of a post goes with, when the post has several.
 *
 * File names alone rarely say. A collection post links each video on a site
 * that names the file after its own URL slug (`yorha-2b-reverse-cowgirl_1080p.mp4`)
 * and attaches scripts the scripter named (`(MsLewd) 2B Reverse Cowgirl.funscript`),
 * so the scanner's name rules find nothing. What does connect them is
 * everything around the file: the words the author wrote beside each video
 * link ("MsLewd", "Idemi 2"), the slug in the link itself, and the name the
 * video finally arrived under.
 *
 * Only a clear answer is acted on. Two videos with an equally good claim — a
 * post with "Cloud & Scarlet" and "Cloud & Scarlet Fleshlight" and scripts
 * named "Cloud & Scarlet" and "Cloud & Scarlet Extended" — are left for the
 * user, with the likeliest video offered first. Filing a script under the
 * wrong video is silent and outlives the download by years; asking costs one
 * click.
 */

export interface VideoCandidate {
  id: string
  /** The file on disk, once it has arrived; the only name the scanner's rules apply to. */
  fileName: string | null
  /** Anything else that describes the video: the author's note, its link, a queued name. */
  descriptions: string[]
}

export interface ScriptToPair {
  id: string
  fileName: string
}

export interface Pairing {
  /** Script id → video id, where the evidence points one way only. */
  settled: Map<string, string>
  /** Script id → the video to offer first for a script left to the user; null when nothing points anywhere. */
  guesses: Map<string, string | null>
}

/** Words that describe every file in a post equally, or none of them. */
const NOISE = new Set<string>([
  'a',
  'an',
  'and',
  'the',
  'of',
  'in',
  'on',
  'with',
  'to',
  'for',
  'by',
  'www',
  'com',
  'http',
  'https',
  'video',
  'videos',
  'watch',
  'mp4',
  'mkv',
  'webm',
  'mov',
  'avi',
  'wmv',
  'm4v',
  'funscript',
  ...FUNSCRIPT_AXES
])

/** `1080p`, `4k`, `60fps`, `4k60fps`: the upload's quality, not its content. */
const QUALITY = /^(\d{3,4}p|\d+k|\d+fps|\d+k\d+fps)$/

/** Tie tolerance for summed weights. */
const EPSILON = 1e-9

export function wordsOf(text: string): Set<string> {
  const words = new Set<string>()
  for (const word of text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word || NOISE.has(word) || QUALITY.test(word)) continue
    words.add(word)
  }
  return words
}

function withoutExtension(fileName: string): string {
  return fileName.toLowerCase().endsWith(FUNSCRIPT_EXTENSION)
    ? fileName.slice(0, -FUNSCRIPT_EXTENSION.length)
    : fileName
}

export function pairScripts(videos: VideoCandidate[], scripts: ScriptToPair[]): Pairing {
  const settled = new Map<string, string>()
  const guesses = new Map<string, string | null>()
  if (videos.length === 0) {
    for (const script of scripts) guesses.set(script.id, null)
    return { settled, guesses }
  }
  // One video takes everything: its scripts are routinely named after the
  // scene rather than the file, and there is nothing else to be wrong about.
  if (videos.length === 1) {
    for (const script of scripts) settled.set(script.id, videos[0]!.id)
    return { settled, guesses }
  }

  /*
   * Names first, under the scanner's own rules and then the loose one: a name
   * found whole inside another is enough here, because every file is already
   * known to have come from this one post. The looser pass only sees what the
   * first left over.
   */
  const byFileName = new Map<string, string>()
  for (const video of videos) if (video.fileName) byFileName.set(video.fileName, video.id)
  const arrivedNames = [...byFileName.keys()]
  for (const level of [DEFAULT_COMPANION_MATCH, 'loose'] as const) {
    for (const script of scripts) {
      if (settled.has(script.id)) continue
      const owner = scriptOwner(arrivedNames, script.fileName, level)
      if (owner) settled.set(script.id, byFileName.get(owner)!)
    }
  }

  /*
   * Then the words. A word counts for as much as it tells the videos apart:
   * one that appears beside every video ("2B" in a 2B bundle, the studio's
   * name) counts for nothing, one that appears beside a single video counts
   * most.
   */
  const vocabularies = videos.map((video) => {
    const words = new Set<string>()
    for (const text of [video.fileName ?? '', ...video.descriptions]) {
      for (const word of wordsOf(text)) words.add(word)
    }
    return words
  })
  const spread = new Map<string, number>()
  for (const words of vocabularies) {
    for (const word of words) spread.set(word, (spread.get(word) ?? 0) + 1)
  }
  const weight = (word: string): number => {
    const n = spread.get(word) ?? 0
    return n === 0 ? 0 : Math.log(videos.length / n)
  }

  const scored = scripts
    .map((script, index) => ({ script, index }))
    .filter(({ script }) => !settled.has(script.id))
    .map(({ script, index }) => {
      const words = wordsOf(withoutExtension(script.fileName))
      const scores = vocabularies.map((vocabulary) => {
        let sum = 0
        for (const word of words) if (vocabulary.has(word)) sum += weight(word)
        return sum
      })
      const best = Math.max(...scores)
      const top = scores.flatMap((score, i) => (Math.abs(score - best) < EPSILON ? [i] : []))
      return { script, index, best, top }
    })

  for (const { script, best, top } of scored) {
    if (best > EPSILON && top.length === 1) settled.set(script.id, videos[top[0]!]!.id)
  }

  // What is left gets a first offer, never a decision.
  const claimed = new Set(settled.values())
  const sameCount = scripts.length === videos.length
  for (const { script, index, best, top } of scored) {
    if (settled.has(script.id)) continue
    if (best <= EPSILON) {
      // Nothing in common with any of them. A post listing as many scripts as
      // videos usually lists them in the same order.
      guesses.set(script.id, sameCount ? videos[index]!.id : null)
      continue
    }
    const open = top.filter((i) => !claimed.has(videos[i]!.id))
    const pool = open.length > 0 ? open : top
    const pick = sameCount && pool.includes(index) ? index : pool[0]!
    guesses.set(script.id, videos[pick]!.id)
  }

  return { settled, guesses }
}
