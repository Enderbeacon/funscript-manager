import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, rename, rm, stat } from 'node:fs/promises'
import { shell } from 'electron'
import { dirname, join, relative, sep } from 'node:path'
import { LIBRARY_CACHE_DIR, type CompanionMatchLevel } from '@shared/constants'
import type { RegisteredLibrary } from '@shared/schemas/app-config'
import type { SyncPhase } from '@shared/schemas/media-index'
import { MEDIA_META_VERSION, type MediaMeta } from '@shared/schemas/media-meta'
import type { LibraryIndexDb } from '../db/index-db'
import { groupCompanions, isMediaFile } from './companion-grouping'
import { entryFileTimes } from './file-times'
import { computeFingerprint } from './fingerprint'
import { IgnoreList } from './ignore-list'
import { getSettings } from '../config/config-service'
import { awaitingPairKeys, isBusyFor } from '../downloaders/queue'
import { mergeLateCompanions, orphanScriptGroups } from './late-companions'
import { probeMedia } from './probe'
import { scriptAuthorsUpdate } from './script-authors'
import { loadOrCreateLibraryJson } from './library-json'
import {
  buildNewSidecar,
  isSidecarFile,
  mediaPathForSidecar,
  readSidecar,
  sidecarPathFor,
  writeSidecar
} from './sidecar'

/**
 * Startup sync:
 *   1. load/create library.json
 *   2. list all sidecars (and media files) under the library root
 *   3. changed/new sidecars → reparse → update index
 *   4. media files: no sidecar → create one; moved (fingerprint match against
 *      an orphaned sidecar) → relocate the sidecar and update the path
 *   5. index rows whose files are gone → missing (sidecar kept) or removed
 *
 * The same code path doubles as the full rebuild: with an empty index.db
 * every sidecar reads as "new".
 */

export interface ScanProgress {
  phase: SyncPhase
  processed: number
  total: number
}

export interface SyncSummary {
  mediaTotal: number
  added: number
  updated: number
  relocated: number
  missing: number
  removed: number
  invalidSidecars: number
  /** Sidecars written by a newer build: skipped, and never written to. */
  newerSidecars: number
  /** Media files that threw on the way in; skipped, retried next scan. */
  failedFiles: number
  /** Media whose sidecar gained a script or subtitle that arrived later. */
  companionsAttached: number
  /** Entries created for scripts whose media file is not in the library. */
  scriptOnlyEntries: number
  /** Entries that were waiting for a file and found it in place. */
  wantedFilled: number
  /** Placeholders dropped because every script they held now has a real owner. */
  placeholdersReclaimed: number
  /** Media whose script-author list was derived from their versions. */
  scriptAuthorsFilled: number
}

const FINGERPRINT_CONCURRENCY = 8

interface WalkResult {
  /** rel media path → absolute path */
  mediaFiles: Map<string, string>
  /** rel media path (sidecar minus suffix) → sidecar absolute path */
  sidecars: Map<string, string>
  /** rel dir path → filenames in that dir (for companion grouping) */
  dirListings: Map<string, string[]>
}

function toRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/')
}

/**
 * Recursively list media files + sidecars, skipping dot-dirs (incl. the cache dir).
 *
 * Files the user removed from the library are dropped here rather than skipped
 * later, so that nothing downstream can see them: an ignored video left in the
 * directory listing would still count as the owner of its scripts, and the
 * scripts would then never become a placeholder entry even when the user asked
 * to keep them. Ignored by path only — a fingerprint needs the file read, which
 * is what step 4 is for.
 */
async function walk(root: string, ignored: IgnoreList): Promise<WalkResult> {
  const result: WalkResult = { mediaFiles: new Map(), sidecars: new Map(), dirListings: new Map() }
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // unreadable dir: skip rather than fail the whole sync
    }
    const names: string[] = []
    for (const entry of entries) {
      // Hidden entries and the cache dir are invisible to the scanner.
      if (entry.name.startsWith('.') || entry.name === LIBRARY_CACHE_DIR) continue
      if (entry.isDirectory()) {
        stack.push(join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue
      const abs = join(dir, entry.name)
      const rel = toRel(root, abs)
      if (isSidecarFile(entry.name)) {
        // A removed entry keeps its sidecar — that is where the title, tags and
        // rating live, and putting the entry back should bring them with it.
        // Which means the sidecar has to be stepped over here too, or the very
        // next scan would read it and index the entry straight back in.
        const mediaRel = toRel(root, mediaPathForSidecar(abs))
        if (ignored.hasPath(mediaRel)) continue
        names.push(entry.name)
        result.sidecars.set(mediaRel, abs)
        continue
      }
      if (ignored.hasPath(rel) || ignored.hasCompanion(rel)) continue
      names.push(entry.name)
      if (isMediaFile(entry.name)) result.mediaFiles.set(rel, abs)
    }
    result.dirListings.set(toRel(root, dir), names)
  }
  return result
}

/** Map with bounded concurrency (fingerprint batches). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!
      await fn(item)
    }
  })
  await Promise.all(lanes)
}

export async function syncLibrary(
  library: RegisteredLibrary,
  db: LibraryIndexDb,
  ignored: IgnoreList,
  onProgress?: (p: ScanProgress) => void
): Promise<SyncSummary> {
  const root = library.rootPath
  // Read once: a setting that changed mid-scan would file half the library by
  // one rule and half by another.
  const matchLevel = (await getSettings()).library.companionMatch
  const summary: SyncSummary = {
    mediaTotal: 0,
    added: 0,
    updated: 0,
    relocated: 0,
    missing: 0,
    removed: 0,
    invalidSidecars: 0,
    newerSidecars: 0,
    failedFiles: 0,
    companionsAttached: 0,
    scriptOnlyEntries: 0,
    wantedFilled: 0,
    placeholdersReclaimed: 0,
    scriptAuthorsFilled: 0
  }

  // Step 1: library.json, plus the list of things the user removed from the
  // library but kept on disk — every later step has to know not to re-add them.
  await loadOrCreateLibraryJson(root)

  // Step 2: enumerate the tree
  onProgress?.({ phase: 'listing', processed: 0, total: 0 })
  const tree = await walk(root, ignored)
  summary.mediaTotal = tree.mediaFiles.size

  const indexed = db.listIndexed()
  const indexedByPath = new Map(indexed.map((r) => [r.filePath, r]))

  // Orphaned sidecars (media file gone), keyed by fingerprint for move detection.
  const orphansByFingerprint = new Map<string, { meta: MediaMeta; sidecarAbs: string; relPath: string }>()

  // Step 3: reparse changed/new sidecars
  const sidecarEntries = [...tree.sidecars.entries()]
  let processed = 0
  for (const [relPath, sidecarAbs] of sidecarEntries) {
    onProgress?.({ phase: 'sidecars', processed: ++processed, total: sidecarEntries.length })
    let mtime: number
    try {
      mtime = Math.floor((await stat(sidecarAbs)).mtimeMs)
    } catch {
      continue
    }
    const row = indexedByPath.get(relPath)
    const mediaExists = tree.mediaFiles.has(relPath)

    if (row && row.sidecarMtime === mtime && !row.missing && mediaExists) continue

    const read = await readSidecar(sidecarAbs)
    if (!read.ok) {
      if (read.error === 'newer') summary.newerSidecars += 1
      else summary.invalidSidecars += 1
      continue
    }

    db.upsertFromSidecar(read.meta, relPath, mtime, await entryFileTimes(root, relPath, read.meta))
    if (row) summary.updated += 1
    else summary.added += 1

    if (!mediaExists) {
      // Orphan: candidate for move re-association in step 4, else missing.
      const key = `${read.meta.fileFingerprint.size}:${read.meta.fileFingerprint.blake3Head}`
      orphansByFingerprint.set(key, { meta: read.meta, sidecarAbs, relPath })
      db.setMissing(read.meta.id, true)
    }
  }

  // Step 4: media files — new sidecars, fingerprint refresh, move detection
  const mediaEntries = [...tree.mediaFiles.entries()]
  let mediaProcessed = 0
  const ingestMediaFile = async ([relPath, abs]: [string, string]): Promise<void> => {
    onProgress?.({ phase: 'media', processed: ++mediaProcessed, total: mediaEntries.length })
    const sidecarAbs = tree.sidecars.get(relPath)

    const dirRel = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
    const mediaName = relPath.split('/').pop()!
    const siblings = tree.dirListings.get(dirRel) ?? []

    if (sidecarAbs) {
      // Sidecar present: recompute the fingerprint only when the size changed
      // — rehashing every file on every start would read the whole library. A changed fingerprint means the file was
      // replaced; the sidecar records the new one.
      const read = await readSidecar(sidecarAbs)
      if (!read.ok) return
      let size: number
      try {
        size = (await stat(abs)).size
      } catch {
        return
      }
      // Companions dropped in after the first ingest are picked up here — the
      // directory listing is already in hand and the sidecar is already read.
      const withCompanions = mergeLateCompanions(
        read.meta,
        mediaName,
        dirname(abs),
        siblings,
        matchLevel
      )
      const replaced = size !== read.meta.fileFingerprint.size
      // An entry that was waiting for its file has it now: this loop only ever
      // sees media files that exist. Dropping the block is what tells the
      // detail page to stop offering ways to supply one.
      const arrived = read.meta.wanted !== undefined
      // Who wrote each script version is recorded on the version; the media's
      // own author list is a summary of that, and nothing used to compute it.
      // Doing it here catches the whole existing library on the next scan, and
      // keeps working for versions edited by hand in the sidecar.
      const authors = scriptAuthorsUpdate(withCompanions ?? read.meta)
      if (
        !replaced &&
        !withCompanions &&
        !arrived &&
        authors === null &&
        read.meta.mediaInfo !== undefined
      ) {
        return
      }
      if (withCompanions) summary.companionsAttached += 1
      if (arrived) summary.wantedFilled += 1
      if (authors !== null) summary.scriptAuthorsFilled += 1

      const { wanted: _wanted, ...withoutWanted } = withCompanions ?? read.meta
      const base = arrived ? (withoutWanted as MediaMeta) : (withCompanions ?? read.meta)
      // Probe when the file changed, and once for anything indexed before
      // probing existed — the sidecar keeps it, so this is paid only once.
      const needsProbe = replaced || read.meta.mediaInfo === undefined
      const probed = needsProbe ? await probeMedia(abs) : null
      const meta: MediaMeta = {
        ...base,
        ...(authors !== null ? { scriptAuthors: authors } : {}),
        ...(probed !== null ? { mediaInfo: probed } : {}),
        ...(replaced
          ? { fileFingerprint: await computeFingerprint(abs), updatedAt: new Date().toISOString() }
          : {})
      }
      await writeSidecar(sidecarAbs, meta)
      db.upsertFromSidecar(
        meta,
        relPath,
        Math.floor((await stat(sidecarAbs)).mtimeMs),
        await entryFileTimes(root, relPath, meta)
      )
      summary.updated += 1
      return
    }

    // No sidecar: fingerprint, then either re-associate an orphan (move) or ingest as new.
    let fp
    try {
      fp = await computeFingerprint(abs)
    } catch {
      return // unreadable file (locked/permission): retried on next sync
    }
    const key = `${fp.size}:${fp.blake3Head}`
    // A removed file that turned up under a new name. The walk could not know —
    // it only had the path — so the check lands here, where the hash already
    // exists. Matching also records the new path, so the next walk sees it.
    if (await ignored.matchFingerprint(key, relPath)) return

    const orphan = orphansByFingerprint.get(key)
    if (orphan) {
      // The media file moved without its sidecar: move the sidecar alongside it.
      orphansByFingerprint.delete(key)
      const newSidecarAbs = sidecarPathFor(abs)
      try {
        await rename(orphan.sidecarAbs, newSidecarAbs)
      } catch {
        await writeSidecar(newSidecarAbs, orphan.meta)
      }
      db.upsertFromSidecar(
        orphan.meta,
        relPath,
        Math.floor((await stat(newSidecarAbs)).mtimeMs),
        await entryFileTimes(root, relPath, orphan.meta)
      )
      summary.relocated += 1
      return
    }

    // Fresh ingest: group companions in the same directory, write the sidecar.
    const probed = await probeMedia(abs)
    const meta = buildNewSidecar(fp, groupCompanions(mediaName, siblings, matchLevel), probed)
    const newSidecarAbs = sidecarPathFor(abs)
    await writeSidecar(newSidecarAbs, meta)
    db.upsertFromSidecar(
      meta,
      relPath,
      Math.floor((await stat(newSidecarAbs)).mtimeMs),
      await entryFileTimes(root, relPath, meta)
    )
    summary.added += 1
  }

  // One file must not take the scan down with it: the lanes run under
  // Promise.all, so an unhandled throw here abandoned every remaining file in
  // the library — a single unwritable sidecar left a whole library unscanned.
  await mapLimit(mediaEntries, FINGERPRINT_CONCURRENCY, async (entry) => {
    try {
      await ingestMediaFile(entry)
    } catch (e) {
      summary.failedFiles += 1
      console.error(`[library] skipped ${entry[0]}:`, e)
    }
  })

  // Step 5: cleanup — rows whose media file is gone
  onProgress?.({ phase: 'cleanup', processed: 0, total: 0 })
  for (const row of db.listIndexed()) {
    if (tree.mediaFiles.has(row.filePath)) continue
    if (tree.sidecars.has(row.filePath)) {
      // Sidecar kept, media gone (and not re-associated) → missing.
      if (!row.missing) {
        db.setMissing(row.id, true)
        summary.missing += 1
      }
    } else {
      db.remove(row.id)
      summary.removed += 1
    }
  }

  // Step 6: placeholders with nothing left to hold. A "wanted" entry exists to
  // give a set of scripts somewhere to live until their video turns up; once
  // every one of those scripts is named by a sidecar that does have a file, the
  // placeholder is a duplicate of that entry with none of its content. Only the
  // sidecar goes — the scripts belong to the real media now.
  //
  // Runs before the orphan pass so the reclaimed sidecars are gone before
  // anything asks who owns their scripts, and the answer is the real media.
  for (const placeholderId of db.reclaimablePlaceholderIds()) {
    const relPath = db.getMediaRelPath(placeholderId)
    if (!relPath) continue
    const sidecarAbs = tree.sidecars.get(relPath)
    if (!sidecarAbs) continue
    try {
      // Recycle bin rather than unlink: a placeholder the user had got as far
      // as titling or rating is still a duplicate, but it is not the app's to
      // destroy on a judgement call made during a background scan.
      await shell.trashItem(sidecarAbs)
    } catch {
      // The Recycle Bin goes through the Windows shell, which normalises the
      // path and so cannot reach a file whose folder name ends with a space or
      // a dot — `\\?\` does not help, the shell rejects it outright. Node's own
      // fs has no such trouble, so the choice is between deleting this one
      // outright and leaving an entry that can never be cleared and re-reports
      // itself on every scan. The file is a placeholder holding scripts that
      // now belong to a real entry: a duplicate with nothing of its own.
      try {
        await rm(sidecarAbs)
        console.warn(`[library] reclaimed placeholder ${relPath} without the recycle bin`)
      } catch (e) {
        console.error(`[library] could not reclaim placeholder ${relPath}:`, e)
        continue
      }
    }
    tree.sidecars.delete(relPath)
    db.remove(placeholderId)
    summary.placeholdersReclaimed += 1
  }

  // Step 7: scripts nobody owns. Runs after cleanup so the entries created here
  // are not immediately taken for rows whose file went away — and not at all
  // while a download is in flight, because a script whose video is still
  // downloading has an owner, it just has not arrived yet (see queue.isBusyFor).
  //
  // "Owns" now means "some sidecar names this file", read off the index, rather
  // than "some file next door has a matching name". The name test still decides
  // for scripts nothing has filed yet, which is the only case where the name is
  // all there is to go on.
  const claimed = db.referencedPathKeys()
  // A downloaded script still waiting for the user to pick its video is owned
  // too, by an answer that has not been given yet.
  for (const key of awaitingPairKeys(library.id, root)) claimed.add(key)
  for (const [dirRel, names] of tree.dirListings) {
    if (isBusyFor(library.id)) break
    const dirAbs = dirRel ? join(root, ...dirRel.split('/')) : root
    const isClaimed = (name: string): boolean =>
      claimed.has((dirRel ? `${dirRel}/${name}` : name).toLowerCase())
    for (const [base, scripts] of orphanScriptGroups(names, isClaimed, matchLevel)) {
      const created = await createScriptOnlyEntry(dirAbs, base, names, matchLevel).catch((e) => {
        console.error(`[library] could not file ${scripts[0]}:`, e)
        return null
      })
      if (!created) continue
      const relPath = dirRel ? `${dirRel}/${created.mediaName}` : created.mediaName
      db.upsertFromSidecar(
        created.meta,
        relPath,
        created.sidecarMtime,
        await entryFileTimes(root, relPath, created.meta)
      )
      summary.scriptOnlyEntries += 1
    }
  }

  if (summary.newerSidecars > 0) {
    // Their media is missing from the library until a build that understands
    // them runs again — which is better than reading half of one and writing
    // that half back.
    console.warn(
      `[scan] ${summary.newerSidecars} file(s) were written by a newer version of the app and were skipped`
    )
  }
  onProgress?.({ phase: 'done', processed: summary.mediaTotal, total: summary.mediaTotal })
  return summary
}

/**
 * An entry for scripts whose video is not here: on EroScripts the script is
 * often the free half and the video is bought elsewhere, so the scripts arrive
 * alone and would otherwise sit in the library as files nothing can reach.
 *
 * This is the same shape the download flow already creates for a paid post — a
 * sidecar with no media file and a `wanted` block saying the file never
 * arrived — so the library page, the detail panel and the "is this it?" prompt
 * all handle it without knowing where it came from.
 */
async function createScriptOnlyEntry(
  dirAbs: string,
  base: string,
  siblingNames: string[],
  level: CompanionMatchLevel
): Promise<{ mediaName: string; meta: MediaMeta; sidecarMtime: number } | null> {
  // `.mp4` is a placeholder extension: it is replaced by whatever the user
  // supplies later, and the sidecar is renamed to match.
  const mediaName = `${base}.mp4`
  const mediaAbs = join(dirAbs, mediaName)
  const sidecarAbs = sidecarPathFor(mediaAbs)
  // Nothing here should exist — an owner would have claimed the scripts — but
  // never write over a file on the strength of that.
  if (existsSync(mediaAbs) || existsSync(sidecarAbs)) return null

  const companions = groupCompanions(mediaName, siblingNames, level)
  if (companions.scriptVersions.length === 0) return null

  const now = new Date().toISOString()
  const meta: MediaMeta = {
    schemaVersion: MEDIA_META_VERSION,
    id: randomUUID(),
    // No file, so no fingerprint; it is written the moment one is attached.
    fileFingerprint: { size: 0, blake3Head: '' },
    wanted: { sources: [], dismissed: [], addedAt: now },
    // No title: the entry is named after the scripts that made it, which is
    // what the file name already says. Claiming it as a title would put a
    // script's name on the scene the day this placeholder is merged into one.
    tags: [],
    videoAuthors: [],
    scriptAuthors: [],
    studios: [],
    playlists: [],
    playlistRanks: {},
    sources: [],
    postLinks: [],
    scriptVersions: companions.scriptVersions,
    subtitles: companions.subtitles,
    userMeta: {},
    createdAt: now,
    updatedAt: now
  }
  await writeSidecar(sidecarAbs, meta)
  return { mediaName, meta, sidecarMtime: Math.floor((await stat(sidecarAbs)).mtimeMs) }
}
