import MediaSourcePanel from './MediaSourcePanel'
import { useSurface } from '../surfaces'

/** The player list as a floating panel, stacked like every other one. */
export default function MediaSourceFloating({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { z, front, raise } = useSurface('media-source', onClose)
  return (
    <aside
      className={`script-player-float media-source-float${front ? '' : ' behind'}`}
      style={{ zIndex: z }}
      onPointerDown={raise}
    >
      <MediaSourcePanel onClose={onClose} />
    </aside>
  )
}
