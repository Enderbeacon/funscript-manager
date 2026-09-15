import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaMeta } from '@shared/schemas/media-meta'
import { companionRefs, type EntryFileTimes } from '../db/index-db'

/**
 * When an entry's files arrived and when they last changed, read off the
 * filesystem. These are what the grid's two "recent" sorts order by.
 *
 * The sidecar cannot answer either question. Its `createdAt` is the moment
 * this app first wrote a sidecar for the file, which across an imported
 * library is one and the same minute, and its `updatedAt` moves for reasons of
 * the app's own. The file's own times are what someone means by "what did I
 * add lately".
 */
export async function entryFileTimes(
  root: string,
  relPath: string,
  meta: MediaMeta
): Promise<EntryFileTimes> {
  const timesOf = async (rel: string): Promise<{ created: number; modified: number } | null> => {
    const st = await stat(join(root, ...rel.split('/'))).catch(() => null)
    if (!st) return null
    // Filesystems that keep no creation time report 0; the modification time is
    // the closest thing they have to "since when is this here".
    const created = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
    return { created: Math.floor(created), modified: Math.floor(st.mtimeMs) }
  }

  const media = await timesOf(relPath)
  const companions = (
    await Promise.all(companionRefs(meta, relPath).map((ref) => timesOf(ref.path)))
  ).filter((t) => t !== null)

  // A script arriving this week does not make the video new, so companions
  // only answer for the entry's arrival when there is no media file to answer:
  // an entry that is nothing but scripts dates from the first of them.
  const addedAt = media
    ? media.created
    : companions.length
      ? Math.min(...companions.map((t) => t.created))
      : null

  const changes = [...(media ? [media.modified] : []), ...companions.map((t) => t.modified)]
  // What the user did to the entry counts as a change too — a rating, a tag, a
  // renamed script version. The stamp a sidecar is born with does not: it is
  // the scan that found the file, identical across a whole first import, and
  // would drown out every real file time if it were allowed to count.
  const edited = meta.updatedAt === meta.createdAt ? NaN : Date.parse(meta.updatedAt)
  if (!Number.isNaN(edited)) changes.push(edited)

  return { addedAt, modifiedAt: changes.length ? Math.max(...changes) : null }
}
