import { app, net } from 'electron'
import { AppError } from '@shared/errors'
import { compareVersions, isValidVersion } from '@shared/semver'
import type { ReleaseSummary, UpdateChannel } from '@shared/schemas/updates'

/**
 * The project's published releases, read from GitHub.
 *
 * A release belongs to the channel whose Velopack feed it carries
 * (`releases.win.json` is stable, `releases.beta.json` is beta). Releases with
 * neither — drafts, a tag pushed by hand, a failed publish — are not offered.
 *
 * Every release is also its own download location: the updater is pointed at
 * that one release's files, so its feed lists nothing newer than itself. That
 * is what makes "install this version" possible at all, and it means the
 * newest release on a channel is always chosen here, never by the updater.
 */

export const REPOSITORY = 'Enderbeacon/funscript-manager'

// Test hooks: point both at a local server that mimics GitHub.
const RELEASES_API =
  process.env['FSMGR_UPDATE_RELEASES_API'] ||
  `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`
const DOWNLOAD_BASE =
  process.env['FSMGR_UPDATE_DOWNLOAD_BASE'] || `https://github.com/${REPOSITORY}/releases/download/`

/** Unauthenticated GitHub allows 60 requests an hour per address. */
const CACHE_TTL_MS = 10 * 60 * 1000

const FEED_FILE: Record<UpdateChannel, string> = {
  stable: 'releases.win.json',
  beta: 'releases.beta.json'
}

/** The Velopack channel name each of ours was packed with. */
export const VELOPACK_CHANNEL: Record<UpdateChannel, string> = {
  stable: 'win',
  beta: 'beta'
}

interface GithubRelease {
  tag_name: string
  html_url: string
  draft: boolean
  published_at: string | null
  body: string | null
  assets: { name: string }[]
}

let cache: { at: number; releases: ReleaseSummary[] } | null = null

export function releasePageUrl(tag: string): string {
  return `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`
}

/** Where the updater finds one release's files. */
export function releaseBaseUrl(release: ReleaseSummary): string {
  return `${DOWNLOAD_BASE}${encodeURIComponent(release.tag)}/`
}

/** Every installable release, newest first. */
export async function listReleases(force = false): Promise<ReleaseSummary[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.releases

  let res: Response
  try {
    // Chromium's stack, so the app's proxy (or the system's) applies.
    res = await net.fetch(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `FunscriptManager/${app.getVersion()}`
      },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (e) {
    console.warn('[updates] release list unreachable:', e)
    throw new AppError('update_check_failed')
  }
  if (res.status === 403 || res.status === 429) {
    console.warn(`[updates] release list refused: HTTP ${res.status}`)
    throw new AppError('update_rate_limited')
  }
  if (!res.ok) {
    console.warn(`[updates] release list failed: HTTP ${res.status}`)
    throw new AppError('update_check_failed')
  }

  let raw: unknown
  try {
    raw = await res.json()
  } catch (e) {
    console.warn('[updates] release list is not JSON:', e)
    throw new AppError('update_check_failed')
  }
  if (!Array.isArray(raw)) throw new AppError('update_check_failed')

  const releases = (raw as GithubRelease[])
    .map(toSummary)
    .filter((r): r is ReleaseSummary => r !== null)
    .sort((a, b) => compareVersions(b.version, a.version))
  cache = { at: Date.now(), releases }
  return releases
}

function toSummary(release: GithubRelease): ReleaseSummary | null {
  if (!release || release.draft || typeof release.tag_name !== 'string') return null
  const version = release.tag_name.replace(/^v/, '')
  if (!isValidVersion(version)) return null
  const names = new Set((release.assets ?? []).map((a) => a.name))
  const channel: UpdateChannel | null = names.has(FEED_FILE.stable)
    ? 'stable'
    : names.has(FEED_FILE.beta)
      ? 'beta'
      : null
  if (!channel) return null
  return {
    version,
    tag: release.tag_name,
    channel,
    publishedAt: release.published_at ?? null,
    url: release.html_url || releasePageUrl(release.tag_name),
    notes: release.body ?? ''
  }
}

/**
 * The newest release someone following `channel` should be on. Beta follows
 * stable too, so a stable release newer than every beta is offered to beta
 * users rather than leaving them behind.
 */
export function newestFor(releases: ReleaseSummary[], channel: UpdateChannel): ReleaseSummary | null {
  return releases.find((r) => channel === 'beta' || r.channel === 'stable') ?? null
}
