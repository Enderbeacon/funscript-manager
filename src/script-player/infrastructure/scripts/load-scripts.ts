import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { parseFunscript, parseFunscriptAxes, type ParsedFunscript, type ParsedFunscriptAxes } from '@shared/funscript'
import type { ScriptFile, ScriptFilesPort } from '../../application/ports/script-files'
import type { ScriptPlayerAxis } from '../../shared/config'

export async function loadScriptFile(path: string, axis?: ScriptPlayerAxis, fallbackToPrimary = false): Promise<ScriptFile | null> {
  try {
    const text = await readFile(path, 'utf8')
    const script = axis
      ? parseFunscriptAxes(text)[axis] ?? (fallbackToPrimary ? parseFunscript(text) : null)
      : parseFunscript(text)
    return script ? { path, name: basename(path), script } : null
  } catch (error) {
    console.error(`[script-player] could not load script ${path}:`, error)
    return null
  }
}

export const scriptFiles: ScriptFilesPort = { read: (path, axis) => loadScriptFile(path, axis, true) }

export async function loadScriptFiles(
  files: Partial<Record<ScriptPlayerAxis, string>>,
  fileAxes: Partial<Record<ScriptPlayerAxis, ScriptPlayerAxis>> = {}
): Promise<Partial<Record<ScriptPlayerAxis, ScriptFile>>> {
  const loaded: Partial<Record<ScriptPlayerAxis, ScriptFile>> = {}
  const entries = Object.entries(files) as [ScriptPlayerAxis, string][]
  const documents = new Map<string, Promise<{ primary: ParsedFunscript | null; axes: ParsedFunscriptAxes } | null>>()
  await Promise.all(
    entries.map(async ([axis, path]) => {
      let document = documents.get(path)
      if (!document) {
        const needsAxes = entries.some(([dest, source]) => source === path && fileAxes[dest])
        const needsPrimary = entries.some(([dest, source]) => source === path && !fileAxes[dest])
        document = readFile(path, 'utf8').then((text) => ({
          primary: needsPrimary ? parseFunscript(text) : null,
          axes: needsAxes ? parseFunscriptAxes(text) : {}
        }))
          .catch((error) => {
            console.error(`[script-player] could not load script ${path}:`, error)
            return null
          })
        documents.set(path, document)
      }
      const parsed = await document
      if (!parsed) return
      const source = fileAxes[axis]
      const script = source ? parsed.axes[source] : parsed.primary
      if (script) loaded[axis] = { path, name: basename(path), script }
    })
  )
  return loaded
}
