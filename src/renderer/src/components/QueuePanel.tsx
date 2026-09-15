import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GripVertical,
  ListPlus,
  ListVideo,
  ListX,
  Play,
  Repeat,
  Shuffle,
  Trash2,
  X
} from 'lucide-react'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { QueueState } from '@shared/schemas/queue'
import type { MediaSelection } from '../App'
import { askName } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { isMediaDrag, readMediaDrag } from '../mediaDrag'
import { describeQueueSource } from '../queueSource'
import { useErrorMessage } from '../useErrorMessage'

/**
 * What plays next, and in what order.
 *
 * The queue used to have nowhere to be: the bar counted it ("3 / 47") and the
 * only panel in the app was the one listing saved playlists, so the one list
 * the user was actually listening to was the one they could not look at.
 *
 * Everything here addresses rows by mediaId. A drop lands "after that one"
 * rather than "at position 7", which still means what it said if the queue
 * moved between the gesture and the write — the video that finished mid-drag
 * being the ordinary way that happens.
 *
 * Nothing here writes to a playlist. Reordering the queue is not editing the
 * list it came from; keeping what was assembled is `save`, which the user asks
 * for.
 */
export default function QueuePanel({
  onOpen,
  onClose,
  playingId
}: {
  onOpen: (selection: MediaSelection) => void
  onClose: () => void
  /** What is playing right now — highlighted wherever it sits in the list. */
  playingId: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [rows, setRows] = useState<Map<string, MediaListItem>>(() => new Map())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** Row being dragged inside the list, and the row it would land after. */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAfter, setDropAfter] = useState<string | null | undefined>(undefined)
  /** Something from the grid is in flight, so the list can offer itself. */
  const [dropFromGrid, setDropFromGrid] = useState(false)

  useEffect(() => {
    ipcInvoke('queue:get').then(setQueue).catch(() => {})
    return ipcOn('event:queue-changed', setQueue)
  }, [])

  /*
   * The titles behind the ids, in one call rather than one per row: a queue is
   * routinely a couple of hundred long and this panel opens on a keypress.
   */
  const loadRows = useCallback(async (items: QueueState['items']): Promise<void> => {
    if (items.length === 0) {
      setRows(new Map())
      return
    }
    try {
      const { items: found } = await ipcInvoke('media:listByIds', { targets: items })
      setRows(new Map(found.map((row) => [row.id, row])))
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    }
  }, [toMessage])

  useEffect(() => {
    if (!queue) return
    void loadRows(queue.items)
  }, [queue, loadRows])

  useEffect(() => {
    return ipcOn('event:media-changed', () => {
      if (queue) void loadRows(queue.items)
    })
  }, [queue, loadRows])

  const items = queue?.items ?? []
  const totalMs = useMemo(
    () => items.reduce((sum, item) => sum + (rows.get(item.mediaId)?.durationMs ?? 0), 0),
    [items, rows]
  )

  const run = async (work: Promise<unknown>): Promise<void> => {
    try {
      await work
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    }
  }

  /** Where a drop would land, as the row it follows (null = the front). */
  const dropPoint = (
    e: React.DragEvent,
    index: number,
    mediaId: string
  ): string | null => {
    const box = e.currentTarget.getBoundingClientRect()
    const before = e.clientY < box.top + box.height / 2
    return before ? (items[index - 1]?.mediaId ?? null) : mediaId
  }

  const endDrag = async (): Promise<void> => {
    const moving = dragging
    const after = dropAfter
    setDragging(null)
    setDropAfter(undefined)
    if (!moving || after === undefined || after === moving) return
    await run(ipcInvoke('queue:move', { mediaId: moving, afterMediaId: after }))
  }

  const dropCards = async (e: React.DragEvent, after: string | null): Promise<void> => {
    const targets = readMediaDrag(e)
    setDropFromGrid(false)
    setDropAfter(undefined)
    if (!targets) return
    e.preventDefault()
    await run(ipcInvoke('queue:add', { items: targets, mode: 'end', afterMediaId: after }))
  }

  const save = (): void =>
    void askName({
      title: t('queue.savePrompt'),
      confirmLabel: t('queue.save'),
      submit: async (name) => {
        const done = await ipcInvoke('queue:saveAsPlaylist', { name })
        setNotice(t('queue.saved', { name: done.name, count: done.added }))
        setError(null)
      }
    })

  return (
    <div className="panel queue-panel">
      <div className="panel-head">
        <ListVideo size={15} className="pl-icon" />
        <span className="grow">{t('queue.title')}</span>
        <button
          className="icon-btn"
          title={t('queue.save')}
          disabled={items.length === 0}
          onClick={save}
        >
          <ListPlus size={14} />
        </button>
        <button
          className="icon-btn"
          title={t('queue.clear')}
          disabled={items.length === 0}
          onClick={() => void run(ipcInvoke('queue:clear'))}
        >
          <Trash2 size={14} />
        </button>
        <button className="icon-btn" title={t('common.close')} onClick={onClose}>
          <X size={14} />
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {notice && (
        <div className="detail-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      <div className="cur-head">
        <div className="cur-title">
          <span className="cur-name">{describeQueueSource(queue, t)}</span>
        </div>
        <div className="cur-meta">
          {t('playlist.summary', { count: items.length, duration: formatSpan(totalMs) })}
        </div>
        <div className="cur-tools">
          <button
            className={`ghost sm${queue?.shuffle ? ' active' : ''}`}
            aria-pressed={queue?.shuffle ?? false}
            onClick={() => void run(ipcInvoke('queue:setMode', { shuffle: !queue?.shuffle }))}
          >
            <Shuffle size={12} /> {t('playlist.shuffle')}
          </button>
          <button
            className={`ghost sm${queue?.repeat ? ' active' : ''}`}
            aria-pressed={queue?.repeat ?? false}
            onClick={() => void run(ipcInvoke('queue:setMode', { repeat: !queue?.repeat }))}
          >
            <Repeat size={12} /> {t('playlist.repeat')}
          </button>
        </div>
      </div>

      {/* The list takes drops on its own account too, so cards can be added to
          an empty queue and to the space under the last row. */}
      <div
        className={`cur-list${dropFromGrid ? ' dropping' : ''}`}
        onDragOver={(e) => {
          if (dragging) {
            e.preventDefault()
            return
          }
          if (!isMediaDrag(e)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropFromGrid(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDropFromGrid(false)
          setDropAfter(undefined)
        }}
        onDrop={(e) => void dropCards(e, items.at(-1)?.mediaId ?? null)}
      >
        {items.length === 0 && (
          <div className="empty">
            {t('queue.empty')}
            <div className="queue-hint">{t('queue.emptyHint')}</div>
          </div>
        )}
        {items.map((item, index) => {
          const row = rows.get(item.mediaId)
          const name = row?.title ?? row?.fileName ?? t('queue.missingRow')
          return (
            <div
              key={item.mediaId}
              className={`qrow${item.mediaId === playingId ? ' now' : ''}${dragging === item.mediaId ? ' moving' : ''}${dropAfter === (items[index - 1]?.mediaId ?? null) ? ' droptarget' : ''}`}
              draggable
              onDragStart={() => setDragging(item.mediaId)}
              onDragEnd={() => void endDrag()}
              onDragOver={(e) => {
                if (!dragging && !isMediaDrag(e)) return
                e.preventDefault()
                setDropAfter(dropPoint(e, index, item.mediaId))
              }}
              onDrop={(e) => {
                if (dragging) return
                // The list behind this row takes drops too; without this the
                // same cards would be handed to it a second time.
                e.stopPropagation()
                void dropCards(e, dropPoint(e, index, item.mediaId))
              }}
              onClick={() => onOpen({ libraryId: item.libraryId, mediaId: item.mediaId })}
              onDoubleClick={(e) => {
                e.stopPropagation()
                void run(ipcInvoke('queue:playAt', { index }))
              }}
            >
              <span className="qgrip">
                <GripVertical size={13} />
              </span>
              <span className="qn">
                {item.mediaId === playingId ? <Play size={10} fill="currentColor" /> : index + 1}
              </span>
              {/* The frame is the play button: a row of numbered boxes told
                  the user nothing about what they were queuing. */}
              <button
                className="qart"
                aria-label={t('playlist.playFrom')}
                onClick={(e) => {
                  e.stopPropagation()
                  void run(ipcInvoke('queue:playAt', { index }))
                }}
              >
                <CachedIpcImage
                  className="qart-img"
                  cache={thumbCache}
                  channel="media:getThumbnail"
                  libraryId={item.libraryId}
                  mediaId={item.mediaId}
                />
                <span className="qart-play">
                  <Play size={13} fill="currentColor" />
                </span>
              </button>
              <span className="qtxt">
                <b title={name}>{name}</b>
                <i>{row?.filePath ?? ''}</i>
              </span>
              <span className="qd">{formatSpan(row?.durationMs ?? null)}</span>
              <button
                className="qx"
                aria-label={t('queue.removeItem')}
                onClick={(e) => {
                  e.stopPropagation()
                  void run(ipcInvoke('queue:remove', { items: [item] }))
                }}
              >
                <ListX size={12} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** `1:04:12` / `22:10`; blank when the file has never been probed. */
function formatSpan(ms: number | null): string {
  if (!ms || ms <= 0) return ''
  const total = Math.round(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
