/**
 * Ordering keys, for lists whose order is the user's and not the data's.
 *
 * A playlist is ordered, and that order belongs to the list rather than to the
 * media in it: one video sits third in one list and tenth in another. Storing a
 * position as an integer would mean that dropping a card between two others
 * renumbers everything below it — one gesture, a hundred sidecars rewritten,
 * and a hundred chances for half of them to fail.
 *
 * So a position is a string instead, ordered lexicographically, and there is
 * always room to make another one between any two. Inserting touches exactly
 * the sidecar of the media that moved. Figma and Jira order this way for the
 * same reason.
 *
 * Keys grow only as fast as the list is subdivided. Measured: 200 appends or
 * 200 prepends reach 12 characters, and 5000 drops at random positions reach 8.
 * The one shape that grows badly is dropping into the *same* gap over and over
 * — 500 of those reach 101 characters — which is halving one interval 500 times
 * and is not something a person does. Should a list ever get there, the repair
 * is to re-spread it; nothing else has to change, because a key means nothing
 * except where it sorts.
 *
 * Pure, so the whole scheme can be exercised against a few thousand random
 * insertions without a library on disk.
 */

/**
 * Digits then lower-case letters, which is already their byte order — so
 * comparing two keys is plain string comparison, in SQL and in JS alike, with
 * no collation to get wrong.
 */
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
const BASE = ALPHABET.length

const digit = (c: string): number => ALPHABET.indexOf(c)

/** Is this something `between` will accept and the index can sort? */
export function isRank(value: string): boolean {
  // A key ending in the lowest digit has a tail that no key can be placed
  // before, which breaks the "always room between" promise; `between` never
  // produces one, so rejecting it here keeps a hand-edited sidecar from
  // poisoning the list.
  return value.length > 0 && !value.endsWith(ALPHABET[0]!) && [...value].every((c) => digit(c) >= 0)
}

/**
 * A key that sorts strictly after `prev` and strictly before `next`.
 *
 * Either end may be empty: `between('', x)` is "before everything", and
 * `between(x, '')` is "after everything", which is what appending needs. The
 * two together give the first key of an empty list.
 *
 * `prev` must sort before `next`; the caller knows the list, so it is the
 * caller's job to pass the neighbours the right way round.
 */
export function between(prev: string, next: string): string {
  if (prev && next && prev >= next) {
    throw new Error(`rank.between: ${JSON.stringify(prev)} does not sort before ${JSON.stringify(next)}`)
  }

  // Appending is the common case — every "add to playlist" is one — and taking
  // the midpoint against an open top end walks the key towards 'z' and grows it
  // a character every few adds. Stepping up instead keeps it short.
  if (!next) return after(prev)
  if (!prev) return before(next)

  /*
   * One below the lowest digit, for "`prev` has no digit here at all". It must
   * not be a digit the alphabet contains: using 0 makes `between('', '0i')`
   * read the empty string as if it began with a literal '0', and the key that
   * comes back sorts after `next` instead of before it.
   */
  const BELOW = -1

  let pos = 0
  let p = 0
  let n = 0
  // Walk the shared prefix. Past the end of `prev` counts as below the
  // alphabet and past the end of `next` as above it — which is what makes an
  // empty string mean "the very start" at one end and "the very end" at the
  // other.
  for (; p === n; pos++) {
    p = pos < prev.length ? digit(prev[pos]!) : BELOW
    n = pos < next.length ? digit(next[pos]!) : BASE
  }

  let out = prev.slice(0, pos - 1)

  if (p === BELOW) {
    // `prev` ran out here. Follow `next` down for as long as it hugs the
    // floor, since nothing can be placed under the lowest digit.
    while (n === 0) {
      n = pos < next.length ? digit(next[pos++]!) : BASE
      out += ALPHABET[0]
    }
    if (n === 1) {
      // Only the floor digit is free — take it and get the room from the next
      // place down instead.
      out += ALPHABET[0]
      n = BASE
    }
  } else if (p + 1 === n) {
    // Adjacent digits: no room here, so keep `prev`'s digit and find the room
    // deeper, skipping any run of `prev` sitting at the ceiling.
    out += ALPHABET[p]
    n = BASE
    while ((p = pos < prev.length ? digit(prev[pos++]!) : BELOW) === BASE - 1) {
      out += ALPHABET[BASE - 1]
    }
  }

  return out + ALPHABET[Math.ceil((p + n) / 2)]
}

/**
 * The next key after `prev`, for putting something at the end of a list.
 *
 * Steps the last digit up rather than splitting the difference with the top of
 * the alphabet, so a list that is only ever appended to gets a full run of the
 * alphabet out of each character instead of a handful.
 */
function after(prev: string): string {
  // Mid-alphabet, so the first key of a list leaves room on both sides.
  const seed = ALPHABET[Math.floor(BASE / 2)]!
  if (!prev) return seed
  const last = digit(prev[prev.length - 1]!)
  if (last < 0) throw new Error(`rank.after: ${JSON.stringify(prev)} is not a rank`)
  // Room left in this place; otherwise this place is at the ceiling and the
  // only thing that sorts after it is something longer.
  return last < BASE - 1 ? prev.slice(0, -1) + ALPHABET[last + 1] : prev + seed
}

/** The mirror of `after`, for putting something at the front of a list. */
function before(next: string): string {
  const seed = ALPHABET[Math.floor(BASE / 2)]!
  if (!next) return seed
  const last = digit(next[next.length - 1]!)
  if (last < 0) throw new Error(`rank.before: ${JSON.stringify(next)} is not a rank`)
  // Stop above the floor digit: a key ending in it has nothing that can sort
  // between it and its own prefix. At the floor, go a place deeper instead.
  return last > 1
    ? next.slice(0, -1) + ALPHABET[last - 1]
    : next.slice(0, -1) + ALPHABET[0] + seed
}

/**
 * `count` keys in order, spread out — for filling a list in one go (a playlist
 * built from a selection, or the collections migrated off a v2 sidecar).
 *
 * Spread rather than consecutive so the first insertion between two of them
 * does not have to grow a longer key straight away.
 */
export function spread(count: number): string[] {
  if (count <= 0) return []
  const width = 4
  const span = BASE ** width
  const step = Math.floor(span / (count + 1))
  const out: string[] = []
  for (let i = 1; i <= count; i++) {
    let value = step * i
    let key = ''
    for (let d = 0; d < width; d++) {
      key = ALPHABET[value % BASE] + key
      value = Math.floor(value / BASE)
    }
    // Never end on the floor digit — see isRank.
    out.push(key.replace(/0+$/, '') || ALPHABET[1]!)
  }
  return out
}
