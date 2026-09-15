import type { ParsedFunscript } from '@shared/funscript'

/** A script as the player holds it: what it plays, and where it came from. */
export interface ScriptFile {
  /** Absolute path, for showing the file and revealing it. */
  path: string
  /** File name, for showing in the panel. */
  name: string
  script: ParsedFunscript
}

export interface ScriptFilesPort {
  /** Null when the file cannot be read or is not a usable funscript. */
  read(path: string): Promise<ScriptFile | null>
}
