import type { ScriptPlayerAxis, ScriptPlayerSettings } from '../shared/config'
import { ScriptPlayerSession } from '../application/services/script-player-session'
import { createOutputTransport } from '../infrastructure/outputs/factory'
import { loadScriptFiles, scriptFiles } from '../infrastructure/scripts/load-scripts'

export const scriptPlayerSession = new ScriptPlayerSession(createOutputTransport, scriptFiles)

/**
 * `enabled` is false when the app's script route points at MultiFunPlayer
 * instead; this player then lets go of every device rather than competing for
 * ports MFP is about to open. Deliberately a plain flag: which other program
 * is in charge is the caller's business, not this module's.
 */
export function configureScriptPlayer(
  settings: ScriptPlayerSettings,
  enabled: boolean
): void {
  scriptPlayerSession.setEnabled(enabled)
  scriptPlayerSession.configure(settings)
}

export async function loadScriptPlayer(
  mediaId: string,
  scriptVersionId: string,
  files: Partial<Record<ScriptPlayerAxis, string>>
): Promise<void> {
  const scripts = await loadScriptFiles(files)
  scriptPlayerSession.load(mediaId, scriptVersionId, scripts)
}

export function clearScriptPlayer(): void {
  scriptPlayerSession.clear()
}

export async function disposeScriptPlayer(): Promise<void> {
  await scriptPlayerSession.dispose()
}
