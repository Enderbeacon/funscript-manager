import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { TriangleAlert, X } from 'lucide-react'
import { ipcInvoke, ipcOn } from './ipc'
import { verifyDownload } from './verifyDownload'

/**
 * Short notices at the top centre of the window, for things that go wrong away
 * from where the user is looking.
 *
 * A failure that belongs to something on screen is said there, beside it. This
 * is for the rest: a download that fails in the background while the user is on
 * another page, an action whose own panel has already closed. Those used to
 * surface as a banner at the top of a page — or nowhere — and read as the app
 * simply not doing anything.
 *
 * `ToastHost` is mounted once by the app; anything may call `showToast`.
 */

export interface Toast {
  message: string
  action?: { label: string; run: () => void }
}

type Shown = Toast & { id: number }

/** How long a notice stays unless the pointer is resting on it. */
const LINGER_MS = 7000
/** More than this and the oldest make way; a burst must not fill the window. */
const MAX_SHOWN = 3

let shown: Shown[] = []
let nextId = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function showToast(toast: Toast): void {
  shown = [...shown, { ...toast, id: nextId++ }].slice(-MAX_SHOWN)
  emit()
}

function dismiss(id: number): void {
  shown = shown.filter((toast) => toast.id !== id)
  emit()
}

function ToastCard({ toast }: { toast: Shown }): React.JSX.Element {
  const { t } = useTranslation()
  const timer = useRef<number | null>(null)
  const arm = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => dismiss(toast.id), LINGER_MS)
  }
  useEffect(() => {
    arm()
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id])

  return (
    <div
      className="toast"
      role="alert"
      onMouseEnter={() => timer.current !== null && window.clearTimeout(timer.current)}
      onMouseLeave={arm}
    >
      <TriangleAlert size={14} className="toast-icon" />
      <span className="toast-text">{toast.message}</span>
      {toast.action && (
        <button
          className="toast-action"
          onClick={() => {
            toast.action!.run()
            dismiss(toast.id)
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" onClick={() => dismiss(toast.id)} aria-label={t('common.close')}>
        <X size={13} />
      </button>
    </div>
  )
}

export function ToastHost(): React.JSX.Element | null {
  const list = useSyncExternalStore(subscribe, () => shown)
  if (list.length === 0) return null
  return createPortal(
    <div className="toast-stack">
      {list.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body
  )
}

/**
 * A notice when a download fails. Only for failures that happen while the app
 * is open: the ones already in the queue at start were said at the time, and
 * the queue still lists them. Nothing is said while the queue itself is open —
 * the failure is right there.
 */
export function useDownloadFailureToasts(onOpenQueue: () => void, queueOpen: boolean): void {
  const { t } = useTranslation()
  const known = useRef<Set<string> | null>(null)
  const openQueue = useRef(onOpenQueue)
  openQueue.current = onOpenQueue
  const watching = useRef(queueOpen)
  watching.current = queueOpen
  const translate = useRef(t)
  translate.current = t

  useEffect(() => {
    let live = true
    const look = (): void => {
      ipcInvoke('download:list')
        .then(({ jobs }) => {
          if (!live) return
          const failed = jobs.filter((job) => job.state === 'failed')
          const first = known.current === null
          const fresh = first ? [] : failed.filter((job) => !known.current!.has(job.id))
          known.current = new Set(failed.map((job) => job.id))
          if (fresh.length === 0 || watching.current) return
          const tr = translate.current
          const only = fresh.length === 1 ? fresh[0]! : null
          showToast({
            message: only
              ? tr('toasts.downloadFailed', {
                  file: only.fileName,
                  reason: tr(`downloads.jobError.${only.error}`, {
                    defaultValue: tr('downloads.jobError.unknown')
                  })
                })
              : tr('toasts.downloadsFailed', { count: fresh.length }),
            // One download stuck behind a check: the useful move is the check.
            action:
              only?.error === 'verification_required'
                ? { label: tr('downloads.verify'), run: () => verifyDownload(only.id, tr) }
                : { label: tr('toasts.openQueue'), run: () => openQueue.current() }
          })
        })
        .catch(() => {})
    }
    look()
    const off = ipcOn('event:downloads-changed', look)
    return () => {
      live = false
      off()
    }
  }, [])
}
