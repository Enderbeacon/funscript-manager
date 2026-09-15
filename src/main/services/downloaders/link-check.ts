import { getSettings } from '../config/config-service'
import {
  DirectLinkExpiredError,
  HttpStatusError,
  PermanentError,
  QuotaExceededError,
  findPlugin,
  type LinkStatus
} from './base'

/**
 * "Is this link still good?" — asked of a post's links before the user picks
 * one, so a video that was taken down two years ago is visible as such instead
 * of becoming a download that fails.
 *
 * The check is deliberately the same code path the download would take:
 * resolve() is what a job does first, and a host that will not resolve a link
 * will not serve it either. A plugin overrides that with check() only when
 * resolving does not actually ask the host anything.
 *
 * Nothing here is allowed to guess. A host that answers something unexpected
 * leaves the link `unknown`, which shows as "not checked" — telling a user a
 * live link is dead is worse than telling them nothing.
 */

/**
 * Failure codes that mean the file is not there. A wrong or expired *link* is
 * in here too: for whoever is looking at the post, "the uploader's link no
 * longer works" is one situation, not three.
 */
const DEAD_REASONS = new Set([
  'attachment_gone',
  'mega_gone',
  'mega_bad_link',
  'gofile_gone',
  'gdrive_gone',
  'gdrive_private',
  'dropbox_gone',
  'mediafire_gone',
  'ytdlp_unavailable'
])

/** How long an answer stays good. Long enough for a browsing session. */
const TTL_MS = 10 * 60 * 1000
/** Hosts are asked a few at a time; a post can carry a dozen links. */
const CONCURRENCY = 4

const cache = new Map<string, { at: number; status: LinkStatus }>()

function cached(url: string): LinkStatus | null {
  const hit = cache.get(url)
  if (!hit) return null
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(url)
    return null
  }
  return hit.status
}

async function probe(url: string): Promise<LinkStatus> {
  const plugin = findPlugin(url)
  if (!plugin) return 'unknown'
  try {
    if (plugin.check) return await plugin.check(url)
    // A folder link is not a file, and `resolve` is entitled to refuse one —
    // mega's says `mega_bad_link` for a directory, which read as "this link is
    // dead" and marked every mega folder in every post as gone. What a download
    // actually does with a container is expand it first, so that is what asking
    // about one has to do too. Listing its contents is the existence proof.
    if (plugin.expand) {
      const inside = await plugin.expand(url)
      if (inside.length > 0 && !(inside.length === 1 && inside[0] === url)) return 'alive'
      // `[url]` back means the plugin could not expand it (an empty or
      // unreadable folder, or a plain file link). Fall through and ask about
      // the URL itself, which is the right question in both cases.
    }
  } catch (e) {
    // Expanding failed. A container is not a file, so `resolve` cannot be
    // asked about it as a fallback — mega refuses a directory outright — and
    // the only honest reading of a failed listing is the failure itself.
    return verdict(e)
  }
  try {
    await plugin.resolve(url)
    return 'alive'
  } catch (e) {
    return verdict(e)
  }
}

/** What a thrown error says about the file behind the link. */
function verdict(e: unknown): LinkStatus {
  // The file is there; the host is rationing it. Not a dead link.
  if (e instanceof QuotaExceededError) return 'alive'
  if (e instanceof PermanentError) return DEAD_REASONS.has(e.reason) ? 'gone' : 'unknown'
  if (e instanceof HttpStatusError) return e.status === 404 || e.status === 410 ? 'gone' : 'unknown'
  // A signed link that timed out says nothing about the file behind it.
  if (e instanceof DirectLinkExpiredError) return 'unknown'
  return 'unknown'
}

/**
 * Probes running right now, keyed by URL.
 *
 * Without this, two checks of the same link started before either finished
 * both hit the host, and whichever landed second overwrote the first — so a
 * link could read alive and then flip to dead on a transient hiccup, with the
 * dead answer cached for the next ten minutes. One question, one answer.
 */
const inFlight = new Map<string, Promise<LinkStatus>>()

function probeOnce(url: string): Promise<LinkStatus> {
  const running = inFlight.get(url)
  if (running) return running
  const task = probe(url).finally(() => inFlight.delete(url))
  inFlight.set(url, task)
  return task
}

/**
 * Ask a host whether a file is there without downloading it. For plugins whose
 * resolve() is pure URL rewriting, this is the only thing that touches the net.
 *
 * HEAD first, because it is the question being asked. Plenty of CDNs answer it
 * with 403 or 405 anyway, so those fall back to asking for the first byte —
 * which every host that serves ranges will answer, and which is small enough
 * to throw away.
 */
export async function headStatus(
  url: string,
  opts: {
    fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
    headers?: Record<string, string>
  } = {}
): Promise<LinkStatus> {
  const call = opts.fetchImpl ?? fetch
  const headers = opts.headers ?? {}
  const read = (res: Response): LinkStatus | null => {
    if (res.status === 404 || res.status === 410) return 'gone'
    if (res.ok || res.status === 206) return 'alive'
    return null
  }
  try {
    const head = await call(url, { method: 'HEAD', headers, redirect: 'follow' })
    await head.body?.cancel().catch(() => {})
    const verdict = read(head)
    if (verdict) return verdict
    if (head.status !== 403 && head.status !== 405 && head.status !== 501) return 'unknown'

    const ranged = await call(url, {
      method: 'GET',
      headers: { ...headers, Range: 'bytes=0-0' },
      redirect: 'follow'
    })
    await ranged.body?.cancel().catch(() => {})
    return read(ranged) ?? 'unknown'
  } catch {
    // Offline, DNS, a TLS refusal — none of that is the file being gone.
    return 'unknown'
  }
}

/** Would checking this link happen on its own, or does it need asking for? */
export function isCheapToCheck(url: string): boolean {
  return findPlugin(url)?.checkCost === 'cheap'
}

export interface CheckOptions {
  /**
   * The user pointed at this link and pressed check. Overrides the setting:
   * they are asking for this one and are prepared to wait for a page parse or
   * a browser window.
   */
  force?: boolean
}

/** Would this link be checked on its own, under the current setting? */
async function checkedUnasked(url: string): Promise<boolean> {
  const mode = (await getSettings()).download.linkCheck
  if (mode === 'off') return false
  if (mode === 'all') return true
  return isCheapToCheck(url)
}

/**
 * Check a batch of links. Anything the setting says to leave alone comes back
 * `unchecked` — an offer, not a verdict — so the caller can hand over every
 * link in a post and let this decide what is worth asking about.
 */
export async function checkLinks(
  urls: string[],
  options: CheckOptions = {}
): Promise<Record<string, LinkStatus>> {
  const result: Record<string, LinkStatus> = {}
  const todo: string[] = []

  for (const url of urls) {
    const hit = cached(url)
    if (hit) {
      result[url] = hit
      continue
    }
    if (!options.force && !(await checkedUnasked(url))) {
      result[url] = 'unchecked'
      continue
    }
    todo.push(url)
  }

  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < todo.length; i = next++) {
      const url = todo[i]!
      const status = await probeOnce(url)
      // An `unknown` is not an answer worth remembering: the next attempt,
      // possibly a forced one, should ask again rather than repeat a shrug.
      if (status === 'alive' || status === 'gone') cache.set(url, { at: Date.now(), status })
      result[url] = status
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker))

  return result
}

/** Test seam, and the way a retry stops seeing a stale "gone". */
export function forgetLinkChecks(): void {
  cache.clear()
  inFlight.clear()
}
