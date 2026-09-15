import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ipcInvoke } from '../ipc'
import { useEscape } from '../useEscape'

/**
 * Closing the main window with a player in a window of its own.
 *
 * The old behaviour made the decision silently: the picture was destroyed and
 * the script player was left running with no window to reach it from. Neither
 * is obvious enough to do without asking — someone watching the popped-out
 * video did not ask for it to end because they put the library away.
 *
 * Escape cancels, which is the same as dismissing it: the window was told to
 * stay the moment this appeared, so doing nothing leaves everything as it is.
 */
export default function CloseConfirmDialog({
  video,
  script,
  onCancel
}: {
  /** The picture has a window of its own. */
  video: boolean
  /** The script player has a window of its own. */
  script: boolean
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [remember, setRemember] = useState(false)
  useEscape(onCancel)

  const decide = (closePlayers: boolean): void => {
    void ipcInvoke('app:closeMainWindow', { closePlayers, remember }).catch(() => {})
  }

  const which = video && script ? 'both' : video ? 'video' : 'script'

  return (
    <div className="modal-scrim">
      <div className="modal close-modal">
        <div className="modal-head">
          <span className="grow">{t('closeConfirm.title')}</span>
        </div>
        <div className="modal-body">
          <p className="close-what">{t(`closeConfirm.open.${which}`)}</p>
          <label className="close-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            {t('closeConfirm.remember')}
          </label>
        </div>
        <div className="modal-foot">
          <button className="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <div className="grow" />
          <button className="ghost" onClick={() => decide(false)}>
            {t('closeConfirm.keep')}
          </button>
          <button className="primary" autoFocus onClick={() => decide(true)}>
            {t('closeConfirm.closeAll')}
          </button>
        </div>
      </div>
    </div>
  )
}
