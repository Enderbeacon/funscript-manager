import { useAppearance } from '@/useAppearance'
import ScriptPlayerPanel from './ScriptPlayerPanel'

export default function ScriptPlayerStandalone(): React.JSX.Element {
  useAppearance()
  return <ScriptPlayerPanel standalone />
}
