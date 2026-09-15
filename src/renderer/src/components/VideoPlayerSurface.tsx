import { useCallback } from 'react'
import type { InternalPlayerIntent } from '@shared/schemas/playback'
import { useSurface } from '../surfaces'
import VideoPlayerStage, { type StageForm } from './VideoPlayerStage'

/**
 * The picture as one of the app's panels.
 *
 * Stacking is a record of what the user touched last, not a fixed order, and
 * the picture joins it for one reason: pressing play from a video's details
 * has to put the picture in front of the panel it was pressed from. Opening
 * the script player afterwards puts that in front of the picture, which is the
 * same rule and the behaviour we want there too.
 */
export default function VideoPlayerSurface({
  intent,
  form,
  onForm,
  onClose,
  tucked,
  onFullscreenChange
}: {
  intent: InternalPlayerIntent
  form: StageForm
  onForm: (form: StageForm) => void
  onClose: () => void
  tucked: boolean
  onFullscreenChange: (fullscreen: boolean) => void
}): React.JSX.Element {
  /**
   * Escape closes the front-most panel, and here that would be the picture —
   * except in full screen, where the same key is already leaving full screen.
   * Doing both would take the video away as well as the full screen.
   */
  const close = useCallback((): void => {
    if (document.fullscreenElement) return
    onClose()
  }, [onClose])

  const { z, raise } = useSurface('video', close)

  return (
    <VideoPlayerStage
      intent={intent}
      form={form}
      onForm={onForm}
      onClose={onClose}
      tucked={tucked}
      z={z}
      onRaise={raise}
      onFullscreenChange={onFullscreenChange}
    />
  )
}
