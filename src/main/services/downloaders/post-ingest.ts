import { basename } from 'node:path'
import { DEFAULT_COMPANION_MATCH, FUNSCRIPT_EXTENSION } from '@shared/constants'
import type { ScrapedPost } from '@shared/schemas/scraped-post'
import { isMediaFile, scriptOwner } from '../library/companion-grouping'
import {
  addWantedMedia,
  attachPostDownload,
  attachScriptsToMedia,
  type DownloadedScript
} from '../library/library-manager'
import { videoAuthorFromTitle } from '../matcher/author'
import * as store from './store'

/**
 * Post-download ingest for a batch of jobs that came from one forum post:
 * the files land in the library and the post's metadata and tags are written
 * into their sidecars.
 *
 * It runs once, when every job of the batch has reached a terminal state —
 * scripts and video finish in any order, and the metadata write needs the
 * whole set. A partly-failed batch still runs: whatever did download should
 * still be filed correctly.
 */

/**
 * Who wrote the file behind this link.
 *
 * A thread's scripts are routinely redone by someone else in the replies, so
 * the poster of the reply a link came from is its author — the opening post's
 * author only stands in when the link was the author's own. The post is already
 * in hand here, and it records where every link came from, so no extra state
 * has to be persisted alongside the job to work this out.
 */
function authorOf(post: ScrapedPost, sourceUrl: string): { author?: string } {
  const link = post.links.find((l) => l.url === sourceUrl)
  const author = link?.fromPost?.author || post.author
  return author ? { author } : {}
}

/**
 * The post's links the app has no downloader for. Filed on the media so the
 * detail panel can still offer a way to them — they are usually the paid or
 * higher-quality version, and the post may not outlive the library.
 */
export function unfetchableLinks(post: ScrapedPost): { url: string; hoster: string; label: string }[] {
  return post.links
    .filter((l) => !l.downloadable)
    .map((l) => ({ url: l.url, hoster: l.hoster, label: l.note || l.label }))
}

/** Has every job in this batch stopped moving? */
export function batchSettled(batchId: string): boolean {
  return store
    .listBatch(batchId)
    .every((j) => j.state === 'done' || j.state === 'failed')
}

export async function finalizeBatch(batchId: string): Promise<void> {
  const jobs = store.listBatch(batchId)
  if (jobs.length === 0) return

  const raw = jobs.find((j) => j.postJson)?.postJson
  if (!raw) return
  let post: ScrapedPost
  try {
    post = JSON.parse(raw) as ScrapedPost
  } catch {
    console.error(`[downloads] batch ${batchId} has unreadable post metadata`)
    return
  }

  const done = jobs.filter((j) => j.state === 'done' && j.filePath)
  /*
   * What a file is comes from its name, not from the job's role: a cloud folder
   * arrives as one job per file all labelled `video`, because the link the user
   * ticked was the folder. The name on disk is the one to read — `finish` may
   * have had to add a suffix to avoid overwriting something.
   */
  const nameOf = (j: (typeof done)[number]): string => basename(j.filePath!)
  const videos = done.filter((j) => j.role === 'video' && isMediaFile(nameOf(j)))
  const scripts = done
    .filter((j) => j.role === 'script' || nameOf(j).toLowerCase().endsWith(FUNSCRIPT_EXTENSION))
    .map((j) => ({ absPath: j.filePath!, ...authorOf(post, j.sourceUrl) }))

  if (videos.length === 0) {
    // Scripts only. On EroScripts this is the normal shape for a paid scene:
    // the script is a free attachment and the video is sold elsewhere. Give
    // the scripts a home now — an entry with the post's title, tags and buying
    // links, waiting for the file — rather than leaving loose funscripts in the
    // library root for the user to reconcile later.
    if (scripts.length === 0) return
    const libraryId = done[0]?.libraryId ?? jobs[0]?.libraryId
    if (!libraryId) return
    const placeholder = await createWantedEntry(libraryId, post, scripts).catch((e) => {
      console.error(`[downloads] batch ${batchId} placeholder failed:`, e)
      return null
    })
    if (!placeholder) {
      console.log(`[downloads] batch ${batchId}: ${scripts.length} script(s) with no video job`)
    }
    return
  }

  const shares = shareScripts(videos.map(nameOf), scripts)
  const placed = [...shares.values()].reduce((n, s) => n + s.length, 0)
  if (placed < scripts.length) {
    console.log(
      `[downloads] batch ${batchId}: ${scripts.length - placed} script(s) match no video by name`
    )
  }

  const otherLinks = unfetchableLinks(post)
  /*
   * Who made the video, as opposed to who opened the thread. Read the same way
   * the match paths read it — off the title, checked against the post's tags —
   * so a download and a manually matched post file the same entry identically.
   * Without this a downloaded media arrived with a script author and no video
   * author at all, and the only way to fill it in was to go and find the post
   * the file had just come from.
   */
  const videoAuthor = videoAuthorFromTitle(post.title, post.tags)
  for (const video of videos) {
    const result = await attachPostDownload(
      video.libraryId,
      video.filePath!,
      {
        /*
         * The post's title names the post. With one video those are the same
         * thing; with several, stamping it on each would give a row of entries
         * the same name, so they keep the names their files came with.
         */
        title: videos.length === 1 ? post.title : '',
        tags: post.tags,
        postUrl: post.postUrl,
        author: post.author,
        ...(videoAuthor ? { videoAuthor } : {}),
        downloadUrl: video.sourceUrl,
        otherLinks
      },
      shares.get(nameOf(video)) ?? []
    ).catch((e) => {
      console.error(`[downloads] batch ${batchId} metadata apply failed for ${nameOf(video)}:`, e)
      return null
    })

    if (result?.duplicateOf) {
      // Not an error: the file downloaded fine. The user just now owns two
      // copies of the same content and deserves to be told which.
      store.update(video.id, { duplicateOf: result.duplicateOf })
    }
  }
}

/**
 * Which video each downloaded script belongs to, keyed by the video's filename.
 *
 * A post with one video takes everything: its scripts are routinely named after
 * the scene rather than after the file, and there is no other candidate to be
 * wrong about. A post with several — one scene per video, each with its own
 * script — has nothing but the names to go on, so each script goes to the video
 * whose name claims it under the same rule the scanner uses on a directory.
 *
 * A script no video claims, or one that two claim equally, is deliberately left
 * out: the scanner stands those up as entries of their own, which the user can
 * see and fix, rather than being folded into whichever video came first.
 */
function shareScripts(
  videoNames: string[],
  scripts: DownloadedScript[]
): Map<string, DownloadedScript[]> {
  const shares = new Map<string, DownloadedScript[]>(videoNames.map((n) => [n, []]))
  const placed = new Set<DownloadedScript>()
  if (videoNames.length === 1) {
    shares.set(videoNames[0]!, [...scripts])
    return shares
  }
  /*
   * Two passes, the second looser. The scan's default level answers a harder
   * question than this one — whether a companion belongs to a media at all —
   * and rejects `Ranni HJ.funscript` beside `Ranni HJ 4K.mp4` for it. Here the
   * files are already known to have come from one post, so the only question
   * left is which of a handful of videos it is, and a name found whole inside
   * another is enough to answer it. Widening never re-decides: the loose pass
   * only sees what the first one left over.
   */
  for (const level of [DEFAULT_COMPANION_MATCH, 'loose'] as const) {
    for (const script of scripts) {
      if (placed.has(script)) continue
      const owner = scriptOwner(videoNames, basename(script.absPath), level)
      if (owner) {
        shares.get(owner)!.push(script)
        placed.add(script)
      }
    }
  }
  return shares
}

/**
 * A library entry for a post whose video has to be bought, carrying the scripts
 * that did download. The scripts keep the names they arrived with; grouping
 * against the placeholder's base name is what makes them one script version.
 */
async function createWantedEntry(
  libraryId: string,
  post: ScrapedPost,
  scripts: DownloadedScript[]
): Promise<boolean> {
  // For an entry with no file yet, the unfetchable links are the buying links —
  // they are what the entry is waiting on, so they go in `wanted` where the
  // panel offers them. `postLinks` gets the same list, so they survive the
  // moment the file arrives and the `wanted` block is dropped.
  const otherLinks = unfetchableLinks(post)
  const videoAuthor = videoAuthorFromTitle(post.title, post.tags)
  const created = await addWantedMedia(libraryId, {
    title: post.title,
    tags: post.tags,
    postUrl: post.postUrl,
    ...(post.author ? { author: post.author } : {}),
    ...(videoAuthor ? { videoAuthor } : {}),
    sources: otherLinks,
    otherLinks
  })
  if (!created) return false
  await attachScriptsToMedia(libraryId, created.mediaId, scripts, {
    ...(post.author ? { author: post.author } : {}),
    postUrl: post.postUrl
  })
  return true
}
