import { createContext, useContext } from 'react'
import { Minus, Plus } from 'lucide-react'

/**
 * Set while the player is shown on a panel inside the headset.
 *
 * The panel is the same player as on the desktop. What changes is what a
 * laser can do: there is no typing without the headset keyboard, no file
 * dialog to see, and no hovering precise enough to nudge a small number field.
 */
export const VrModeContext = createContext(false)

export function useVrMode(): boolean {
  return useContext(VrModeContext)
}

/**
 * Minus and plus beside a number field, in VR only: a press is easier to aim
 * than a caret, and the value stays in reach without the keyboard.
 */
export function NumberSteps({
  value,
  step,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  disabled = false,
  onChange
}: {
  value: number
  step: number
  min?: number
  max?: number
  disabled?: boolean
  onChange: (value: number) => void
}): React.JSX.Element | null {
  const vr = useVrMode()
  if (!vr) return null
  // Float steps (0.1, 0.01) must not drift into 0.30000000000000004.
  const to = (next: number): number => Number(Math.min(max, Math.max(min, next)).toFixed(6))
  return (
    <span className="sp-steps">
      <button type="button" disabled={disabled || value <= min} onClick={() => onChange(to(value - step))}>
        <Minus size={16} />
      </button>
      <button type="button" disabled={disabled || value >= max} onClick={() => onChange(to(value + step))}>
        <Plus size={16} />
      </button>
    </span>
  )
}
