import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, X } from 'lucide-react'
import type { RenamePlan } from '@shared/schemas/media-lifecycle'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useEscape } from '../useEscape'

/**
 * Renaming a media file, with or without its companions.
 *
 * Both answers are safe. Taking the scripts along keeps one name across the
 * set; leaving them keeps whatever the author called them. The library follows
 * either way, because ownership is what the sidecar says, not what the names
 * happen to look like.
 */
export default function RenameMediaDialog({
  libraryId,
  mediaId,
  currentName,
  onClose,
  onDone
}: {
  libraryId: string
  mediaId: string
  currentName: string
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [name, setName] = useState(currentName)
  const [withCompanions, setWithCompanions] = useState(true)
  const [plan, setPlan] = useState<RenamePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscape(onClose, !busy)

  const trimmed = name.trim()
  const changed = trimmed !== '' && trimmed !== currentName

  useEffect(() => {
    if (!changed) {
      setPlan(null)
      return
    }
    let live = true
    const timer = setTimeout(() => {
      void ipcInvoke('media:planRename', {
        libraryId,
        mediaId,
        newName: trimmed,
        renameCompanions: withCompanions
      })
        .then((p) => live && setPlan(p))
        .catch(() => live && setPlan(null))
    }, 200)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [libraryId, mediaId, trimmed, withCompanions, changed])

  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await ipcInvoke('media:rename', {
        libraryId,
        mediaId,
        newName: trimmed,
        renameCompanions: withCompanions
      })
      onDone()
    } catch (e) {
      setError(toMessage(e))
      setBusy(false)
    }
  }

  // The media file and its sidecar always move together; the list is only
  // interesting for what else comes along, so those two are not repeated.
  const companions = (plan?.items ?? []).filter(
    (i) => i.kind !== 'media' && i.kind !== 'sidecar'
  )
  const blocked = (plan?.collides.length ?? 0) > 0

  return (
    <div className="modal-scrim">
      <div className="modal rename-modal">
        <div className="modal-head">
          <span className="grow">{t('media.rename.title')}</span>
          <button className="ghost sm" disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          <div className="lab">{t('media.rename.newName')}</div>
          <input
            className="search"
            value={name}
            autoFocus
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && changed && !blocked && void run()}
          />

          <label className="check">
            <input
              type="checkbox"
              checked={withCompanions}
              disabled={busy}
              onChange={(e) => setWithCompanions(e.target.checked)}
            />
            {t('media.rename.withCompanions')}
          </label>

          {blocked && <div className="error-banner">{t('errors.file_exists')}</div>}

          {changed && companions.length > 0 && (
            <>
              <div className="lab">{t('media.rename.companions')}</div>
              <div className="box delete-files">
                {companions.map((item) => (
                  <div className="rename-row" key={`${item.kind}:${item.from}`}>
                    <span className="delete-file-path">{item.from}</span>
                    {item.skipped ? (
                      <span className="rename-skip">{t(`media.rename.skip.${item.skipped}`)}</span>
                    ) : (
                      <>
                        <ArrowRight size={12} className="rename-arrow" />
                        <span className="delete-file-path">{item.to}</span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <div className="grow" />
          <button className="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="primary" disabled={busy || !changed || blocked} onClick={() => void run()}>
            {t('media.rename.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
