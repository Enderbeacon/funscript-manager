import { open, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { LIBRARY_CACHE_DIR } from '@shared/constants'
import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import { artworkCandidates, artworkNames } from './artwork-candidates'
import {
  activeStartupArtwork,
  scheduleStartupArtworkPreparation
} from './artwork-pool'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml'
}

/**
 * One picture for the startup card. `caption` names the video a library frame
 * was taken from; a chosen image or the built-in art has none.
 */
export interface StartupImage {
  src: string
  caption: string | null
}

/** Read a bounded image without exposing local paths to the splash document. */
async function imageData(path: string, limit: number): Promise<string | null> {
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) return null
  try {
    const file = await open(path, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size === 0 || info.size > limit) return null
      const bytes = Buffer.alloc(info.size)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== bytes.length) return null
      return `data:${mime};base64,${bytes.toString('base64')}`
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/**
 * Read the thumbnail cache and the persisted index before library startup:
 * asking the thumbnail service would launch ffmpeg on cache misses.
 * Only a small shuffled batch is sent to the short-lived startup window.
 */
export async function loadStartupArtwork(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[],
  purpose: 'startup' | 'settings'
): Promise<{
  images: StartupImage[]
  rotate: boolean
  intervalSeconds: number
  presentation: 'cover' | 'framed'
}> {
  const { mode, customPath, intervalSeconds } = ui.startupArtwork
  if (mode === 'default') {
    return { images: [], rotate: false, intervalSeconds, presentation: 'cover' }
  }
  if (mode === 'custom') {
    const image = await imageData(customPath, 16 * 1024 * 1024)
    return {
      images: image ? [{ src: image, caption: null }] : [],
      rotate: false,
      intervalSeconds,
      presentation: ui.startupArtwork.customPresentation
    }
  }

  const selected = libraries.filter((library) => !ui.mediaLibraryId || library.id === ui.mediaLibraryId)
  const active = await activeStartupArtwork(ui, libraries)
  const highRes = await shuffledImages(active, (candidate) => candidate.path, 4 * 1024 * 1024)
  if (highRes.length > 0) {
    if (purpose === 'settings') {
      scheduleStartupArtworkPreparation(ui, libraries, highRes[0]!.item.ref)
    }
    const names = new Map<string, string>()
    for (const library of libraries) {
      const ids = highRes.filter(({ item }) => item.ref.libraryId === library.id).map(({ item }) => item.ref.mediaId)
      for (const [id, name] of artworkNames(library, ids)) names.set(`${library.id}:${id}`, name)
    }
    return {
      images: highRes.map(({ image, item }) => ({
        src: image,
        caption: names.get(`${item.ref.libraryId}:${item.ref.mediaId}`) ?? null
      })),
      rotate: highRes.length > 1,
      intervalSeconds,
      presentation: ui.startupArtwork.libraryPresentation
    }
  }

  const groups = await Promise.all(selected.map(async (library) => {
    const folder = join(library.rootPath, LIBRARY_CACHE_DIR, 'cache', 'thumbs')
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const cachedNames = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jpg'))
      .map((entry) => entry.name))
    return artworkCandidates(library, ui.startupArtwork, cachedNames)
  }))
  const candidates = groups.flat()
  const regular = await shuffledImages(candidates, (candidate) => candidate.thumbnailPath, 2 * 1024 * 1024)
  if (purpose === 'settings') {
    scheduleStartupArtworkPreparation(ui, libraries, regular[0]?.item)
  }
  const images = regular.map(({ image, item }) => ({ src: image, caption: item.name }))
  return {
    images,
    rotate: images.length > 1,
    intervalSeconds,
    presentation: ui.startupArtwork.libraryPresentation
  }
}

/** Partial Fisher-Yates with a bounded number of failed file reads. */
async function shuffledImages<T>(
  input: T[],
  pathOf: (item: T) => string,
  sizeLimit: number
): Promise<{ image: string; item: T }[]> {
  const candidates = [...input]
  const images: { image: string; item: T }[] = []
  for (let end = candidates.length; end > 0 && images.length < 8 && candidates.length - end < 32; end--) {
    const index = Math.floor(Math.random() * end)
    const item = candidates[index]!
    candidates[index] = candidates[end - 1]!
    const image = await imageData(pathOf(item), sizeLimit)
    if (image) images.push({ image, item })
  }
  return images
}
