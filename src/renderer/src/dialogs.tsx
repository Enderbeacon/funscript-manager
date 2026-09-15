import { useSyncExternalStore } from 'react'
import ConfirmDialog from './components/ConfirmDialog'
import NamePromptDialog from './components/NamePromptDialog'

/**
 * The app's own replacements for `window.prompt` and `window.confirm`.
 *
 * `prompt` does nothing at all in Electron — it returns null without showing
 * anything, so every button built on it looked dead — and `confirm` draws a
 * system box that ignores the theme and the language the app is in. Both are
 * asked for the same way they were, as one awaited call, so a click handler
 * keeps reading top to bottom instead of growing a state variable per question.
 *
 * One question at a time; a second one waits behind the first. `DialogHost` is
 * mounted once by the app and draws whichever is at the front.
 */

export interface NameRequest {
  title: string
  initial?: string
  confirmLabel: string
  /**
   * Do the work while the dialog is still open. A throw keeps it open with the
   * error shown, so a name that is already taken can be corrected rather than
   * typed again from nothing.
   */
  submit?: (name: string) => Promise<void>
}

export interface ConfirmRequest {
  message: string
  confirmLabel: string
  /** Something is removed or overwritten; the button says so in red. */
  danger?: boolean
}

type Pending = { id: number } & (
  | { kind: 'name'; request: NameRequest; resolve: (name: string | null) => void }
  | { kind: 'confirm'; request: ConfirmRequest; resolve: (ok: boolean) => void }
)

let pending: Pending[] = []
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

function settle(entry: Pending): void {
  pending = pending.filter((other) => other !== entry)
  emit()
}

/** The trimmed name, or null when the dialog was dismissed. */
export function askName(request: NameRequest): Promise<string | null> {
  return new Promise((resolve) => {
    pending = [...pending, { id: nextId++, kind: 'name', request, resolve }]
    emit()
  })
}

export function askConfirm(request: ConfirmRequest): Promise<boolean> {
  return new Promise((resolve) => {
    pending = [...pending, { id: nextId++, kind: 'confirm', request, resolve }]
    emit()
  })
}

export function DialogHost(): React.JSX.Element | null {
  const queue = useSyncExternalStore(subscribe, () => pending)
  const front = queue[0]
  if (!front) return null

  if (front.kind === 'name') {
    const { request } = front
    return (
      <NamePromptDialog
        // A fresh dialog per question, so one typed name never leaks into the next.
        key={front.id}
        title={request.title}
        initial={request.initial}
        confirmLabel={request.confirmLabel}
        onSubmit={async (name) => {
          await request.submit?.(name)
          settle(front)
          front.resolve(name)
        }}
        onClose={() => {
          settle(front)
          front.resolve(null)
        }}
      />
    )
  }

  return (
    <ConfirmDialog
      key={front.id}
      message={front.request.message}
      confirmLabel={front.request.confirmLabel}
      danger={front.request.danger ?? false}
      onAnswer={(ok) => {
        settle(front)
        front.resolve(ok)
      }}
    />
  )
}
