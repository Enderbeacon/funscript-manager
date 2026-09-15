import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { useErrorMessage } from '../useErrorMessage'
import { useDialogEscape } from './ConfirmDialog'

/**
 * Asking for one name. Opened through `askName` in dialogs.tsx, never directly.
 *
 * Drawn on the body: the drawer and the floating panels it is opened from have
 * a `backdrop-filter`, which turns `position: fixed` inside them into "fixed to
 * the panel", and the scrim would cover the panel instead of the window.
 */
export default function NamePromptDialog({
  title,
  initial = '',
  confirmLabel,
  onSubmit,
  onClose
}: {
  title: string
  initial?: string
  confirmLabel: string
  /** Closes the dialog when it resolves; a throw keeps it open with the error. */
  onSubmit: (name: string) => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useDialogEscape(onClose, !busy)

  const trimmed = name.trim()

  const run = async (): Promise<void> => {
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(trimmed)
    } catch (e) {
      setError(toMessage(e))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-scrim">
      <div className="modal close-modal">
        <div className="modal-head">
          <span className="grow">{title}</span>
          <button className="ghost sm" disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          <input
            className="search"
            value={name}
            autoFocus
            disabled={busy}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void run()}
          />
        </div>

        <div className="modal-foot">
          <div className="grow" />
          <button className="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="primary" disabled={busy || !trimmed} onClick={() => void run()}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
