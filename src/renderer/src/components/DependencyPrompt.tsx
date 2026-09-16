import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { BinaryId, InstallProgress } from '@shared/schemas/dependencies'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useDialogEscape } from './ConfirmDialog'

/**
 * The startup offer to download yt-dlp and ffmpeg when either will not run.
 *
 * The guided tour walks through the same installs on the settings page; this
 * is for everyone who never took it, or left it before installing. Nothing
 * ships inside the app, so without one of these a fresh copy has no
 * thumbnails and no video-site downloads, and nothing else says why.
 *
 * The downloads run one after another in the main process. Hiding the dialog
 * mid-way does not stop them — the settings page shows the same installs.
 */

type ItemState =
  | { phase: 'waiting' }
  | { phase: 'running'; progress: InstallProgress | null }
  | { phase: 'done' }
  | { phase: 'failed'; error: string }

const NAME: Record<BinaryId, string> = { ytdlp: 'yt-dlp', ffmpeg: 'ffmpeg' }

export default function DependencyPrompt({
  ids,
  onClose
}: {
  /** The binaries found missing at startup, in the order they install. */
  ids: BinaryId[]
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [items, setItems] = useState<Partial<Record<BinaryId, ItemState>>>({})
  useDialogEscape(onClose)

  useEffect(
    () =>
      ipcOn('event:dep-progress', (progress) =>
        setItems((cur) =>
          cur[progress.id]?.phase === 'running' ? { ...cur, [progress.id]: { phase: 'running', progress } } : cur
        )
      ),
    []
  )

  const states = ids.map((id) => items[id])
  const started = states.some((s) => s !== undefined)
  const busy = states.some((s) => s?.phase === 'running' || s?.phase === 'waiting')
  const failed = states.some((s) => s?.phase === 'failed')

  /** Everything not yet installed — the first press, and every retry. */
  const download = async (): Promise<void> => {
    const queue = ids.filter((id) => items[id]?.phase !== 'done')
    setItems((cur) => ({ ...cur, ...Object.fromEntries(queue.map((id) => [id, { phase: 'waiting' }])) }))
    for (const id of queue) {
      setItems((cur) => ({ ...cur, [id]: { phase: 'running', progress: null } }))
      try {
        await ipcInvoke('deps:install', { id })
        setItems((cur) => ({ ...cur, [id]: { phase: 'done' } }))
      } catch (e) {
        setItems((cur) => ({ ...cur, [id]: { phase: 'failed', error: toMessage(e) } }))
      }
    }
  }

  const neverAsk = (): void => {
    void ipcInvoke('settings:update', { dependencies: { skipPrompt: true } }).catch(() => {})
    onClose()
  }

  const statusText = (state: ItemState | undefined): string | null => {
    if (state?.phase === 'done') return t('depsPrompt.installed')
    if (state?.phase !== 'running' || !state.progress) return null
    if (state.progress.phase === 'extracting') return t('settings.deps.extracting')
    const { bytesDownloaded, totalBytes } = state.progress
    return totalBytes ? `${Math.floor((bytesDownloaded / totalBytes) * 100)}%` : t('settings.deps.working')
  }

  return createPortal(
    <div className="modal-scrim">
      <div className="modal notice-modal">
        <div className="modal-head">
          <span className="grow">{t('depsPrompt.title')}</span>
        </div>
        <div className="modal-body">
          <p className="settings-hint">{t('depsPrompt.body')}</p>
          {ids.map((id) => {
            const state = items[id]
            const status = statusText(state)
            return (
              <div key={id} className="deps-prompt-item">
                <div className="dep-row">
                  <span className={`dep-dot ${state?.phase === 'done' ? 'ok' : 'off'}`} />
                  <span className="dep-name">{NAME[id]}</span>
                  <span className="dep-version">{t(`depsPrompt.${id}`)}</span>
                  {status && <span className="deps-prompt-status">{status}</span>}
                </div>
                {state?.phase === 'failed' && <p className="mfp-install-error">{state.error}</p>}
              </div>
            )
          })}
        </div>
        <div className="modal-foot">
          {!started && (
            <button className="ghost" onClick={neverAsk}>
              {t('depsPrompt.never')}
            </button>
          )}
          <div className="grow" />
          {busy ? (
            <button className="ghost" onClick={onClose}>
              {t('depsPrompt.hide')}
            </button>
          ) : started && !failed ? (
            <button className="primary" autoFocus onClick={onClose}>
              {t('depsPrompt.done')}
            </button>
          ) : (
            <>
              <button className="ghost" onClick={onClose}>
                {t('depsPrompt.later')}
              </button>
              <button className="primary" autoFocus onClick={() => void download()}>
                {failed ? t('depsPrompt.retry') : t('depsPrompt.download')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
