import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { usePopover } from '../usePopover'

/**
 * A dropdown that looks like the rest of the app.
 *
 * A native `<select>` cannot: its open list is drawn by the operating system,
 * so it stays grey and square whatever the page does. This is the same control
 * built from a button and a panel, styled like the top bar's menu.
 *
 * The panel goes into `document.body` rather than beside the button — see
 * `usePopover` for why a card's own stacking context makes that necessary.
 */

export interface SelectOption<T extends string> {
  value: T
  label: string
}

export default function Select<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  ariaLabel
}: {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
  ariaLabel?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const placement = usePopover(buttonRef, open, close, { matchWidth: true })

  const current = options.find((o) => o.value === value)

  return (
    <div className={`select-root ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        className="select-button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-value">{current?.label ?? ''}</span>
        <ChevronDown size={14} className="select-caret" />
      </button>

      {open &&
        placement &&
        createPortal(
          <>
            <div className="select-scrim" onClick={close} />
            <div className="select-menu" role="listbox" style={placement}>
              {options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={option.value === value ? 'on' : ''}
                  onClick={() => {
                    onChange(option.value)
                    close()
                  }}
                >
                  <span className="select-option-label">{option.label}</span>
                  {option.value === value && <Check size={13} />}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  )
}
