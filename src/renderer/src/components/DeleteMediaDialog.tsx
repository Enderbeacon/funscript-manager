import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, X } from 'lucide-react'
import type { DeleteMode, DeletePlan } from '@shared/schemas/media-lifecycle'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useEscape } from '../useEscape'

/**
 * The confirmation for the app's only operation that destroys the user's own
 * files.
 *
 * It asks which of two things they mean before it asks whether they are sure,
 * and it names the files either way. "Delete" and "remove from library" are
 * near-synonyms in English and identical in a toolbar; the difference between
 * them is a video the user cannot get back.
 */

export interface DeleteTarget {
  libraryId: string
  mediaId: string
}

/**
 * The grid's selection can span libraries, and each library owns its own index
 * and ignore list. Grouping here keeps that a detail of the dialog rather than
 * something every caller has to remember.
 */
function byLibrary(targets: DeleteTarget[]): { libraryId: string; mediaIds: string[] }[] {
  const groups = new Map<string, string[]>()
  for (const target of targets) {
    groups.set(target.libraryId, [...(groups.get(target.libraryId) ?? []), target.mediaId])
  }
  return [...groups].map(([libraryId, mediaIds]) => ({ libraryId, mediaIds }))
}

function mergePlans(plans: DeletePlan[]): DeletePlan {
  return {
    entries: plans.flatMap((p) => p.entries),
    files: plans.flatMap((p) => p.files),
    shared: plans.flatMap((p) => p.shared),
    companions: plans.flatMap((p) => p.companions),
    canKeepScripts: plans.some((p) => p.canKeepScripts)
  }
}

export default function DeleteMediaDialog({
  targets,
  initialMode = null,
  onClose,
  onDone
}: {
  targets: DeleteTarget[]
  /** Already chosen by how the dialog was opened; still changeable here. */
  initialMode?: DeleteMode | null
  onClose: () => void
  /** Fired after a successful delete, with the number of entries removed. */
  onDone: (removed: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [mode, setMode] = useState<DeleteMode | null>(initialMode)
  const [plan, setPlan] = useState<DeletePlan | null>(null)
  const [keepScripts, setKeepScripts] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEscape(onClose, !busy)

  const key = targets.map((tgt) => `${tgt.libraryId}:${tgt.mediaId}`).join(',')

  useEffect(() => {
    if (mode === null) {
      setPlan(null)
      return
    }
    let live = true
    setPlan(null)
    void Promise.all(
      byLibrary(targets).map((group) => ipcInvoke('media:planDelete', { ...group, mode }))
    )
      .then((plans) => live && setPlan(mergePlans(plans)))
      .catch((e) => live && setError(toMessage(e)))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, key])

  const run = async (): Promise<void> => {
    if (mode === null) return
    setBusy(true)
    setError(null)
    try {
      const results = await Promise.all(
        byLibrary(targets).map((group) =>
          ipcInvoke('media:delete', { ...group, mode, keepScripts })
        )
      )
      const failed = results.flatMap((r) => r.failed)
      const removed = results.reduce((n, r) => n + r.removed, 0)
      if (failed.length > 0) {
        setError(t('media.delete.someFailed', { files: failed.join(', ') }))
        setBusy(false)
        return
      }
      onDone(removed)
    } catch (e) {
      setError(toMessage(e))
      setBusy(false)
    }
  }

  const count = targets.length

  return (
    <div className="modal-scrim">
      <div className="modal delete-modal">
        <div className="modal-head">
          <span className="grow">{t('media.delete.title', { count })}</span>
          <button className="ghost sm" disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}

          {/* Which of the two, first. Neither is preselected: a default here
              would be a guess at the one thing the user has to say out loud. */}
          <div className="delete-choices">
            {(['library', 'files'] as const).map((value) => (
              <button
                key={value}
                className={`delete-choice${mode === value ? ' on' : ''}${value === 'files' ? ' danger' : ''}`}
                aria-pressed={mode === value}
                disabled={busy}
                onClick={() => setMode(value)}
              >
                <span className="delete-choice-title">{t(`media.delete.mode.${value}`)}</span>
                <span className="delete-choice-hint">{t(`media.delete.modeHint.${value}`)}</span>
              </button>
            ))}
          </div>

          {mode !== null && plan === null && <div className="empty">…</div>}

          {mode !== null && plan !== null && (
            <>
              {mode === 'files' && (
                <>
                  <div className="lab">{t('media.delete.willTrash', { count: plan.files.length })}</div>
                  <div className="box delete-files">
                    {plan.files.length === 0 && <span className="fempty">{t('media.delete.noFiles')}</span>}
                    {plan.files.map((f) => (
                      <div className="delete-file" key={`${f.kind}:${f.path}`}>
                        <span className={`badge kind-${f.kind}`}>{t(`media.delete.kind.${f.kind}`)}</span>
                        <span className="delete-file-path">{f.path}</span>
                      </div>
                    ))}
                  </div>
                  <p className="settings-hint">{t('media.delete.recycleNote')}</p>
                </>
              )}

              {/* The second warning the user asked for: a script another entry
                  reads is left alone, and the dialog says whose it is rather
                  than leaving them to find out when that entry stops working. */}
              {mode === 'files' && plan.shared.length > 0 && (
                <div className="delete-shared">
                  <div className="delete-shared-head">
                    <AlertTriangle size={14} />
                    {t('media.delete.sharedTitle', { count: plan.shared.length })}
                  </div>
                  {plan.shared.map((s) => (
                    <div className="delete-shared-row" key={s.path}>
                      <span className="delete-file-path">{s.path}</span>
                      <span className="delete-shared-who">
                        {s.usedBy.map((u) => u.title || u.mediaPath).join(' · ')}
                      </span>
                    </div>
                  ))}
                  <div className="delete-shared-note">{t('media.delete.sharedNote')}</div>
                </div>
              )}

              {mode === 'library' && (
                <>
                  <p className="settings-hint">{t('media.delete.libraryNote')}</p>
                  {plan.canKeepScripts && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={keepScripts}
                        disabled={busy}
                        onChange={(e) => setKeepScripts(e.target.checked)}
                      />
                      {t('media.delete.keepScripts')}
                    </label>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="count">{t('media.delete.entryCount', { count })}</span>
          <div className="grow" />
          <button className="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className={mode === 'files' ? 'danger' : 'primary'}
            disabled={busy || mode === null || plan === null}
            onClick={() => void run()}
          >
            {mode === 'files'
              ? t('media.delete.confirmFiles', { count })
              : t('media.delete.confirmLibrary', { count })}
          </button>
        </div>
      </div>
    </div>
  )
}
