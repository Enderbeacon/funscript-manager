import { useEffect, useRef } from 'react'
import type { VrFormat } from '@shared/schemas/vr-video'
import { VrView, type VrLook } from '../vrView'

/**
 * The canvas a VR video is drawn on, over the element playing it.
 *
 * The video element underneath keeps playing, keeps the sound and stays the
 * one thing the rest of the picture reads the time from; all that happens
 * here is that each of its frames is unwrapped onto the screen.
 *
 * Nothing is caught here either — the canvas is not a target, so clicks,
 * drags and the wheel go to the gesture layer over it exactly as they do for
 * an ordinary video. Where the viewer is facing comes down as `look`.
 */
export default function VrSurface({
  video,
  format,
  look,
  onUnavailable
}: {
  /** The element playing the file. Already mounted when this one mounts. */
  video: React.RefObject<HTMLVideoElement | null>
  format: VrFormat
  look: VrLook
  /** No WebGL, or it went away: show the video itself instead. */
  onUnavailable: () => void
}): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const view = useRef<VrView | null>(null)
  /** Read inside the one-off effect below, which must not be re-run for it. */
  const latest = useRef({ format, look })
  latest.current = { format, look }

  useEffect(() => {
    const el = canvas.current
    const el2 = video.current
    if (!el || !el2) return
    let made: VrView
    try {
      made = new VrView(el, el2, latest.current.format, onUnavailable)
    } catch {
      onUnavailable()
      return
    }
    made.setLook(latest.current.look)
    view.current = made
    made.resize(el.clientWidth, el.clientHeight)
    made.follow()
    made.draw()

    const sized = new ResizeObserver(() => {
      made.resize(el.clientWidth, el.clientHeight)
      made.draw()
    })
    sized.observe(el)
    // A lost context is not recoverable here: the texture and the program
    // went with it, so the picture goes back to the plain element.
    const onLost = (): void => onUnavailable()
    el.addEventListener('webglcontextlost', onLost)

    return () => {
      el.removeEventListener('webglcontextlost', onLost)
      sized.disconnect()
      made.dispose()
      view.current = null
    }
    // Built once for this element. Everything that changes afterwards is
    // handed over below; rebuilding would drop the texture on every turn of
    // the head.
  }, [video, onUnavailable])

  useEffect(() => {
    view.current?.setFormat(format)
    view.current?.draw()
  }, [format.projection, format.layout])

  // Redrawn here rather than waiting for the next frame: turning the view
  // while the video is paused has no next frame to wait for.
  useEffect(() => {
    view.current?.setLook(look)
    view.current?.draw()
  }, [look.yaw, look.pitch, look.fov])

  return <canvas ref={canvas} className="vr-canvas" />
}
