import { useCallback, useEffect, useMemo, useState } from 'react'
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

type PairingScript = PairingRequest['scripts'][number]

/** A script and its axis files, which go to one video or to none of them. */
interface ScriptSet {
  key: string
  /** The name the files share, with no axis token on it. */
  family: string
  files: PairingScript[]
  /** The video to offer first, from whichever file the names placed best. */
  guess: string | null
}

/** `clip.roll.funscript` in the set `clip` is its `roll` axis. */
function axisOf(script: PairingScript, family: string): string {
  const rest = script.fileName.slice(family.length).replace(/\.funscript$/i, '')
  return rest.startsWith('.') ? rest.slice(1) : 'main'
}

/**
 * The sets a request's scripts fall into. A multi-axis script is one question,
 * not one per file: its axes describe the same movement and are unplayable
 * apart, so letting them be answered separately only offers a way to break
 * them up.
 */
function scriptSets(request: PairingRequest): ScriptSet[] {
  const sets = new Map<string, ScriptSet>()
  for (const script of request.scripts) {
    const key = `${request.batchId}:${script.family}`
    const set = sets.get(key) ?? { key, family: script.family, files: [], guess: null }
    set.files.push(script)
    set.guess ??= script.guess
    sets.set(key, set)
  }
  for (const set of sets.values()) {
    set.files.sort((a, b) => {
      const [x, y] = [axisOf(a, set.family), axisOf(b, set.family)]
      if (x === y) return 0
      if (x === 'main') return -1
      if (y === 'main') return 1
      return x.localeCompare(y)
    })
  }
  return [...sets.values()]
}

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
  // Sets, not files: a script with five axes is one thing to answer for.
  const count = requests.reduce((sum, r) => sum + scriptSets(r).length, 0)
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
  const setsOf = useMemo(() => new Map(requests.map((r) => [r.batchId, scriptSets(r)])), [requests])
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      [...setsOf.values()].flat().map((set) => [set.key, set.guess ?? OWN] as const)
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
          assignments: (setsOf.get(request.batchId) ?? []).flatMap((set) =>
            set.files.map((file) => ({ jobId: file.jobId, target: choice[set.key] ?? OWN }))
          )
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
                {(setsOf.get(request.batchId) ?? []).map((set) => (
                  <div className="pair-row" key={set.key}>
                    <span
                      className="pair-script"
                      title={set.files.map((file) => file.fileName).join('\n')}
                    >
                      {set.family}
                      {set.files.length > 1 && (
                        <span className="pair-axes">
                          {set.files.map((file) => axisOf(file, set.family)).join(' · ')}
                        </span>
                      )}
                    </span>
                    <Select
                      className="pair-select"
                      value={choice[set.key] ?? OWN}
                      options={options}
                      disabled={busy}
                      ariaLabel={set.family}
                      onChange={(value) => setChoice((cur) => ({ ...cur, [set.key]: value }))}
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
