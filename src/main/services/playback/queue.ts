import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { app } from 'electron'
import { QueueStateSchema, type QueueItem, type QueueSource, type QueueState } from '@shared/schemas/queue'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'
import * as libraryManager from '../library/library-manager'
import { playbackEvents, play } from './playback-service'

/**
 * What plays after this one.
 *
 * The queue is the only thing that knows about "next". Playback itself does
 * not: it loads a file, reports what happened, and stops there. Keeping the
 * two apart is what lets the engine underneath be replaced — today it is mpv
 * driving MultiFunPlayer, tomorrow it can be a player of our own, and none of
 * the ordering below has to change when it is.
 *
 * A queue is always a snapshot. Starting one copies the list as it stands, so
 * dragging a video out of the playlist while it plays does not yank the thing
 * that was going to play next out from under it — and, the other way round,
 * rearranging the queue never writes to a playlist. What the user assembles
 * here is kept by `saveAs`, which they ask for, not as a side effect.
 *
 * Everything below addresses items by mediaId rather than by position. The
 * list moves under every write — a card dropped in, three taken out — and a
 * position captured a moment ago is wrong by the time it is used, where "the
 * one after that one" still means what it said.
 */

export interface QueueEvents {
  'queue-changed': (state: QueueState) => void
}

class QueueEmitter extends EventEmitter {
  override on<K extends keyof QueueEvents>(e: K, l: QueueEvents[K]): this {
    return super.on(e, l)
  }
  override emit<K extends keyof QueueEvents>(e: K, ...args: Parameters<QueueEvents[K]>): boolean {
    return super.emit(e, ...args)
  }
}

export const queueEvents = new QueueEmitter()

const EMPTY: QueueState = {
  source: { kind: 'single' },
  items: [],
  index: -1,
  shuffle: false,
  repeat: false
}

let state: QueueState = EMPTY

/**
 * What the queue is called once the user has changed it.
 *
 * Adding, removing or reordering anything means the queue is no longer the
 * playlist or the view it was started from — so it stops claiming to be one.
 * The list on disk is untouched either way; a queue has always been a snapshot.
 */
const OWN: QueueSource = { kind: 'custom' }

/**
 * The order shuffle plays in, worked out once when shuffle is turned on rather
 * than by picking at random each time. Rolling a die per track can play the
 * same one twice and skip another entirely, and there is no "previous" that
 * means anything.
 *
 * Held as mediaIds, not positions: the queue is editable now, and a list of
 * positions is scrambled by the first insertion anywhere above them.
 */
let shuffled: string[] = []

/** Where the queue is kept between runs. Not a sidecar — it is not a property
 *  of any media, it is what the user was in the middle of. */
function queueFile(): string {
  return join(app.getPath('userData'), 'queue.json')
}

/** Coalesced: a drag reorder is a dozen states, and one write is enough. */
const SAVE_DEBOUNCE_MS = 400
let saveTimer: ReturnType<typeof setTimeout> | null = null

function persist(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void atomicWriteJson(queueFile(), state).catch((e) =>
      console.error('[queue] could not save the queue:', e)
    )
  }, SAVE_DEBOUNCE_MS)
}

function announce(): void {
  persist()
  queueEvents.emit('queue-changed', snapshot())
}

export function snapshot(): QueueState {
  return { ...state, items: [...state.items] }
}

/**
 * The queue the user left last time.
 *
 * Restored but not resumed: an app that starts playing a video on its own is
 * a startling app. The cursor is kept, so the play button carries on from
 * where they stopped.
 */
export async function restore(): Promise<void> {
  const parsed = QueueStateSchema.safeParse(await readJsonOr(queueFile(), null))
  if (!parsed.success) return
  state = { ...parsed.data, items: [...parsed.data.items] }
  if (state.index >= state.items.length) state.index = state.items.length - 1
  if (state.shuffle) reshuffle()
  queueEvents.emit('queue-changed', snapshot())
}

/* ---------------------------------------------------------------- ordering */

function ids(): string[] {
  return state.items.map((item) => item.mediaId)
}

/** The order actually being played — the queue's own, or the shuffled one. */
function playOrder(): string[] {
  return state.shuffle ? shuffled : ids()
}

function cursorId(): string | null {
  return state.items[state.index]?.mediaId ?? null
}

function indexOfId(mediaId: string | null): number {
  return mediaId === null ? -1 : state.items.findIndex((item) => item.mediaId === mediaId)
}

/** Fisher-Yates over the ids, with the one at the cursor pinned to the front. */
function reshuffle(): void {
  const current = cursorId()
  const rest = ids().filter((id) => id !== current)
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[rest[i], rest[j]] = [rest[j]!, rest[i]!]
  }
  shuffled = current === null ? rest : [current, ...rest]
}

/** Where the cursor sits in the order being played; -1 when it is in a gap. */
function playPosition(): number {
  const current = cursorId()
  return current === null ? -1 : playOrder().indexOf(current)
}

/* ------------------------------------------------------------------ moving */

/** Start a queue and play one of its items. */
export async function start(source: QueueSource, items: QueueItem[], at = 0): Promise<void> {
  state = { ...state, source, items: [...items], index: -1 }
  if (state.shuffle) reshuffle()
  await playAt(at)
}

export async function playAt(index: number): Promise<void> {
  const item = state.items[index]
  if (!item) return
  state = { ...state, index }
  if (state.shuffle) reshuffle()
  announce()
  const loc = libraryManager.getMediaLocation(item.libraryId, item.mediaId)
  await play({
    libraryRoot: loc.libraryRoot,
    mediaRelPath: loc.mediaRelPath,
    libraryId: item.libraryId,
    mediaId: item.mediaId
  })
}

/**
 * Step through the queue. `wrap` is what repeat means: off, running off either
 * end simply stops rather than looping round to a track the user did not ask
 * to hear again.
 */
async function step(delta: number, wrap: boolean): Promise<boolean> {
  const order = playOrder()
  if (order.length === 0) return false
  const pos = playPosition()
  // A cursor in a gap — the queue was restored, or what was playing has been
  // taken out — steps from the front rather than refusing to move.
  let next = pos < 0 ? (delta > 0 ? 0 : order.length - 1) : pos + delta
  if (next < 0 || next >= order.length) {
    if (!wrap) return false
    next = ((next % order.length) + order.length) % order.length
  }
  const index = indexOfId(order[next] ?? null)
  if (index < 0) return false
  await playAt(index)
  return true
}

export async function next(): Promise<boolean> {
  // Asking for the next one explicitly wraps even without repeat: the user
  // pressed a button, and doing nothing would look broken.
  return step(1, true)
}

export async function previous(): Promise<boolean> {
  return step(-1, true)
}

/** Play from the cursor — the bar's play button with nothing loaded yet. */
export async function resume(): Promise<boolean> {
  if (state.items.length === 0) return false
  const index = state.index >= 0 ? state.index : indexOfId(playOrder()[0] ?? null)
  if (index < 0) return false
  await playAt(index)
  return true
}

export function setShuffle(on: boolean): QueueState {
  state = { ...state, shuffle: on }
  if (on) reshuffle()
  announce()
  return snapshot()
}

export function setRepeat(on: boolean): QueueState {
  state = { ...state, repeat: on }
  announce()
  return snapshot()
}

/* ----------------------------------------------------------------- editing */

/**
 * Put media in the queue — right after what is playing, or at the end.
 *
 * Media already queued keep the place they had. Adding something twice is not
 * how you move it (that is `move`), and a queue that can hold the same file
 * twice has no answer to "where is it" for any of the operations below.
 */
export function add(
  incoming: QueueItem[],
  mode: 'next' | 'end',
  afterMediaId?: string | null
): QueueState {
  const seen = new Set(ids())
  const fresh: QueueItem[] = []
  for (const item of incoming) {
    if (seen.has(item.mediaId)) continue
    seen.add(item.mediaId)
    fresh.push(item)
  }
  if (fresh.length === 0) return snapshot()

  const items = [...state.items]
  // A drop names the row it landed after, which beats a position: by the time
  // the write lands the list may have moved, and the neighbour still means
  // what it said. `undefined` is "no drop involved", `null` is "at the front".
  const dropped = afterMediaId !== undefined
  const at = dropped
    ? afterMediaId === null
      ? 0
      : items.findIndex((item) => item.mediaId === afterMediaId) + 1
    : mode === 'next' && state.index >= 0
      ? state.index + 1
      : items.length
  // The neighbour named has gone; the back of the queue is the honest fallback.
  items.splice(dropped && afterMediaId !== null && at === 0 ? items.length : at, 0, ...fresh)

  if (state.shuffle) {
    const pos = playPosition()
    const where = mode === 'next' && pos >= 0 ? pos + 1 : shuffled.length
    shuffled.splice(where, 0, ...fresh.map((item) => item.mediaId))
  }

  const cursor = cursorId()
  state = { ...state, source: OWN, items, index: indexOfIn(items, cursor) }
  announce()
  return snapshot()
}

/**
 * Take media out.
 *
 * Removing what is playing does not stop it — the file on screen is not the
 * queue's to close. The cursor drops back to whatever came before it in the
 * order being played, so "next" still means the one that followed.
 */
export function remove(targets: { mediaId: string }[]): QueueState {
  const gone = new Set(targets.map((target) => target.mediaId))
  if (gone.size === 0) return snapshot()

  const order = playOrder()
  const current = cursorId()
  let anchor = current
  if (current !== null && gone.has(current)) {
    anchor = null
    for (let i = order.indexOf(current) - 1; i >= 0; i--) {
      const id = order[i]!
      if (!gone.has(id)) {
        anchor = id
        break
      }
    }
  }

  const items = state.items.filter((item) => !gone.has(item.mediaId))
  if (items.length === state.items.length) return snapshot()
  shuffled = shuffled.filter((id) => !gone.has(id))
  state = { ...state, source: OWN, items, index: indexOfIn(items, anchor) }
  announce()
  return snapshot()
}

/**
 * Put one item after another — null meaning the front.
 *
 * Shuffle is deliberately left alone: dragging a row is a statement about the
 * queue's own order, and shuffle is not playing that order. Turning shuffle
 * off shows the order the drag built.
 */
export function move(mediaId: string, afterMediaId: string | null): QueueState {
  const from = state.items.findIndex((item) => item.mediaId === mediaId)
  if (from < 0 || mediaId === afterMediaId) return snapshot()

  const cursor = cursorId()
  const items = [...state.items]
  const [moving] = items.splice(from, 1)
  const at =
    afterMediaId === null ? 0 : items.findIndex((item) => item.mediaId === afterMediaId) + 1
  // The neighbour named is no longer there; better to do nothing than to guess.
  if (afterMediaId !== null && at === 0) return snapshot()
  items.splice(at, 0, moving!)

  state = { ...state, source: OWN, items, index: indexOfIn(items, cursor) }
  announce()
  return snapshot()
}

/** Empty it. Whatever is playing keeps playing; it just has no next. */
export function clear(): QueueState {
  state = { ...EMPTY, shuffle: state.shuffle, repeat: state.repeat }
  shuffled = []
  announce()
  return snapshot()
}

function indexOfIn(items: QueueItem[], mediaId: string | null): number {
  return mediaId === null ? -1 : items.findIndex((item) => item.mediaId === mediaId)
}

/* ------------------------------------------------------ played elsewhere */

/**
 * Something started playing that did not come from this queue — a card played
 * from the library, the play button on the detail panel.
 *
 * It joins the queue rather than replacing it: right after whatever was
 * playing, which is where "and then this one" belongs. Play four videos out of
 * the library and the queue is those four, in the order they were picked.
 *
 * This is deliberately not "the screenful it came from". The page used to
 * swallow the whole result — eighteen hundred files, on a click — so "next"
 * meant the next card in a grid the user had not asked to hear. Taking the
 * whole view is still available, but only from the menu, where it is asked for.
 *
 * Already queued, and only the cursor moves: the list the user built is still
 * the list they are listening to.
 */
export function notePlayed(item: QueueItem): void {
  if (state.items[state.index]?.mediaId === item.mediaId) return
  const queued = indexOfId(item.mediaId)
  if (queued >= 0) {
    // No reshuffle: the shuffled order already holds this one, and rebuilding
    // it around the new cursor would rewrite what plays next for no reason.
    state = { ...state, index: queued }
    announce()
    return
  }
  const wasEmpty = state.items.length === 0
  const at = state.index >= 0 ? state.index + 1 : state.items.length
  const items = [...state.items]
  items.splice(at, 0, item)
  if (state.shuffle) {
    const pos = playPosition()
    shuffled.splice(pos >= 0 ? pos + 1 : shuffled.length, 0, item.mediaId)
  }
  state = {
    ...state,
    // The first video is a lone file and says so. The second makes it a queue.
    source: wasEmpty ? { kind: 'single' } : OWN,
    items,
    index: at
  }
  announce()
}

/**
 * One video finished, so play the one after it.
 *
 * Guarded on the media actually being ours: mpv is shared with MultiFunPlayer
 * and the user may have opened something in it by hand, and advancing *their*
 * viewing to *our* next track would be baffling.
 */
export function startAutoAdvance(): void {
  playbackEvents.on('playback-ended', ({ mediaId }) => {
    const current = state.items[state.index]
    if (!current || current.mediaId !== mediaId) return
    void step(1, state.repeat).catch((e) => console.error('[queue] could not advance:', e))
  })
}
