import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { app } from 'electron'
import { AppError } from '@shared/errors'
import {
  LibrariesFileSchema,
  SettingsSchema,
  defaultSettings,
  type LibrariesFile,
  type RegisteredLibrary,
  type Settings
} from '@shared/schemas/app-config'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'
import { setAsideUnreadable, withUnknownKeys } from '../../util/persisted'

/**
 * App-level config persistence: settings.json + libraries.json.
 * All writes go through `.tmp` + atomic rename, so a crash mid-write never
 * leaves a truncated file behind.
 * Errors surface as AppError codes; the renderer translates them.
 */

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function librariesPath(): string {
  return join(app.getPath('userData'), 'libraries.json')
}

let settingsCache: Settings | null = null
let librariesCache: LibrariesFile | null = null
/**
 * The settings file as it was read, before validation dropped anything.
 * Settings written by a newer build ride along in it and are put back on
 * every save, so going back a version and changing one setting does not
 * quietly reset what that newer build had stored.
 */
let settingsRaw: unknown = {}

export async function getSettings(): Promise<Settings> {
  if (settingsCache) return settingsCache
  const raw = await readJsonOr(settingsPath(), {})
  const parsed = SettingsSchema.safeParse(raw)
  if (!parsed.success) {
    console.warn('[config] settings.json did not validate:', parsed.error.issues)
    await setAsideUnreadable(settingsPath())
  }
  settingsRaw = parsed.success ? raw : {}
  settingsCache = parsed.success ? parsed.data : defaultSettings()
  settingsCache = carryOverMpvPath(settingsCache, raw)
  return settingsCache
}

/**
 * mpv used to be the only player, configured by a single `playback.mpvExePath`.
 * It is now one entry in the player list, and a settings file written before
 * that has no list — so the seeded mpv entry inherits the path the user set,
 * rather than silently going back to looking for mpv on PATH.
 */
function carryOverMpvPath(settings: Settings, raw: unknown): Settings {
  const legacy = (raw as { playback?: { mpvExePath?: unknown; sources?: unknown } } | null)?.playback
  if (!legacy || Array.isArray(legacy.sources)) return settings
  if (typeof legacy.mpvExePath !== 'string' || !legacy.mpvExePath) return settings
  return {
    ...settings,
    playback: {
      ...settings.playback,
      sources: settings.playback.sources.map((source) =>
        source.kind === 'mpv' && !source.exePath
          ? { ...source, exePath: legacy.mpvExePath as string }
          : source
      )
    }
  }
}

/** Two-level deep-merge partial update; merged result is re-validated before persisting. */
export async function updateSettings(patch: Record<string, unknown>): Promise<Settings> {
  const current = await getSettings()
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    const prev = (current as Record<string, unknown>)[key]
    merged[key] =
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      prev !== null && typeof prev === 'object' && !Array.isArray(prev)
        ? { ...prev, ...value }
        : value
  }
  settingsCache = SettingsSchema.parse(merged)
  settingsRaw = withUnknownKeys(settingsCache, settingsRaw)
  await atomicWriteJson(settingsPath(), settingsRaw)
  return settingsCache
}

export async function listLibraries(): Promise<RegisteredLibrary[]> {
  if (!librariesCache) {
    const raw = await readJsonOr(librariesPath(), { libraries: [] })
    const parsed = LibrariesFileSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn('[config] libraries.json did not validate:', parsed.error.issues)
      await setAsideUnreadable(librariesPath())
    }
    librariesCache = parsed.success ? parsed.data : { libraries: [] }
  }
  return librariesCache.libraries
}

export async function addLibrary(rootPath: string, name?: string): Promise<RegisteredLibrary> {
  const normalized = resolve(rootPath)
  if (!existsSync(normalized) || !statSync(normalized).isDirectory()) {
    throw new AppError('library_path_invalid', { path: normalized })
  }
  const libraries = await listLibraries()
  if (libraries.some((l) => resolve(l.rootPath).toLowerCase() === normalized.toLowerCase())) {
    throw new AppError('library_already_registered')
  }
  // TODO: reject paths nested inside (or containing) an existing library

  const library: RegisteredLibrary = {
    id: randomUUID(),
    name: name ?? basename(normalized),
    rootPath: normalized,
    addedAt: new Date().toISOString()
  }
  librariesCache = { libraries: [...libraries, library] }
  await atomicWriteJson(librariesPath(), librariesCache)
  return library
}

export async function removeLibrary(id: string): Promise<void> {
  const libraries = await listLibraries()
  librariesCache = { libraries: libraries.filter((l) => l.id !== id) }
  await atomicWriteJson(librariesPath(), librariesCache)
}
