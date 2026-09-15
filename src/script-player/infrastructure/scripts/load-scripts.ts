import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseFunscript } from '@shared/funscript'
import type { ScriptFile, ScriptFilesPort } from '../../application/ports/script-files'
import type { ScriptPlayerAxis } from '../../shared/config'

export async function loadScriptFile(path: string): Promise<ScriptFile | null> {
  try {
    const script = parseFunscript(await readFile(path, 'utf8'))
    return script ? { path, name: basename(path), script } : null
  } catch (error) {
    console.error(`[script-player] could not load script ${path}:`, error)
    return null
  }
}

export const scriptFiles: ScriptFilesPort = { read: loadScriptFile }

export async function loadScriptFiles(
  files: Partial<Record<ScriptPlayerAxis, string>>
): Promise<Partial<Record<ScriptPlayerAxis, ScriptFile>>> {
  const loaded: Partial<Record<ScriptPlayerAxis, ScriptFile>> = {}
  await Promise.all(
    (Object.entries(files) as [ScriptPlayerAxis, string][]).map(async ([axis, path]) => {
      const file = await loadScriptFile(path)
      if (file) loaded[axis] = file
    })
  )
  return loaded
}
