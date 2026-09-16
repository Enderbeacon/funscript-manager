import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { FileQuestion, X } from 'lucide-react'
import type { PairingRequest } from '@shared/schemas/download'
import Select from './Select'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useEscape } from '../useEscape'

/**
 * Scripts from a post with several videos that the names could not place.
 *
 * The download went ahead and every script the names did settle is already
 * filed; these few wait here instead of being guessed into the wrong entry,
 * which nobody would notice until the device moved out of step with the video.
 * The likeliest video is picked in advance, so a right guess is one click.
 */

const OWN = 'own'

/** The waiting requests, kept current with the queue. */
function usePairingRequests(): { requests: PairingRequest[]; reload: () => void } {
  const [requests, setRequests] = useState<PairingRequest[]>([])
  const reload = useCallback(() => {
    ipcInvoke('download:pairings')
      .then(({ requests: list }) => setRequests(list))
      .catch(() => {})
  }, [])
  useEffect(() => {
    reload()
    return ipcOn('event:downloads-changed', reload)
  }, [reload])
  return { requests, reload }
}

/** A line in the queue saying scripts are waiting, which opens the question. */
export function ScriptPairingPrompt(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { requests, reload } = usePairingRequests()
  const [open, setOpen] = useState(false)
  const count = requests.reduce((sum, r) => sum + r.scripts.length, 0)
  if (count === 0) return null
  return (
    <>
      <button className="pair-prompt" type="button" onClick={() => setOpen(true)}>
        <FileQuestion size={14} />
        <span>{t('pairing.prompt', { count })}</span>
      </button>
      {open && (
        <ScriptPairingDialog
          requests={requests}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false)
            reload()
          }}
        />
      )}
    </>
  )
}

function ScriptPairingDialog({
  requests,
  onClose,
  onDone
}: {
  requests: PairingRequest[]
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      requests.flatMap((r) => r.scripts.map((s) => [s.jobId, s.guess ?? OWN] as const))
    )
  )

  useEscape(onClose, !busy)

  const apply = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      for (const request of requests) {
        await ipcInvoke('download:resolvePairing', {
          batchId: request.batchId,
          assignments: request.scripts.map((s) => ({
            jobId: s.jobId,
            target: choice[s.jobId] ?? OWN
          }))
        })
      }
      onDone()
    } catch (e) {
      setError(toMessage(e))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-scrim">
      <div className="modal pair-modal">
        <div className="modal-head">
          <span className="grow">{t('pairing.title')}</span>
          <button className="ghost sm" disabled={busy} onClick={onClose} aria-label={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="modal-body">
          {error && <div className="error-banner">{error}</div>}
          {requests.map((request) => {
            const options = [
              ...request.videos.map((video) => ({
                value: video.jobId,
                label: [
                  video.note || video.fileName,
                  video.arrived ? '' : t('pairing.notDownloaded')
                ]
                  .filter(Boolean)
                  .join(' · ')
              })),
              { value: OWN, label: t('pairing.ownEntry') }
            ]
            return (
              <section className="pair-post" key={request.batchId}>
                <div className="pair-post-title" title={request.postUrl}>
                  {request.postTitle}
                </div>
                {request.scripts.map((script) => (
                  <div className="pair-row" key={script.jobId}>
                    <span className="pair-script" title={script.fileName}>
                      {script.fileName}
                    </span>
                    <Select
                      className="pair-select"
                      value={choice[script.jobId] ?? OWN}
                      options={options}
                      disabled={busy}
                      ariaLabel={script.fileName}
                      onChange={(value) => setChoice((cur) => ({ ...cur, [script.jobId]: value }))}
                    />
                  </div>
                ))}
              </section>
            )
          })}
        </div>

        <div className="modal-foot">
          <div className="grow" />
          <button className="ghost" disabled={busy} onClick={onClose}>
            {t('pairing.later')}
          </button>
          <button className="primary" disabled={busy} onClick={() => void apply()}>
            {t('pairing.apply')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
