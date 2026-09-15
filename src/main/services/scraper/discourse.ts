import { BrowserWindow, app, net, session } from 'electron'
import { AppError } from '@shared/errors'
import type { ScrapedPost } from '@shared/schemas/scraped-post'
import { canDownload } from '../downloaders/base'
import { parseTopic, type TopicJson } from './post-parser'

/**
 * EroScripts (Discourse) JSON API client.
 *
 * Requests go through Electron's `net.fetch` on the default session, so the
 * cookies the user picks up in the login window are carried automatically and
 * there is no cookie jar to maintain. Everything is serialized behind a 1 req/s
 * gate: Discourse does not rate-limit us, but hammering a community forum from
 * a desktop app is how an app gets blocked.
 *
 * The base URL is overridable so smokes can run against a local stub.
 */

const BASE = (process.env.FSMGR_EROSCRIPTS_BASE || 'https://discuss.eroscripts.com').replace(
  /\/+$/,
  ''
)
const MIN_INTERVAL_MS = 1000
/**
 * Search gets its own, wider spacing.
 *
 * Not because the forum makes us: fifteen back-to-back searches drew no 429 at
 * all when this was measured. It is because search is the one endpoint
 * Discourse does not serve from cache — every query runs against the search
 * index — and a matching pass over a whole library is thousands of them. The
 * jitter keeps a long run from arriving as a metronome.
 */
const SEARCH_MIN_INTERVAL_MS = 2000
const SEARCH_JITTER_MS = 600
/** Discourse sets `_t` on login; its presence is our "signed in" signal. */
const SESSION_COOKIE = '_t'

function userAgent(): string {
  return `FunscriptManager/${app.getVersion()} (+https://github.com/Enderbeacon/funscript-manager)`
}

type RequestKind = 'default' | 'search'

let gate: Promise<unknown> = Promise.resolve()
let lastRequestAt = 0
let lastSearchAt = 0

/**
 * Serialize every forum request.
 *
 * One chain, so two requests are never in flight at once, with a per-kind
 * minimum spacing on top: everything waits 1s behind the previous request, and
 * a search additionally waits out the search interval since the last search.
 */
function schedule<T>(fn: () => Promise<T>, kind: RequestKind = 'default'): Promise<T> {
  const run = gate.then(async () => {
    const now = Date.now()
    let wait = MIN_INTERVAL_MS - (now - lastRequestAt)
    if (kind === 'search') {
      const searchWait =
        SEARCH_MIN_INTERVAL_MS + Math.random() * SEARCH_JITTER_MS - (now - lastSearchAt)
      wait = Math.max(wait, searchWait)
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    try {
      return await fn()
    } finally {
      lastRequestAt = Date.now()
      if (kind === 'search') lastSearchAt = lastRequestAt
    }
  })
  // Keep the chain alive even when a call rejects.
  gate = run.catch(() => undefined)
  return run
}

/** Forum origin, for anything that has to recognise a link as belonging to it. */
export function forumBaseUrl(): string {
  return BASE
}

/** Topic id out of any EroScripts URL form: /t/slug/123, /t/123, /t/slug/123/45. */
export function topicIdFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const at = segments.indexOf('t')
    if (at === -1) return null
    for (const segment of segments.slice(at + 1)) {
      if (/^\d+$/.test(segment)) return Number(segment)
    }
    return null
  } catch {
    return null
  }
}

/**
 * The slug out of a `/t/<slug>` address that carries no id at all.
 *
 * Search results and shared links come in this shape, and the forum resolves
 * them itself: `/t/<slug>.json` answers 301 to the canonical `/t/<slug>/<id>`,
 * query string kept. So the slug is worth carrying rather than rejecting as
 * "not a post link" — the redirect costs nothing and the id comes back in the
 * body. Only for this forum's own origin, so a `/t/` path on some other host
 * still fails as itself instead of being asked about here.
 */
export function topicSlugFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.origin !== new URL(BASE).origin) return null
    const segments = parsed.pathname.split('/').filter(Boolean)
    const at = segments.indexOf('t')
    // Exactly one segment after `/t/`, and not a number — a number is an id,
    // which topicIdFromUrl has already had its turn at.
    if (at === -1 || segments.length !== at + 2) return null
    const slug = segments[at + 1]!
    return /^\d+$/.test(slug) ? null : slug
  } catch {
    return null
  }
}

/**
 * A single-post permalink: `/p/<postId>`.
 *
 * The forum's own share button hands these out, and they carry a *post* id,
 * which is a different number space from the topic id — it has to be resolved
 * before anything else can use it.
 */
export function permalinkPostIdFromUrl(url: string): number | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean)
    if (segments[0] !== 'p' || segments.length < 2) return null
    return /^\d+$/.test(segments[1]!) ? Number(segments[1]) : null
  } catch {
    return null
  }
}

/** Does this look like a forum post URL (so the UI should scrape, not download)? */
export function isPostUrl(url: string): boolean {
  try {
    if (new URL(url).origin !== new URL(BASE).origin) return false
    return (
      topicIdFromUrl(url) !== null ||
      permalinkPostIdFromUrl(url) !== null ||
      topicSlugFromUrl(url) !== null
    )
  } catch {
    return false
  }
}

/** `/p/<postId>` → the topic it lives in, via the post's own endpoint. */
async function topicIdFromPermalink(postId: number): Promise<number | null> {
  const res = await schedule(() =>
    net.fetch(`${BASE}/posts/${postId}.json`, {
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' }
    })
  )
  if (!res.ok) return null
  try {
    const post = (await res.json()) as { topic_id?: number }
    return typeof post.topic_id === 'number' ? post.topic_id : null
  } catch {
    return null
  }
}

async function hasSessionCookie(): Promise<boolean> {
  const cookies = await session.defaultSession.cookies.get({
    url: BASE,
    name: SESSION_COOKIE
  })
  return cookies.length > 0
}

/** Verified answers are cached briefly; this runs on every failure path. */
const SESSION_CHECK_TTL_MS = 60_000
let sessionCheck: { at: number; valid: boolean } | null = null

/**
 * Ask the forum who it thinks we are.
 *
 * A cookie sitting in the jar is not a session. Discourse rotates its auth
 * token, and a stale `_t` leaves the app saying "signed in" while every request
 * is served as anonymous — which on this forum means **404 for every topic**,
 * so the failure reads as "that post does not exist" rather than "sign in
 * again". That is exactly how a real report came in.
 *
 * A network failure is not taken as proof of being signed out: the cookie's
 * presence stands in until the next check.
 */
async function sessionAccepted(): Promise<boolean> {
  const now = Date.now()
  if (sessionCheck && now - sessionCheck.at < SESSION_CHECK_TTL_MS) return sessionCheck.valid
  try {
    const res = await schedule(() =>
      net.fetch(`${BASE}/session/current.json`, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' }
      })
    )
    const valid = res.ok
    sessionCheck = { at: now, valid }
    return valid
  } catch {
    return true
  }
}

/** Forget the cached answer — the session just changed under us. */
function forgetSessionCheck(): void {
  sessionCheck = null
}

export async function isLoggedIn(): Promise<boolean> {
  if (!(await hasSessionCookie())) return false
  return sessionAccepted()
}

/**
 * Fetch and parse one post. Throws `scrape_login_required` on 401/403 so the
 * UI can offer the login window and retry.
 */
export async function fetchPost(
  url: string,
  onProgress?: (read: number, total: number) => void
): Promise<ScrapedPost> {
  const permalinkId = permalinkPostIdFromUrl(url)
  let topicId = topicIdFromUrl(url)
  if (topicId === null && permalinkId !== null) {
    topicId = await topicIdFromPermalink(permalinkId)
    // The address was a permalink, so this is not "that is not a post link" —
    // the post it points at is gone or out of reach.
    if (topicId === null) throw new AppError('scrape_post_not_found', { url, topicId: permalinkId })
  }
  const slug = topicId === null ? topicSlugFromUrl(url) : null
  if (topicId === null && slug === null) throw new AppError('scrape_not_a_post', { url })

  // A slug stands in for the id: the forum redirects the id-less address onto
  // the canonical one, so this is still a single request either way.
  const topicRef = topicId !== null ? String(topicId) : slug!

  // `include_raw=true` is not optional: without it Discourse serves only the
  // rendered `cooked` HTML, and every external link in the post (pixeldrain,
  // mega, a video page) is invisible to the parser. The parser falls back to
  // cooked if raw is missing anyway, but this is the good path.
  const res = await schedule(() =>
    net.fetch(`${BASE}/t/${topicRef}.json?include_raw=true`, {
      headers: { 'User-Agent': userAgent(), Accept: 'application/json' }
    })
  )

  if (!res.ok) {
    // Say what was actually asked for. A report of "that post does not exist"
    // is impossible to act on without knowing which id we derived from the
    // pasted address and whether the session was carried.
    const signedIn = await isLoggedIn()
    console.warn(
      `[scrape] ${res.status} for topic ${topicRef} (from ${url}); signed in: ${signedIn}`
    )
    if (res.status === 401 || res.status === 403) throw new AppError('scrape_login_required')
    // This forum serves 404 — not 403 — for anything an anonymous visitor asks
    // for, so a 404 on a session the forum no longer accepts means "sign in
    // again", not "the topic is gone". Saying the latter sends the user looking
    // for a deleted post that is sitting right there in their browser.
    if (res.status === 404 && !signedIn) throw new AppError('scrape_login_required')
    // The id goes in the message, not just the log: the main-process console is
    // not something a user can read, and the id is the one thing that separates
    // "we parsed the wrong number out of your link" from "the topic is gone".
    if (res.status === 404) throw new AppError('scrape_post_not_found', { url, topicId: topicRef })
    throw new AppError('scrape_failed', { status: String(res.status) })
  }

  let topic: TopicJson
  try {
    topic = (await res.json()) as TopicJson
  } catch {
    // A login redirect serving HTML is the usual cause here.
    throw new AppError('scrape_login_required')
  }

  if (topicId === null) {
    // Came in by slug: the id the redirect landed on is what pages the rest of
    // the thread.
    const resolved = topic.id
    if (typeof resolved !== 'number') {
      throw new AppError('scrape_post_not_found', { url, topicId: topicRef })
    }
    topicId = resolved
  }

  await readRemainingPosts(topicId, topic, onProgress)
  return parseTopic(topic, url, BASE, { isDownloadable: canDownload })
}

/**
 * One search result, flattened out of Discourse's parallel `topics`/`posts`
 * arrays.
 *
 * What matters here is how much a single search already answers: the title,
 * the full tag list, a preview image and the opening post's excerpt all come
 * back with it. A hit therefore needs no follow-up fetch to be applied — the
 * expensive read of the thread is only for evidence, not for metadata.
 */
export interface TopicHit {
  topicId: number
  url: string
  title: string
  slug: string
  tags: string[]
  /** Whoever posted the matched post — for a first post, the script's author. */
  username: string
  postsCount: number
  createdAt: string
  thumbnailUrl: string
  /** Opening-post text, truncated by the forum. */
  excerpt: string
  /** Text around the search hit; often carries the attachment's real filename. */
  blurb: string
}

export interface SearchResult {
  hits: TopicHit[]
  /** The forum had more than it returned — the query was too broad to mean much. */
  more: boolean
}

/** Anything past this in one query and the query itself was the problem. */
const SEARCH_PAGE_SIZE = 50

/**
 * `tags` comes back as objects here just as it does on a topic, and the same
 * defence applies: one unexpected shape and the whole result fails IPC schema
 * validation on the way out.
 */
function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => {
      if (typeof t === 'string') return t
      if (t && typeof t === 'object') {
        const o = t as Record<string, unknown>
        for (const key of ['name', 'tag', 'text', 'slug']) {
          if (typeof o[key] === 'string') return o[key] as string
        }
      }
      return ''
    })
    .filter(Boolean)
}

interface SearchJson {
  topics?: {
    id?: number
    title?: string
    slug?: string
    tags?: unknown
    posts_count?: number
    created_at?: string
    excerpt?: string
    thumbnails?: { url?: string; width?: number }[] | null
  }[]
  posts?: { topic_id?: number; username?: string; blurb?: string; post_number?: number }[]
  grouped_search_result?: { more_full_page_results?: boolean | null }
}

/** Smallest thumbnail that is still worth looking at. */
function pickThumbnail(thumbnails: { url?: string; width?: number }[] | null | undefined): string {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return ''
  const sized = thumbnails.filter((t) => typeof t.url === 'string' && t.url)
  if (sized.length === 0) return ''
  const small = sized
    .filter((t) => (t.width ?? 0) >= 200)
    .sort((a, b) => (a.width ?? 0) - (b.width ?? 0))[0]
  return (small ?? sized[0])?.url ?? ''
}

/**
 * Ask the forum's own search.
 *
 * Measured against real library filenames: a raw filename — resolution suffix,
 * site name, comma-separated tag run and all — returns the one right topic.
 * The forum's search is forgiving about extra words, so the caller's first
 * query should be the name as it sits on disk rather than something cleaned up
 * for it. `in:title` is the trap here: it drops every post whose terms live in
 * the body, which is most of them.
 */
export async function searchTopics(query: string): Promise<SearchResult> {
  const term = query.trim()
  if (!term) return { hits: [], more: false }

  const res = await schedule(
    () =>
      net.fetch(`${BASE}/search.json?q=${encodeURIComponent(term)}`, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' }
      }),
    'search'
  )

  if (res.status === 429) {
    // Never seen in testing, which is exactly why it is handled: the one time
    // it happens will be in the middle of somebody's thousand-entry run.
    const retryAfter = Number(res.headers.get('retry-after'))
    throw new AppError('scrape_rate_limited', {
      seconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 60
    })
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new AppError('scrape_login_required')
    if (res.status === 404 && !(await isLoggedIn())) throw new AppError('scrape_login_required')
    throw new AppError('scrape_failed', { status: String(res.status) })
  }

  let body: SearchJson
  try {
    body = (await res.json()) as SearchJson
  } catch {
    throw new AppError('scrape_login_required')
  }

  const posts = body.posts ?? []
  const hits: TopicHit[] = []
  for (const topic of body.topics ?? []) {
    if (typeof topic.id !== 'number') continue
    const post = posts.find((p) => p.topic_id === topic.id)
    const slug = typeof topic.slug === 'string' ? topic.slug : ''
    hits.push({
      topicId: topic.id,
      url: `${BASE}/t/${slug || 'topic'}/${topic.id}`,
      title: typeof topic.title === 'string' ? topic.title : '',
      slug,
      tags: tagNames(topic.tags),
      username: typeof post?.username === 'string' ? post.username : '',
      postsCount: typeof topic.posts_count === 'number' ? topic.posts_count : 0,
      createdAt: typeof topic.created_at === 'string' ? topic.created_at : '',
      thumbnailUrl: pickThumbnail(topic.thumbnails),
      excerpt: typeof topic.excerpt === 'string' ? topic.excerpt : '',
      blurb: typeof post?.blurb === 'string' ? post.blurb : ''
    })
  }

  return {
    hits,
    more: body.grouped_search_result?.more_full_page_results === true || hits.length >= SEARCH_PAGE_SIZE
  }
}

/** How many post ids to ask for per follow-up request. */
const POSTS_PER_PAGE = 20

/**
 * A backstop, not a policy. Threads that matter run to a few hundred posts and
 * are read in full; this only stops a pathological one from turning into
 * minutes of requests. When it bites the user is told, because a quietly
 * truncated read looks exactly like a thread with no replacement links in it.
 */
const MAX_POSTS = 1000

/**
 * Read the rest of the thread into `topic.post_stream.posts`.
 *
 * The first response carries about twenty posts and the ids of all the others.
 * Replacement links live wherever they happen to live — a thread often gets
 * re-uploaded several times over its life — so the whole thread is read rather
 * than a first page of it. Requests stay behind the same 1/s gate, which is
 * what makes this take a moment on a long thread.
 */
async function readRemainingPosts(
  topicId: number,
  topic: TopicJson,
  onProgress?: (read: number, total: number) => void
): Promise<void> {
  const stream = topic.post_stream?.stream ?? []
  const posts = topic.post_stream?.posts ?? []
  if (stream.length === 0 || posts.length === 0) return

  const have = new Set(posts.map((p) => p.id).filter((id): id is number => typeof id === 'number'))
  const missing = stream.filter((id) => !have.has(id)).slice(0, Math.max(0, MAX_POSTS - posts.length))
  const dropped = stream.length - posts.length - missing.length
  if (dropped > 0) {
    console.warn(`[scrape] topic ${topicId}: reading ${MAX_POSTS} posts, ${dropped} left unread`)
  }
  if (missing.length === 0) return

  const total = posts.length + missing.length
  onProgress?.(posts.length, total)

  for (let at = 0; at < missing.length; at += POSTS_PER_PAGE) {
    const page = missing.slice(at, at + POSTS_PER_PAGE)
    const query = page.map((id) => `post_ids[]=${id}`).join('&')
    const res = await schedule(() =>
      net.fetch(`${BASE}/t/${topicId}/posts.json?${query}&include_raw=true`, {
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' }
      })
    )
    if (!res.ok) {
      // Partial is fine here: the opening post is already in hand, and the
      // links found so far are still worth showing.
      console.warn(`[scrape] topic ${topicId}: page at ${at} failed (${res.status}); stopping`)
      break
    }
    let page_json: TopicJson
    try {
      page_json = (await res.json()) as TopicJson
    } catch {
      break
    }
    const more = page_json.post_stream?.posts ?? []
    if (more.length === 0) break
    posts.push(...more)
    onProgress?.(posts.length, total)
  }
}

let loginWindow: BrowserWindow | null = null

/**
 * Open the forum's own login page in a window and wait for its session cookie.
 * The app never sees the password — it only notices that
 * a session now exists on the shared Electron session.
 */
export async function openLogin(): Promise<{ loggedIn: boolean }> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus()
    forgetSessionCheck()
    return { loggedIn: await isLoggedIn() }
  }

  const win = new BrowserWindow({
    width: 980,
    height: 820,
    autoHideMenuBar: true,
    title: 'EroScripts',
    webPreferences: { partition: undefined, nodeIntegration: false, contextIsolation: true }
  })
  loginWindow = win
  void win.loadURL(`${BASE}/login`)

  return new Promise((resolve) => {
    let settled = false
    const finish = (loggedIn: boolean): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      win.removeListener('closed', onClosed)
      if (!win.isDestroyed()) win.close()
      loginWindow = null
      resolve({ loggedIn })
    }
    const onClosed = (): void => {
      // Closing the window by hand still counts if the cookie made it.
      forgetSessionCheck()
      void isLoggedIn().then((ok) => {
        settled = true
        clearInterval(poll)
        loginWindow = null
        resolve({ loggedIn: ok })
      })
    }
    // Poll on the cookie alone: it costs nothing, and the verified check is
    // cached for a minute, so polling that would keep answering "no" with the
    // stale result from before the user logged in.
    const poll = setInterval(() => {
      void hasSessionCookie().then((ok) => {
        if (!ok) return
        forgetSessionCheck()
        void isLoggedIn().then((valid) => valid && finish(true))
      })
    }, 1000)
    win.on('closed', onClosed)
  })
}

export async function logout(): Promise<void> {
  forgetSessionCheck()
  const cookies = await session.defaultSession.cookies.get({ url: BASE })
  await Promise.all(
    cookies.map((c) =>
      session.defaultSession.cookies.remove(BASE, c.name).catch(() => undefined)
    )
  )
}

/**
 * A post's preview image, inlined for the renderer.
 *
 * The renderer's CSP allows `self`, `data:` and the media scheme only, so it
 * cannot load a forum URL directly — and that restriction is worth keeping: it
 * means a parsed post can never make the app fetch a host of its choosing.
 * Fetching here also gets Chromium's TLS stack, which is what the forum's bot
 * management accepts.
 */

/** Enough for a few hundred cards; images are ~100 KB each. */
const IMAGE_CACHE_LIMIT = 200
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

const imageCache = new Map<string, string>()
/**
 * In-flight fetches, so the dozen cards showing one post's poster make one
 * request between them rather than a dozen queued behind each other.
 */
const imageInFlight = new Map<string, Promise<string>>()

export function fetchRemoteImage(url: string): Promise<string> {
  const cached = imageCache.get(url)
  if (cached !== undefined) return Promise.resolve(cached)
  const running = imageInFlight.get(url)
  if (running) return running

  const task = loadImage(url).finally(() => imageInFlight.delete(url))
  imageInFlight.set(url, task)
  return task
}

async function loadImage(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''

  let dataUrl = ''
  try {
    // Not behind the 1 req/s gate: that exists to be polite to the forum's
    // API, and these are static assets on its CDN. Putting pictures in the
    // same queue would make a card wait seconds for its own thumbnail.
    const res = await net.fetch(url, { headers: { 'User-Agent': userAgent(), Referer: BASE } })
    if (res.ok) {
      const type = res.headers.get('content-type') ?? ''
      if (type.startsWith('image/')) {
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength <= MAX_IMAGE_BYTES) {
          dataUrl = `data:${type};base64,${buf.toString('base64')}`
        }
      }
    }
  } catch {
    // A missing picture is not worth an error on screen.
  }

  // Negative results are cached too: a broken image should not be re-fetched
  // once per render behind the 1 req/s gate.
  if (imageCache.size >= IMAGE_CACHE_LIMIT) {
    const oldest = imageCache.keys().next().value
    if (oldest !== undefined) imageCache.delete(oldest)
  }
  imageCache.set(url, dataUrl)
  return dataUrl
}
