import { open, readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { LIBRARY_CACHE_DIR } from '@shared/constants'
import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import { artworkCandidates } from './artwork-candidates'

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml'
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
  libraries: RegisteredLibrary[]
): Promise<{ images: string[]; rotate: boolean; intervalSeconds: number }> {
  const { mode, customPath, intervalSeconds } = ui.startupArtwork
  if (mode === 'default') return { images: [], rotate: false, intervalSeconds }
  if (mode === 'custom') {
    const image = await imageData(customPath, 16 * 1024 * 1024)
    return { images: image ? [image] : [], rotate: false, intervalSeconds }
  }

  const selected = libraries.filter((library) => !ui.mediaLibraryId || library.id === ui.mediaLibraryId)
  const groups = await Promise.all(selected.map(async (library) => {
    const folder = join(library.rootPath, LIBRARY_CACHE_DIR, 'cache', 'thumbs')
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    const cachedNames = new Set(entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jpg'))
      .map((entry) => entry.name))
    return artworkCandidates(library, ui.startupArtwork, cachedNames)
  }))
  const candidates = groups.flat()
  const images: string[] = []
  // Partial Fisher-Yates: no duplicate candidates, even when there is one file.
  for (let end = candidates.length; end > 0 && images.length < 8 && candidates.length - end < 32; end--) {
    const index = Math.floor(Math.random() * end)
    const path = candidates[index]!
    candidates[index] = candidates[end - 1]!
    const image = await imageData(path, 2 * 1024 * 1024)
    if (image) images.push(image)
  }
  return { images, rotate: images.length > 1, intervalSeconds }
}
