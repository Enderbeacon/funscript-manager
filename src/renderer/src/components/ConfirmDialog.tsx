import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/**
 * A yes-or-no question before something is removed or changed for good.
 * Opened through `askConfirm` in dialogs.tsx, never directly.
 *
 * The confirming button takes focus, so Enter answers it the way it did the
 * system box this replaces, and Escape cancels.
 */
export default function ConfirmDialog({
  message,
  confirmLabel,
  danger,
  onAnswer
}: {
  message: string
  confirmLabel: string
  danger: boolean
  onAnswer: (ok: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  useDialogEscape(() => onAnswer(false))

  return createPortal(
    <div className="modal-scrim">
      <div className="modal close-modal">
        <div className="modal-body">
          <p className="close-what">{message}</p>
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button className="ghost" onClick={() => onAnswer(false)}>
            {t('common.cancel')}
          </button>
          <button className={danger ? 'danger' : 'primary'} autoFocus onClick={() => onAnswer(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * Escape closes the dialog and nothing else. Caught on the way down and
 * stopped there, because the app's own Escape would otherwise close the panel
 * the dialog was opened from in the same keystroke.
 */
export function useDialogEscape(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onEscape()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onEscape, enabled])
}
