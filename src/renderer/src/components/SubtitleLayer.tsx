import { useEffect, useRef, useState } from 'react'
import type { SubtitleCue, SubtitleTrack } from '@shared/schemas/playback'
import type { Settings } from '@shared/schemas/app-config'
import { ipcInvoke } from '../ipc'

/**
 * The subtitle over the picture.
 *
 * Drawn by us rather than handed to the `<video>` element. Two reasons, and
 * both are the same reason: a `<video>` takes WebVTT and nothing else, so
 * every other format would have to be converted anyway, and it then styles the
 * result its own way — the size, colour and box the settings panel offers are
 * not things it lets anyone set.
 *
 * The time comes off the element directly, not from the player's position
 * reports. Reports arrive four times a second and are extrapolated between,
 * which is close enough for a scrubber and visibly late for a line of speech.
 */

export type SubtitleLook = Settings['playback']['subtitles']

export default function SubtitleLayer({
  video,
  track,
  offsetMs,
  look
}: {
  video: React.RefObject<HTMLVideoElement | null>
  track: SubtitleTrack | null
  /** Positive shows the line later than the file says. */
  offsetMs: number
  look: SubtitleLook
}): React.JSX.Element | null {
  const [cues, setCues] = useState<SubtitleCue[]>([])
  const [lines, setLines] = useState<string[]>([])
  /** Where the last look landed, so the usual frame does no work at all. */
  const shown = useRef('')

  useEffect(() => {
    if (!track) {
      setCues([])
      return
    }
    let live = true
    // A file too broken to parse comes back with no lines rather than an
    // error: there is nothing for the user to do about it, and the menu has
    // just told them which subtitle they picked.
    ipcInvoke('video:subtitleCues', { track })
      .then((result) => {
        if (live) setCues(result.cues)
      })
      .catch(() => {
        if (live) setCues([])
      })
    return () => {
      live = false
    }
  }, [track])

  useEffect(() => {
    if (cues.length === 0) {
      shown.current = ''
      setLines([])
      return
    }
    let frame = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const el = video.current
      if (!el) return
      const at = el.currentTime * 1000 - offsetMs
      // Overlapping lines are how a sign and a line of speech share a moment;
      // they stack rather than one hiding the other.
      const active = cues
        .filter((cue) => at >= cue.startMs && at < cue.endMs)
        .map((cue) => cue.text)
        .join('\n')
      if (active === shown.current) return
      shown.current = active
      setLines(active === '' ? [] : active.split('\n'))
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [cues, offsetMs, video])

  if (lines.length === 0) return null

  return (
    <div
      className={`subtitle-layer${look.background ? ' boxed' : ''}`}
      style={
        {
          '--sub-scale': look.fontScale,
          '--sub-color': look.color,
          '--sub-opacity': look.opacity / 100,
          '--sub-bg': look.backgroundOpacity / 100,
          '--sub-bottom': `${look.bottomOffset}%`
        } as React.CSSProperties
      }
    >
      {lines.map((line, i) => (
        // Lines have no identity of their own — the same words come round
        // again — so their place in the cue is the only stable key.
        <span key={i} className="subtitle-line">
          {line}
        </span>
      ))}
    </div>
  )
}
