import { net } from 'electron'
import { forumBaseUrl, isLoggedIn } from '../scraper/discourse'
import {
  DirectLinkExpiredError,
  HttpStatusError,
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'
import { fileNameFromUrl } from './direct'
import { httpDownloadToFile } from './http'
import { headStatus } from './link-check'

/**
 * Forum attachments (`<forum>/uploads/...`, including the `short-url` form).
 *
 * These look like plain links, but Discourse only serves an upload to a session
 * allowed to see the topic it belongs to — and hides the rest behind 404 rather
 * than 403. The generic direct plugin fetches with Node, which has no cookies,
 * so every script attached to a post came back "not found". This one fetches
 * through Electron's `net.fetch`, the same session the scraper reads posts with.
 */

/** Attachment URLs are hosted by the forum itself; nothing else claims them. */
export function isForumAttachment(url: string): boolean {
  return url.startsWith(forumBaseUrl()) && /\/uploads\//i.test(url)
}

/**
 * Turn a refusal into something the user can act on. Discourse answers 404 for
 * an upload the session may not see, so the status alone cannot tell "deleted"
 * from "not signed in" — ask the forum which one it is.
 */
async function explain(status: number): Promise<never> {
  if (status === 401 || status === 403 || status === 404) {
    throw new PermanentError((await isLoggedIn()) ? 'attachment_gone' : 'attachment_login')
  }
  throw new HttpStatusError(status)
}

export const attachmentPlugin: DownloaderPlugin = {
  id: 'attachment',

  match(url) {
    return isForumAttachment(url)
  },

  guessFileName(url) {
    return fileNameFromUrl(url) || 'download'
  },

  checkCost: 'cheap',

  /**
   * A 404 here means "gone" only for a session that would have been allowed to
   * see it. Signed out, the forum answers the same 404 for every upload in a
   * gated topic — marking those dead would condemn links that are perfectly
   * fine once the user logs in.
   */
  async check(url) {
    const status = await headStatus(url, { fetchImpl: net.fetch })
    if (status === 'gone' && !(await isLoggedIn())) return 'unknown'
    return status
  },

  /** The link is already direct; a `short-url` one redirects to the real file. */
  async resolve(url) {
    return { url, filename: fileNameFromUrl(url) || 'download' }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    try {
      const res = await httpDownloadToFile({
        url: info.url,
        partPath: targetPath,
        signal,
        onProgress,
        fetchImpl: net.fetch,
        // A page instead of the file means the forum answered with its own
        // sign-in screen; saving that as someone's funscript is worse than
        // failing.
        htmlIsError: 'attachment_login'
      })
      return {
        filePath: targetPath,
        sizeBytes: res.sizeBytes,
        ...(res.serverFileName ? { fileName: res.serverFileName } : {})
      }
    } catch (e) {
      // Nothing here is a signed URL, so a 403 is a refusal, not an expiry —
      // re-resolving would ask the same question and get the same answer.
      if (e instanceof DirectLinkExpiredError) return explain(e.httpStatus)
      if (e instanceof HttpStatusError) return explain(e.status)
      throw e
    }
  }
}
