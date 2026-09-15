import { join } from 'node:path'
import { between, spread } from '@shared/rank'
import { normaliseNames } from '../taxonomy/taxonomy-service'
import * as libraryManager from './library-manager'
import { editMedia, listStartedLibraries } from './library-manager'
import type { MediaTarget } from './metadata'

/**
 * Playlists: the ordered lists the player plays.
 *
 * A playlist is an ordinary name a media carries, exactly as a tag is — which
 * is what makes filtering by one, renaming one and giving one a cover image
 * work through machinery that already existed. The one thing it has that a tag
 * does not is an order, and that order belongs to the list rather than to the
 * media: the same video is third in one list and tenth in another.
 *
 * So membership lives in `meta.playlists` and position in `meta.playlistRanks`,
 * keyed by playlist name. The keys are the sortable strings from shared/rank —
 * dropping a card between two others writes one sidecar, not the hundred below
 * it.
 *
 * A list spans libraries, because the media list does: `taxonomy.json` is
 * app-level and a playlist is one of its names. Everything here therefore works
 * over every started library rather than one.
 */

export interface PlaylistEntry {
  libraryId: string
  mediaId: string
  /** Null = in the list but never given a place; sorts after everything ranked. */
  rank: string | null
  filePath: string
}

/**
 * The list, in order, across every started library.
 *
 * Each library's index sorts its own rows; SQL cannot order across two of them,
 * so the merge repeats the comparison here. Same rule as the grid's: ranked
 * first by rank, then the unranked by path.
 */
export function playlistEntries(name: string): PlaylistEntry[] {
  const all: PlaylistEntry[] = []
  for (const { libraryId, db } of listStartedLibraries()) {
    for (const row of db.playlistMembers(name)) {
      all.push({ libraryId, mediaId: row.mediaId, rank: row.rank, filePath: row.filePath })
    }
  }
  return all.sort((a, b) => {
    if (a.rank === null && b.rank === null) return a.filePath.localeCompare(b.filePath)
    if (a.rank === null) return 1
    if (b.rank === null) return -1
    return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.filePath.localeCompare(b.filePath)
  })
}

/** Set (or clear) one media's place in one playlist. */
async function writeRank(
  target: MediaTarget,
  name: string,
  rank: string | null
): Promise<void> {
  await editMedia(target.libraryId, target.mediaId, (meta) => {
    const key = Object.keys(meta.playlistRanks).find((n) => n.toLowerCase() === name.toLowerCase())
    const ranks = { ...meta.playlistRanks }
    if (key !== undefined) delete ranks[key]
    // Filed under the spelling `playlists` carries, so the sidecar's own
    // reconciliation keeps it rather than reading it as an orphan.
    const member = meta.playlists.find((n) => n.toLowerCase() === name.toLowerCase())
    if (rank !== null && member !== undefined) ranks[member] = rank
    return { ...meta, playlistRanks: ranks, updatedAt: new Date().toISOString() }
  })
}

/**
 * Give every member of a playlist a place, keeping the order it already shows.
 *
 * A migrated collection has no ranks at all: nothing is wrong with that until
 * someone drags a row, at which point "between these two" has no two keys to
 * be between. Rather than invent one key and leave the rest guessing, the whole
 * list is written out once, in the order the user was already looking at.
 *
 * Costly — one sidecar per member — but it happens once per playlist, the first
 * time it is ordered, and never again.
 */
export async function materialiseOrder(name: string): Promise<PlaylistEntry[]> {
  const entries = playlistEntries(name)
  const keys = spread(entries.length)
  for (const [i, entry] of entries.entries()) {
    if (entry.rank === keys[i]) continue
    await writeRank(entry, name, keys[i]!)
  }
  return entries.map((entry, i) => ({ ...entry, rank: keys[i]! }))
}

/** Does every member have a distinct place? If not, a drop has nothing to aim at. */
function isOrdered(entries: PlaylistEntry[]): boolean {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.rank === null || seen.has(entry.rank)) return false
    seen.add(entry.rank)
  }
  return true
}

/**
 * Add media to the end of a playlist, creating the playlist if it is new.
 *
 * Appending rather than inserting because that is what "add to playlist" means
 * everywhere else; the user can drag it where they want afterwards. Media
 * already in the list keep the place they had — adding something twice is not
 * a way to move it.
 */
export async function addToPlaylist(
  targets: MediaTarget[],
  rawName: string
): Promise<{ added: number; name: string }> {
  // Through the taxonomy like every other name, so a playlist typed with a
  // forum's spelling lands on the one the user already has.
  const [name] = await normaliseNames('playlists', [rawName])
  if (!name) return { added: 0, name: rawName }

  const entries = playlistEntries(name)
  const present = new Set(entries.map((e) => `${e.libraryId}/${e.mediaId}`))
  const fresh = targets.filter((t) => !present.has(`${t.libraryId}/${t.mediaId}`))
  if (fresh.length === 0) return { added: 0, name }

  // Only hand out places if the list already has them. An unordered list stays
  // unordered — it shows in path order, and materialising it here would fix an
  // order the user has never expressed an opinion about.
  const ordered = entries.length > 0 && isOrdered(entries)
  let last = ordered ? (entries.at(-1)?.rank ?? '') : ''

  let added = 0
  for (const target of fresh) {
    await editMedia(target.libraryId, target.mediaId, (meta) => {
      const already = meta.playlists.some((n) => n.toLowerCase() === name.toLowerCase())
      const playlists = already ? meta.playlists : [...meta.playlists, name]
      const ranks = { ...meta.playlistRanks }
      if (ordered || entries.length === 0) {
        last = between(last, '')
        ranks[name] = last
      }
      return { ...meta, playlists, playlistRanks: ranks, updatedAt: new Date().toISOString() }
    })
    added += 1
  }
  return { added, name }
}

/** Take media out of a playlist. The rank goes with it (see reconcileRanks). */
export async function removeFromPlaylist(
  targets: MediaTarget[],
  name: string
): Promise<{ removed: number }> {
  let removed = 0
  for (const target of targets) {
    await editMedia(target.libraryId, target.mediaId, (meta) => ({
      ...meta,
      playlists: meta.playlists.filter((n) => n.toLowerCase() !== name.toLowerCase()),
      updatedAt: new Date().toISOString()
    }))
    removed += 1
  }
  return { removed }
}

/**
 * A second playlist with the same members in the same order.
 *
 * The ranks are copied rather than recomputed, so the copy really is the same
 * list — a duplicate made to try a different order should start from the order
 * being departed from, not from scratch.
 */
export async function duplicatePlaylist(
  from: string,
  rawTo: string
): Promise<{ name: string; copied: number }> {
  const [to] = await normaliseNames('playlists', [rawTo])
  if (!to || to.toLowerCase() === from.toLowerCase()) return { name: from, copied: 0 }
  const entries = playlistEntries(from)
  let copied = 0
  for (const entry of entries) {
    await editMedia(entry.libraryId, entry.mediaId, (meta) => {
      const already = meta.playlists.some((n) => n.toLowerCase() === to.toLowerCase())
      const rankKey = Object.keys(meta.playlistRanks).find(
        (n) => n.toLowerCase() === from.toLowerCase()
      )
      const rank = rankKey === undefined ? undefined : meta.playlistRanks[rankKey]
      return {
        ...meta,
        playlists: already ? meta.playlists : [...meta.playlists, to],
        playlistRanks: rank === undefined ? meta.playlistRanks : { ...meta.playlistRanks, [to]: rank },
        updatedAt: new Date().toISOString()
      }
    })
    copied += 1
  }
  return { name: to, copied }
}

/**
 * The list as absolute paths, in order — everything an .m3u needs.
 *
 * Media whose file has never arrived are left out: a playlist entry pointing at
 * a file that does not exist makes every other player stumble, and the entry
 * exists here precisely because there is nothing to play yet.
 */
export function playlistPaths(name: string): { path: string; mediaId: string }[] {
  const out: { path: string; mediaId: string }[] = []
  for (const entry of playlistEntries(name)) {
    try {
      const loc = libraryManager.getMediaLocation(entry.libraryId, entry.mediaId)
      out.push({ path: join(loc.libraryRoot, loc.mediaRelPath), mediaId: entry.mediaId })
    } catch {
      // Library not started, or the entry has no file. Skipping is the right
      // answer for a file list; the playlist itself is unaffected.
    }
  }
  return out
}

/**
 * Move one media to sit directly after `afterMediaId` — null meaning the very
 * front of the list.
 *
 * Expressed as "after this one" rather than "at index 7" because the list the
 * user is looking at and the list on disk are two different moments: an index
 * is wrong the instant anything else changes, a neighbour is not.
 */
export async function movePlaylistItem(
  target: MediaTarget,
  name: string,
  afterMediaId: string | null
): Promise<PlaylistEntry[]> {
  let entries = playlistEntries(name)
  if (!isOrdered(entries)) entries = await materialiseOrder(name)

  const rank = rankForMove(entries, target.mediaId, afterMediaId)
  if (rank === null) return entries
  await writeRank(target, name, rank)
  return playlistEntries(name)
}

/**
 * The key that puts `mediaId` directly after `afterMediaId`, or null when the
 * move cannot be made sense of.
 *
 * Pure, and separated from the writing, because this is where a reorder goes
 * wrong: the moving row has to be taken out of the list before its neighbours
 * are read, or dragging something one place down measures against itself and
 * lands where it already was.
 *
 * The list is sorted here rather than assumed sorted. Every caller happens to
 * hand it over in order today, and a caller that one day does not would get a
 * pair of neighbours that are not neighbours and a key that fails to sort
 * between them — a landmine not worth leaving for one sort of a list someone
 * is looking at. Ranks must be present and distinct; `movePlaylistItem`
 * materialises the list first to guarantee it.
 */
export function rankForMove(
  entries: PlaylistEntry[],
  mediaId: string,
  afterMediaId: string | null
): string | null {
  if (afterMediaId === mediaId) return null
  const without = entries
    .filter((e) => e.mediaId !== mediaId)
    .sort((a, b) => ((a.rank ?? '') < (b.rank ?? '') ? -1 : (a.rank ?? '') > (b.rank ?? '') ? 1 : 0))
  const at = afterMediaId === null ? 0 : without.findIndex((e) => e.mediaId === afterMediaId) + 1
  if (afterMediaId !== null && at === 0) {
    // The row it was dropped after has left the list — something else changed
    // it while this drag was in the air. Leaving it where it is is the honest
    // answer; guessing would move it somewhere nobody asked for.
    return null
  }
  const prev = at > 0 ? (without[at - 1]?.rank ?? '') : ''
  const next = at < without.length ? (without[at]?.rank ?? '') : ''
  return between(prev, next)
}
