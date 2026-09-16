import { basename } from 'node:path'
import { FUNSCRIPT_EXTENSION } from '@shared/constants'
import type { PairingRequest } from '@shared/schemas/download'
import type { ScrapedPost } from '@shared/schemas/scraped-post'
import { isMediaFile } from '../library/companion-grouping'
import { scriptBaseName } from '../library/late-companions'
import {
  addWantedMedia,
  attachPostDownload,
  attachScriptsToMedia,
  type DownloadedScript
} from '../library/library-manager'
import { videoAuthorFromTitle } from '../matcher/author'
import { pairScripts, type VideoCandidate } from './script-pairing'
import * as store from './store'

/**
 * Post-download ingest for a batch of jobs that came from one forum post:
 * the files land in the library and the post's metadata and tags are written
 * into their sidecars.
 *
 * It runs whenever the batch settles — every job done or failed — and files
 * only what no earlier pass filed. A batch settles more than once: a video
 * that failed is retried and arrives an hour later, and it must go into the
 * entry that was made for it in the meantime rather than start a new one.
 * What has been filed, and where, is recorded on each job, so the answer
 * survives a restart.
 *
 * Every video link is an entry of its own. When a video has not arrived, its
 * entry waits for it — with its scripts, its post's tags and the link it failed
 * to come from — and the file fills it the moment a retry brings it in.
 */

type Job = store.JobRecord

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

function readPost(jobs: Job[]): ScrapedPost | null {
  const raw = jobs.find((j) => j.postJson)?.postJson
  if (!raw) return null
  try {
    return JSON.parse(raw) as ScrapedPost
  } catch {
    return null
  }
}

/**
 * The name to read a job by. What a file is comes from its name, not from the
 * job's role: a cloud folder arrives as one job per file all labelled `video`,
 * because the link the user ticked was the folder. The name on disk is the one
 * to read once there is one — `finish` may have had to add a suffix.
 */
function nameOf(job: Job): string {
  return job.filePath ? basename(job.filePath) : job.fileName
}

function isScriptJob(job: Job): boolean {
  const namedAsScript = nameOf(job).toLowerCase().endsWith(FUNSCRIPT_EXTENSION)
  // A container inherits the role of the one link in the post even when it
  // holds both videos and scripts. Once a file has arrived, its real name wins.
  return job.state === 'done' ? namedAsScript : job.role === 'script' || namedAsScript
}

/**
 * A video the post offered. One that failed still counts — it is still the
 * video its scripts belong to — but a finished file that turned out to be
 * neither video nor script (an archive in a folder) does not.
 */
function isVideoJob(job: Job): boolean {
  if (job.state === 'done') return !isScriptJob(job) && isMediaFile(nameOf(job))
  return job.role === 'video' && !isScriptJob(job)
}

function toDownloaded(post: ScrapedPost, job: Job): DownloadedScript {
  return { absPath: job.filePath!, ...authorOf(post, job.sourceUrl) }
}

/** The author's words beside the link a job came from, when it came from one. */
function noteFor(post: ScrapedPost, job: Job): string {
  return post.links.find((l) => l.url === job.sourceUrl)?.note ?? ''
}

export async function finalizeBatch(batchId: string): Promise<void> {
  try {
    await fileBatch(batchId)
  } finally {
    /*
     * Whatever this pass could not file is handed to the scanner, which files
     * loose files by name. Until a job is marked, the queue tells the scanner to
     * keep its hands off the library — so a file nothing could place (its video
     * never got indexed, an archive from a folder, a post that would not read)
     * must not stay unmarked, or the library would wait on it for good. A
     * script waiting for the user is the one exception: it has an owner.
     */
    for (const job of store.listBatch(batchId)) {
      if (job.state === 'done' && !job.ingested && !job.awaitingPair) {
        store.update(job.id, { ingested: true })
      }
    }
  }
}

async function fileBatch(batchId: string): Promise<void> {
  const jobs = store.listBatch(batchId)
  const post = readPost(jobs)
  if (!post) {
    if (jobs.length > 0) console.error(`[downloads] batch ${batchId} has unreadable post metadata`)
    return
  }

  const videos = jobs.filter(isVideoJob)
  for (const video of videos) {
    if (video.state !== 'done' || !video.filePath || video.ingested) continue
    await fileVideo(batchId, post, video, videos.length)
  }

  const scripts = jobs.filter(
    (j) => isScriptJob(j) && j.state === 'done' && j.filePath && !j.ingested && !j.awaitingPair
  )
  if (scripts.length === 0) return

  if (videos.length === 0) {
    await fileScriptsOnly(batchId, post, jobs, scripts)
    return
  }

  // Re-read: filing the videos recorded which entry each one went into.
  const current = store.listBatch(batchId).filter(isVideoJob)
  const { settled } = pairScripts(
    candidates(post, current),
    scripts.map((s) => ({ id: s.id, fileName: nameOf(s) }))
  )

  const byVideo = new Map<string, Job[]>()
  for (const script of scripts) {
    const videoId = settled.get(script.id)
    if (videoId) byVideo.set(videoId, [...(byVideo.get(videoId) ?? []), script])
  }
  for (const [videoId, list] of byVideo) {
    const video = current.find((v) => v.id === videoId)!
    const entry = await entryForVideo(post, video, current.length)
    if (entry) await fileScripts(video.libraryId, entry, post, list)
    else console.error(`[downloads] batch ${batchId}: no entry for ${nameOf(video)}; scripts left loose`)
  }

  const unsure = scripts.filter((s) => !settled.has(s.id))
  for (const script of unsure) store.update(script.id, { awaitingPair: true })
  if (unsure.length > 0) {
    console.log(`[downloads] batch ${batchId}: ${unsure.length} script(s) wait for a video to be picked`)
  }
}

/** The post's metadata onto a video that arrived. */
async function fileVideo(
  batchId: string,
  post: ScrapedPost,
  video: Job,
  videoCount: number
): Promise<void> {
  // Filled straight into the entry that was waiting for it, which already
  // carries the post.
  if (video.mediaId) {
    store.update(video.id, { ingested: true })
    return
  }
  const result = await attachPostDownload(
    video.libraryId,
    video.filePath!,
    {
      /*
       * The post's title names the post. With one video those are the same
       * thing; with several, stamping it on each would give a row of entries
       * the same name, so they keep the names their files came with.
       */
      title: videoCount === 1 ? post.title : '',
      tags: post.tags,
      postUrl: post.postUrl,
      author: post.author,
      /*
       * Who made the video, as opposed to who opened the thread. Read the same
       * way the match paths read it — off the title, checked against the
       * post's tags — so a download and a manually matched post file the same
       * entry identically.
       */
      ...videoAuthorOf(post),
      downloadUrl: video.sourceUrl,
      otherLinks: unfetchableLinks(post)
    },
    []
  ).catch((e) => {
    console.error(`[downloads] batch ${batchId} metadata apply failed for ${nameOf(video)}:`, e)
    return null
  })

  store.update(video.id, {
    ingested: true,
    ...(result ? { mediaId: result.mediaId } : {}),
    // Not an error: the file downloaded fine. The user just now owns two
    // copies of the same content and deserves to be told which.
    ...(result?.duplicateOf ? { duplicateOf: result.duplicateOf } : {})
  })
}

function videoAuthorOf(post: ScrapedPost): { videoAuthor?: string } {
  const videoAuthor = videoAuthorFromTitle(post.title, post.tags)
  return videoAuthor ? { videoAuthor } : {}
}

/**
 * The entry a video's scripts go into: the one it was filed into when it
 * arrived, or — when it has not arrived — one made to wait for it.
 */
async function entryForVideo(
  post: ScrapedPost,
  video: Job,
  videoCount: number
): Promise<string | null> {
  const current = store.get(video.id) ?? video
  if (current.mediaId) return current.mediaId
  // Arrived but never got indexed: there is nothing to attach to, and a
  // placeholder beside the real file would be a duplicate of it.
  if (current.state === 'done') return null

  const link = post.links.find((l) => l.url === current.sourceUrl)
  const note = link?.note ?? ''
  const otherLinks = unfetchableLinks(post)
  const created = await addWantedMedia(current.libraryId, {
    // One video: the post's title. Several: the post's title and what the
    // author called this one, so a row of placeholders can be told apart.
    title: videoCount === 1 || !note ? post.title : `${post.title} (${note})`,
    tags: post.tags,
    postUrl: post.postUrl,
    ...(post.author ? { author: post.author } : {}),
    ...videoAuthorOf(post),
    // The link it failed to come from is the first place to try again.
    sources: [
      { url: current.sourceUrl, hoster: link?.hoster ?? current.hoster, label: note || nameOf(current) },
      ...otherLinks
    ],
    otherLinks
  }).catch((e) => {
    console.error(`[downloads] placeholder for ${nameOf(current)} failed:`, e)
    return null
  })
  if (!created) return null
  store.update(current.id, { mediaId: created.mediaId })
  return created.mediaId
}

async function fileScripts(
  libraryId: string,
  mediaId: string,
  post: ScrapedPost,
  scripts: Job[]
): Promise<void> {
  await attachScriptsToMedia(
    libraryId,
    mediaId,
    scripts.map((s) => toDownloaded(post, s)),
    { postUrl: post.postUrl }
  )
  for (const script of scripts) {
    store.update(script.id, { ingested: true, awaitingPair: false, mediaId })
  }
}

/**
 * Scripts with no video link at all. On EroScripts this is the normal shape
 * for a paid scene: the script is a free attachment and the video is sold
 * elsewhere. They get a home now — an entry with the post's title, tags and
 * buying links, waiting for the file — rather than sitting in the library root
 * as loose funscripts for the user to reconcile later.
 */
async function fileScriptsOnly(
  batchId: string,
  post: ScrapedPost,
  jobs: Job[],
  scripts: Job[]
): Promise<void> {
  // A script retried after the rest were filed joins the entry they made.
  const earlier = jobs.find((j) => isScriptJob(j) && j.ingested && j.mediaId)?.mediaId
  const libraryId = scripts[0]!.libraryId
  const entry = earlier ?? (await createWantedEntry(libraryId, post, post.title))
  if (!entry) {
    console.log(`[downloads] batch ${batchId}: ${scripts.length} script(s) with no video job`)
    return
  }
  await fileScripts(libraryId, entry, post, scripts)
}

/**
 * A library entry for a post whose video has to be bought or fetched by hand.
 * For such an entry the unfetchable links are the buying links — they are
 * what it is waiting on, so they go in `wanted` where the panel offers them.
 * `postLinks` gets the same list, so they survive the moment the file arrives
 * and the `wanted` block is dropped.
 */
async function createWantedEntry(
  libraryId: string,
  post: ScrapedPost,
  title: string
): Promise<string | null> {
  const otherLinks = unfetchableLinks(post)
  const created = await addWantedMedia(libraryId, {
    title,
    tags: post.tags,
    postUrl: post.postUrl,
    ...(post.author ? { author: post.author } : {}),
    ...videoAuthorOf(post),
    sources: otherLinks,
    otherLinks
  }).catch((e) => {
    console.error(`[downloads] placeholder for ${post.postUrl} failed:`, e)
    return null
  })
  return created?.mediaId ?? null
}

/** How a video reads to the pairing: its file, the author's note, its link. */
function candidates(post: ScrapedPost, videos: Job[]): VideoCandidate[] {
  return videos.map((video) => ({
    id: video.id,
    fileName: video.state === 'done' && video.filePath ? basename(video.filePath) : null,
    descriptions: [video.fileName, noteFor(post, video), pathOf(video.sourceUrl)]
  }))
}

/** The path of a link, where sites put the video's slug; the host says nothing. */
function pathOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname)
  } catch {
    return ''
  }
}

/** Scripts waiting for the user to pick their video, one request per post. */
export function pairingRequests(): PairingRequest[] {
  const byBatch = new Map<string, Job[]>()
  for (const job of store.listAwaitingPair()) {
    if (!job.batchId) continue
    byBatch.set(job.batchId, [...(byBatch.get(job.batchId) ?? []), job])
  }

  const requests: PairingRequest[] = []
  for (const [batchId, waiting] of byBatch) {
    const jobs = store.listBatch(batchId)
    const post = readPost(jobs)
    const videos = jobs.filter(isVideoJob)
    if (!post || videos.length === 0) continue
    const { settled, guesses } = pairScripts(
      candidates(post, videos),
      waiting.map((s) => ({ id: s.id, fileName: nameOf(s) }))
    )
    requests.push({
      batchId,
      postTitle: post.title,
      postUrl: post.postUrl,
      postThumb: post.previewImage,
      videos: videos.map((video) => ({
        jobId: video.id,
        fileName: nameOf(video),
        note: noteFor(post, video),
        arrived: video.state === 'done'
      })),
      scripts: waiting.map((script) => ({
        jobId: script.id,
        fileName: nameOf(script),
        guess: settled.get(script.id) ?? guesses.get(script.id) ?? null
      }))
    })
  }
  return requests
}

/**
 * The user's answer for scripts that were waiting: each goes to the video they
 * picked, or becomes an entry of its own. Anything not in the answer keeps
 * waiting.
 */
export async function resolvePairing(
  batchId: string,
  assignments: { jobId: string; target: string }[]
): Promise<void> {
  const jobs = store.listBatch(batchId)
  const post = readPost(jobs)
  if (!post) return
  const videos = jobs.filter(isVideoJob)
  const waiting = new Map(
    jobs.filter((j) => j.awaitingPair && j.state === 'done' && j.filePath).map((j) => [j.id, j])
  )

  const byVideo = new Map<string, Job[]>()
  const standalone: Job[] = []
  for (const { jobId, target } of assignments) {
    const script = waiting.get(jobId)
    if (!script) continue
    if (target === OWN_ENTRY) standalone.push(script)
    else if (videos.some((v) => v.id === target)) {
      byVideo.set(target, [...(byVideo.get(target) ?? []), script])
    }
  }

  for (const [videoId, list] of byVideo) {
    const video = videos.find((v) => v.id === videoId)!
    const entry = await entryForVideo(post, video, videos.length)
    if (entry) await fileScripts(video.libraryId, entry, post, list)
  }
  for (const script of standalone) {
    const entry = await createWantedEntry(
      script.libraryId,
      post,
      scriptBaseName(nameOf(script))
    )
    if (entry) await fileScripts(script.libraryId, entry, post, [script])
  }
}

/** The answer that files a script as an entry of its own. */
export const OWN_ENTRY = 'own'
