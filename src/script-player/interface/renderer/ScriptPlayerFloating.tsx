import ScriptPlayerPanel from './ScriptPlayerPanel'
import { useSurface } from '@/surfaces'

export default function ScriptPlayerFloating({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { z, front, raise } = useSurface('script-player', onClose)
  return (
    <aside
      className={`script-player-float${front ? '' : ' behind'}`}
      style={{ zIndex: z }}
      onPointerDown={raise}
    >
      <ScriptPlayerPanel onClose={onClose} />
    </aside>
  )
}
