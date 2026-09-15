import { useEffect } from 'react'
import { applyLanguageSetting } from '../i18n'
import { ipcInvoke } from '../ipc'
import { applyPaletteSetting, applyThemeSetting } from '../theme'
import NowPlayingBar from './NowPlayingBar'
import VideoPlayerStage, { useVideoIntent } from './VideoPlayerStage'

/**
 * The picture in a window of its own.
 *
 * The picture is the same component the main window uses; what this adds is
 * the control bar, because the strip along the foot of the main window is not
 * here. It is the same component too — one set of transport controls, wearing
 * a different variant.
 */
export default function VideoPlayerWindow(): React.JSX.Element {
  const intent = useVideoIntent()

  useEffect(() => {
    ipcInvoke('settings:get')
      .then((settings) => {
        applyLanguageSetting(settings.ui.language)
        applyPaletteSetting(settings.ui.palette)
        applyThemeSetting(settings.ui.theme)
      })
      .catch(() => {})
  }, [])

  return (
    <div className="video-window">
      {intent && (
        <VideoPlayerStage intent={intent} form="fill" onForm={() => {}} detached />
      )}
      <NowPlayingBar variant="detached" />
    </div>
  )
}
