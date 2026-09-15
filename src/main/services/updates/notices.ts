import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { app, net } from 'electron'
import { compareVersions } from '@shared/semver'
import {
  AnnouncementSchema,
  type Announcement,
  type StartupNotices,
  type UpdateChannel
} from '@shared/schemas/updates'
import { atomicWriteJson } from '../../util/atomic-json'
import { getSettings } from '../config/config-service'
import { REPOSITORY } from './releases'

/**
 * What the app tells the user once it is open: what changed in the version
 * they were just updated to, and notices published in the repository's
 * `announcements.json` — something worth saying that is not a release.
 *
 * Every notice is shown once per install. The file is fetched from the default
 * branch, so publishing one is a commit, and a mistake is taken back the same way.
 */

const ANNOUNCEMENTS_URL =
  process.env['FSMGR_ANNOUNCEMENTS_URL'] ||
  `https://raw.githubusercontent.com/${REPOSITORY}/main/announcements.json`

/** Enough to remember every notice ever shown, without growing forever. */
const MAX_SEEN = 500

interface NoticeState {
  seenAnnouncements: string[]
  /** Saved just before an update is applied, and shown by the version it installs. */
  whatsNew: { version: string; notes: string } | null
}

function statePath(): string {
  return join(app.getPath('userData'), 'updates.json')
}

// Synchronous, for the same reason as `rememberWhatsNew`.
function readState(): NoticeState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf-8')) as Partial<NoticeState>
    return {
      seenAnnouncements: Array.isArray(raw.seenAnnouncements)
        ? raw.seenAnnouncements.filter((id): id is string => typeof id === 'string')
        : [],
      whatsNew:
        raw.whatsNew && typeof raw.whatsNew.version === 'string' && typeof raw.whatsNew.notes === 'string'
          ? raw.whatsNew
          : null
    }
  } catch {
    return { seenAnnouncements: [], whatsNew: null }
  }
}

function writeState(next: NoticeState): Promise<void> {
  return atomicWriteJson(statePath(), next).catch((e) => console.warn('[updates] notice state not saved:', e))
}

/**
 * Keep the notes of the release about to be installed. A plain synchronous
 * write, because this runs as the app exits.
 */
export function rememberWhatsNew(version: string, notes: string): void {
  const state = readState()
  try {
    writeFileSync(statePath(), JSON.stringify({ ...state, whatsNew: { version, notes } }, null, 2))
  } catch (e) {
    console.warn('[updates] release notes not kept:', e)
  }
}

export async function startupNotices(): Promise<StartupNotices> {
  const state = readState()
  const current = app.getVersion()
  let whatsNew = state.whatsNew
  if (whatsNew && whatsNew.version !== current) {
    // Kept for a version that did not install, or one already left behind.
    whatsNew = null
    await writeState({ ...state, whatsNew: null })
  }

  const settings = await getSettings()
  const announcements = settings.updates.autoCheck
    ? (await fetchAnnouncements()).filter((a) =>
        isFor(a, current, settings.updates.channel, new Set(state.seenAnnouncements))
      )
    : []
  return { whatsNew, announcements }
}

export async function dismissWhatsNew(): Promise<void> {
  const state = readState()
  if (state.whatsNew) await writeState({ ...state, whatsNew: null })
}

export async function dismissAnnouncement(id: string): Promise<void> {
  const state = readState()
  if (state.seenAnnouncements.includes(id)) return
  await writeState({ ...state, seenAnnouncements: [...state.seenAnnouncements, id].slice(-MAX_SEEN) })
}

async function fetchAnnouncements(): Promise<Announcement[]> {
  let raw: unknown
  try {
    const res = await net.fetch(ANNOUNCEMENTS_URL, {
      headers: { 'User-Agent': `FunscriptManager/${app.getVersion()}` },
      signal: AbortSignal.timeout(15_000)
    })
    // No file yet is the normal state of a repository with nothing to say.
    if (!res.ok) return []
    raw = await res.json()
  } catch (e) {
    console.warn('[updates] announcements unavailable:', e)
    return []
  }
  const list = (raw as { announcements?: unknown } | null)?.announcements
  if (!Array.isArray(list)) return []
  // One malformed entry must not silence the others.
  return list.flatMap((entry) => {
    const parsed = AnnouncementSchema.safeParse(entry)
    if (!parsed.success) console.warn('[updates] skipping a malformed announcement:', parsed.error.issues)
    return parsed.success ? [parsed.data] : []
  })
}

function isFor(a: Announcement, version: string, channel: UpdateChannel, seen: Set<string>): boolean {
  if (seen.has(a.id)) return false
  const now = Date.now()
  if (a.expiresAt && Date.parse(a.expiresAt) <= now) return false
  if (a.publishedAt && Date.parse(a.publishedAt) > now) return false
  if (a.minVersion && compareVersions(version, a.minVersion) < 0) return false
  if (a.maxVersion && compareVersions(version, a.maxVersion) > 0) return false
  if (a.channels && !a.channels.includes(channel)) return false
  return true
}
