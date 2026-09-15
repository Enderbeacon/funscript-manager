import type { TFunction } from 'i18next'
import type { MediaSourceKind } from '@shared/schemas/app-config'

/**
 * What to call a video player on screen.
 *
 * The players the user added carry the name they gave them, and mpv / MPC-HC /
 * HereSphere are what those programs are called in any language. The built-in
 * one is different: it is not a program with a name, it is a description of
 * where the video is playing, so it is translated like any other piece of copy
 * rather than left as the English string the settings file happens to hold.
 */
export function playerLabel(
  source: { kind: MediaSourceKind; name: string } | null | undefined,
  t: TFunction
): string {
  if (!source) return t('conn.noPlayer')
  return source.kind === 'internal' ? t('players.builtInName') : source.name
}
