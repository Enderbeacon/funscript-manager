import { useCallback, useRef, useState } from 'react'
import type { VrFormat } from '@shared/schemas/vr-video'
import { isVrFormat } from '@shared/vr-video'
import { DEFAULT_VR_LOOK } from '../vrView'
import VrSurface from './VrSurface'

/**
 * The silent inline preview, shown where a still would otherwise be.
 *
 * Seeks a little past the start, loops, and stays silent. A VR file is shown
 * flattened, facing straight ahead; the view does not follow the mouse.
 */
export default function PreviewVideo({
  src,
  className,
  vr,
  onError
}: {
  src: string
  className: string
  vr: VrFormat
  onError: () => void
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement | null>(null)
  const [vrBroken, setVrBroken] = useState(false)
  const onUnavailable = useCallback((): void => setVrBroken(true), [])
  const vrOn = isVrFormat(vr) && !vrBroken

  return (
    <>
      <video
        ref={video}
        className={className}
        src={src}
        // Lets WebGL read the frames of a VR file; see the player's element.
        crossOrigin="anonymous"
        muted
        autoPlay
        loop
        playsInline
        preload="metadata"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget
          if (Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration * 0.1, 20)
        }}
        onError={onError}
      />
      {vrOn && (
        <VrSurface
          video={video}
          format={vr}
          look={DEFAULT_VR_LOOK}
          onUnavailable={onUnavailable}
        />
      )}
    </>
  )
}
