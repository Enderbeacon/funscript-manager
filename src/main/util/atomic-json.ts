import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Rename with a short retry on transient Windows errors. A virus scanner (or
 * the library's own watcher) can hold a just-written file open for a moment,
 * and an atomic rename over the destination then throws EPERM/EBUSY/EACCES.
 * Every one of these writes is the only copy of something the user decided,
 * so a one-off lock must not lose it.
 */
async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!transient || i >= attempts - 1) throw e
      await new Promise((r) => setTimeout(r, 20 * (i + 1)))
    }
  }
}

/**
 * Write text via `.tmp` + atomic rename, so a crash mid-write never leaves a
 * truncated file.
 *
 * The temp name carries a random suffix rather than being `<file>.tmp`: two
 * writes to the same file otherwise share one temp path, and each would rename
 * the other's half-written bytes into place — or fail trying, which is what
 * removing a folder full of entries did.
 */
export async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, 'utf-8')
  try {
    await renameWithRetry(tmp, filePath)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}

/** Write JSON via `.tmp` + atomic rename. */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2))
}

/** Read + parse JSON, falling back on any error (missing file, bad JSON). */
export async function readJsonOr<T>(filePath: string, fallback: T): Promise<unknown | T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'))
  } catch {
    return fallback
  }
}
