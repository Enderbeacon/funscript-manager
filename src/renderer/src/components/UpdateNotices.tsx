import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { Announcement, LocalizedText, UpdateState } from '@shared/schemas/updates'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { useTour } from '../tour/tour'
import { useDialogEscape } from './ConfirmDialog'
import Markdown from './Markdown'

/**
 * Everything the app says about itself unprompted, one dialog at a time:
 * what changed in the version just installed, notices from the project, and
 * a newer release found by the automatic check.
 *
 * Mounted once in the main window. The settings page shows the same update
 * state in place, so a check started there never opens a dialog.
 */

type Notice =
  | { kind: 'whatsNew'; version: string; notes: string }
  | { kind: 'announcement'; announcement: Announcement }

export default function UpdateNotices({
  onOpenUpdates
}: {
  /** Take the user to the About page, where the whole story is. */
  onOpenUpdates: () => void
}): React.JSX.Element | null {
  const tour = useTour()
  const [notices, setNotices] = useState<Notice[]>([])
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)

  useEffect(() => {
    ipcInvoke('updates:startupNotices')
      .then(({ whatsNew, announcements }) => {
        setNotices([
          ...(whatsNew ? [{ kind: 'whatsNew' as const, ...whatsNew }] : []),
          ...announcements.map((announcement) => ({ kind: 'announcement' as const, announcement }))
        ])
      })
      .catch((e) => console.warn('[updates] notices unavailable:', e))

    /*
     * A release found while the app was still starting belongs on this screen,
     * and the answer waits for the check rather than racing it — the window
     * loads alongside it and can easily be here first.
     */
    ipcInvoke('updates:state').then(setUpdate).catch(() => {})
    ipcInvoke('updates:takePrompt')
      .then(({ offer }) => {
        if (offer) setPromptOpen(true)
      })
      .catch(() => {})
  }, [])

  useEffect(
    () =>
      ipcOn('event:update-state', (state) => {
        setUpdate(state)
        if (state.prompt && state.phase === 'available') setPromptOpen(true)
      }),
    []
  )

  // Keep notices queued until the tour has loaded and left the screen,
  // including its final hint. Otherwise its popup tracking highlights the
  // notice dialog instead of the control the current step is explaining.
  if (!tour.ready || tour.welcome || tour.menu || tour.hint || tour.offer || tour.section !== null) {
    return null
  }

  const front = notices[0]
  if (front) {
    const next = (): void => setNotices((cur) => cur.slice(1))
    if (front.kind === 'whatsNew') {
      return (
        <NoticeDialog
          title={<WhatsNewTitle version={front.version} />}
          body={front.notes}
          onClose={() => {
            void ipcInvoke('updates:dismissWhatsNew').catch(() => {})
            next()
          }}
        />
      )
    }
    return (
      <AnnouncementDialog
        announcement={front.announcement}
        onClose={() => {
          void ipcInvoke('updates:dismissAnnouncement', { id: front.announcement.id }).catch(() => {})
          next()
        }}
      />
    )
  }

  if (promptOpen && update?.release) {
    return (
      <UpdateDialog
        state={update}
        onOpenUpdates={() => {
          onOpenUpdates()
          setPromptOpen(false)
        }}
        onClose={() => setPromptOpen(false)}
      />
    )
  }
  return null
}

function WhatsNewTitle({ version }: { version: string }): React.JSX.Element {
  const { t } = useTranslation()
  return <>{t('updates.whatsNewTitle', { version })}</>
}

function AnnouncementDialog({
  announcement,
  onClose
}: {
  announcement: Announcement
  onClose: () => void
}): React.JSX.Element {
  const { i18n } = useTranslation()
  const pick = (text: LocalizedText): string =>
    text[i18n.resolvedLanguage ?? 'en'] ?? text[(i18n.resolvedLanguage ?? '').split('-')[0] ?? ''] ?? text.en
  return <NoticeDialog title={pick(announcement.title)} body={pick(announcement.body)} onClose={onClose} />
}

function NoticeDialog({
  title,
  body,
  onClose
}: {
  title: React.ReactNode
  body: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  useDialogEscape(onClose)
  return createPortal(
    <div className="modal-scrim">
      <div className="modal notice-modal">
        <div className="modal-head">
          <span className="grow">{title}</span>
        </div>
        <div className="modal-body">
          <Markdown source={body} />
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button className="primary" autoFocus onClick={onClose}>
            {t('updates.gotIt')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** A newer release: its notes, and download → restart without leaving the dialog. */
function UpdateDialog({
  state,
  onOpenUpdates,
  onClose
}: {
  state: UpdateState
  onOpenUpdates: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [failed, setFailed] = useState<string | null>(null)
  const release = state.release!
  useDialogEscape(onClose)

  const run = (action: () => Promise<unknown>): void => {
    setFailed(null)
    action().catch((e) => setFailed(toMessage(e)))
  }

  const skip = (): void => {
    void ipcInvoke('updates:skip', { version: release.version }).catch(() => {})
    onClose()
  }

  return createPortal(
    <div className="modal-scrim">
      <div className="modal notice-modal">
        <div className="modal-head">
          <span className="grow">{t('updates.availableTitle', { version: release.version })}</span>
          {release.channel === 'beta' && <span className="badge accent">{t('updates.channelBeta')}</span>}
        </div>
        <div className="modal-body">
          {release.notes.trim() ? (
            <Markdown source={release.notes} />
          ) : (
            <p className="settings-hint">{t('updates.noNotes')}</p>
          )}
          {state.phase === 'downloading' && <DownloadBar progress={state.progress} />}
          {state.phase === 'ready' && <p className="settings-hint">{t('updates.readyHint')}</p>}
          {state.phase === 'error' && state.error && (
            <p className="mfp-install-error">{t(`errors.${state.error}`)}</p>
          )}
          {failed && <p className="mfp-install-error">{failed}</p>}
        </div>
        <div className="modal-foot">
          {state.phase === 'available' && (
            <button className="ghost" onClick={skip}>
              {t('updates.skip')}
            </button>
          )}
          <div className="grow" />
          <button className="ghost" onClick={onClose}>
            {state.phase === 'downloading' ? t('updates.hide') : t('updates.later')}
          </button>
          {state.phase === 'available' &&
            (state.supported ? (
              <button className="primary" autoFocus onClick={() => run(() => ipcInvoke('updates:download'))}>
                {t('updates.download')}
              </button>
            ) : (
              // A copy that cannot replace itself still has somewhere to go:
              // the About page says why and offers the download.
              <button className="primary" autoFocus onClick={onOpenUpdates}>
                {t('updates.goToUpdates')}
              </button>
            ))}
          {state.phase === 'ready' && (
            <button className="primary" autoFocus onClick={() => run(() => ipcInvoke('updates:restart'))}>
              {t('updates.restart')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

export function DownloadBar({ progress }: { progress: number | null }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="update-progress">
      <div className="bar">
        <span style={{ width: `${progress ?? 0}%` }} />
      </div>
      <span>{t('updates.downloading', { percent: progress ?? 0 })}</span>
    </div>
  )
}
