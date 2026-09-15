import { EventEmitter } from 'node:events'
import { getSettings } from '../config/config-service'
import { isMfpRunning } from './mfp'

/**
 * MultiFunPlayer's presence, for the sidebar.
 *
 * Everything else in that panel reports itself: the players push their own
 * status when it changes, and so do the devices. MFP is the one thing with no
 * channel of its own — it has no control surface at all — so it is
 * looked for by process, and only every few seconds.
 *
 * `null` off the MFP route, and then not looked for at all: finding out costs
 * a `tasklist` process every poll, which is a lot to spend on a program the
 * user has not chosen to involve.
 */

export interface ConnStatus {
  mfp: 'running' | 'off' | null
}

export interface ConnStatusEvents {
  change: (status: ConnStatus) => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof ConnStatusEvents>(e: K, l: ConnStatusEvents[K]): this {
    return super.on(e, l)
  }
  override emit<K extends keyof ConnStatusEvents>(
    e: K,
    ...args: Parameters<ConnStatusEvents[K]>
  ): boolean {
    return super.emit(e, ...args)
  }
}

export const connStatusEvents = new TypedEmitter()

const POLL_MS = 3000

let timer: NodeJS.Timeout | null = null
let last: ConnStatus | null = null
let sampling = false

export async function sampleConnStatus(): Promise<ConnStatus> {
  const onMfpRoute = (await getSettings()).playback.scriptRoute === 'mfp'
  if (!onMfpRoute) return { mfp: null }
  return { mfp: (await isMfpRunning()) ? 'running' : 'off' }
}

async function poll(): Promise<void> {
  if (sampling) return
  sampling = true
  try {
    const status = await sampleConnStatus()
    if (!last || last.mfp !== status.mfp) {
      last = status
      connStatusEvents.emit('change', status)
    }
  } finally {
    sampling = false
  }
}

export function startConnStatusPolling(): void {
  if (timer) return
  timer = setInterval(() => void poll(), POLL_MS)
  void poll()
}

export function stopConnStatusPolling(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/** Re-check immediately (after play/launch actions) so the UI updates fast. */
export function pokeConnStatus(): void {
  void poll()
}
