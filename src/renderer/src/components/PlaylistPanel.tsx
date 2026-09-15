import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  GripVertical,
  ListPlus,
  ListVideo,
  ListX,
  Pin,
  Play,
  Repeat,
  Search,
  Shuffle,
  X
} from 'lucide-react'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { QueueState } from '@shared/schemas/queue'
import type { MediaSelection } from '../App'
import { ipcInvoke, ipcOn } from '../ipc'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { isMediaDrag, readMediaDrag, type MediaDragTarget } from '../mediaDrag'
import { askConfirm, askName } from '../dialogs'
import { useErrorMessage } from '../useErrorMessage'
import ContextMenu from './ContextMenu'
import type { Taxonomy } from './NameChips'

/**
 * Playlists, and what is in the one you picked.
 *
 * Two lists that scroll independently, because they grow independently: forty
 * playlists must not be able to push the tracks off the panel, and two hundred
 * tracks must not bury the list of playlists. The upper one is a fixed frame
 * with its own scrollbar; the lower one takes whatever is left.
 *
 * Order is the point of the whole feature, so the rows are draggable and the
 * drop lands where the line shows. Everything about *where* a track sits is
 * worked out by the main process — the renderer only ever says "put this one
 * after that one", which stays true even if the list changed underneath.
 */

const PAGE = 500

/**
 * Where pinning puts a list in the taxonomy's own ordering. A list with no
 * order sorts as 0, so a pin has to be below that to come first, and an unpin
 * writes 0 to put the list back among the rest by name — the patch has no way
 * to say "unset".
 */
const PIN_ORDER = -1
const UNPINNED_ORDER = 0
const isPinned = (order: number | null): boolean => (order ?? 0) < 0

/**
 * Whether the list of lists is folded away, kept outside the component so it
 * survives the panel being closed and opened again. Someone who folds it is
 * working inside one playlist, and having it spring back open every time they
 * come back is the panel forgetting what they were doing.
 */
let foldedLists = false

export default function PlaylistPanel({
  taxonomy,
  selected,
  onSelect,
  onOpen,
  onClose,
  playingId
}: {
  taxonomy: Taxonomy | null
  /** Which playlist is expanded below; null until one is picked. */
  selected: string | null
  onSelect: (name: string | null) => void
  onOpen: (selection: MediaSelection) => void
  onClose: () => void
  playingId: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [trackQuery, setTrackQuery] = useState('')
  const [tracks, setTracks] = useState<MediaListItem[]>([])
  /** A list's ⋯ menu, drawn on the body so the scrolling frame cannot clip it. */
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null)
  /** Row being dragged, and the row it would land after (null = the front). */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAfter, setDropAfter] = useState<string | null | undefined>(undefined)
  /** Playlist a card from the grid is hovering over. */
  const [dropOnto, setDropOnto] = useState<string | null>(null)
  /** Something from the grid is in flight, so the rows can offer themselves. */
  const [dragOver, setDragOver] = useState(false)
  /** Tracks ticked in the open list, for taking several out at once. */
  const [ticked, setTicked] = useState<Set<string>>(() => new Set())
  /**
   * Shuffle and repeat belong to the queue, not to any one playlist — there is
   * one player and it is either shuffling or it is not. The two buttons below
   * show and set that, rather than being a second pair that means something
   * else.
   */
  const [queue, setQueue] = useState<QueueState | null>(null)
  /** The upper frame folded away, to give the open list the whole panel. */
  const [folded, setFolded] = useState(foldedLists)
  const fold = (next: boolean): void => {
    foldedLists = next
    setFolded(next)
  }

  const lists = taxonomy?.entities.playlists ?? []
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return lists
    return lists.filter(
      (l) => l.name.toLowerCase().includes(q) || l.aliases.some((a) => a.toLowerCase().includes(q))
    )
  }, [lists, query])

  const loadTracks = useCallback(async (): Promise<void> => {
    if (!selected) {
      setTracks([])
      return
    }
    try {
      const page = await ipcInvoke('media:list', {
        offset: 0,
        limit: PAGE,
        sort: 'playlist',
        playlistOrder: selected,
        filter: {
          kind: 'group',
          match: 'all',
          children: [{ kind: 'rule', field: 'playlists', op: 'includes', value: [selected] }]
        }
      })
      setTracks(page.items)
      setError(null)
    } catch (e) {
      setError(toMessage(e))
    }
  }, [selected, toMessage])

  useEffect(() => {
    void loadTracks()
    return ipcOn('event:media-changed', () => void loadTracks())
  }, [loadTracks])

  useEffect(() => {
    ipcInvoke('queue:get').then(setQueue).catch(() => {})
    return ipcOn('event:queue-changed', setQueue)
  }, [])

  const visibleTracks = useMemo(() => {
    const q = trackQuery.trim().toLowerCase()
    if (!q) return tracks
    return tracks.filter((track) => (track.title ?? track.fileName).toLowerCase().includes(q))
  }, [tracks, trackQuery])

  const totalMs = tracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)

  /**
   * Hand the whole list to the queue and start at one of them.
   *
   * The queue takes a copy: reordering the playlist afterwards must not yank
   * what was going to play next out from under the video that is playing.
   */
  const startQueue = async (at: number): Promise<void> => {
    if (!selected || tracks.length === 0) return
    try {
      await ipcInvoke('queue:start', {
        source: { kind: 'playlist', name: selected },
        items: tracks.map((track) => ({ libraryId: track.libraryId, mediaId: track.id })),
        at
      })
    } catch (e) {
      setError(toMessage(e))
    }
  }

  /**
   * A card let go over a playlist row.
   *
   * Every list takes the card except the one currently open, which gives it
   * back: that is the list you are looking at, so it is the only one you can
   * see the result of pulling something out of. One gesture, and where it lands
   * decides whether it is a plus or a minus.
   */
  const dropOn = async (name: string, targets: MediaDragTarget[]): Promise<void> => {
    try {
      if (name === selected) await ipcInvoke('playlist:remove', { targets, name })
      else await ipcInvoke('playlist:add', { targets, name })
      if (name === selected) await loadTracks()
    } catch (e) {
      setError(toMessage(e))
    }
  }

  /** Take every ticked track out of the open list in one go. */
  const removeTicked = async (): Promise<void> => {
    if (!selected || ticked.size === 0) return
    const targets = tracks
      .filter((track) => ticked.has(track.id))
      .map((track) => ({ libraryId: track.libraryId, mediaId: track.id }))
    try {
      await ipcInvoke('playlist:remove', { targets, name: selected })
      setTicked(new Set())
      await loadTracks()
    } catch (e) {
      setError(toMessage(e))
    }
  }

  /** Pinned lists sort first; the taxonomy's own `order` is what says so. */
  const pinList = async (name: string, pinned: boolean): Promise<void> => {
    try {
      await ipcInvoke('taxonomy:update', {
        kind: 'playlists',
        name,
        patch: { order: pinned ? PIN_ORDER : UNPINNED_ORDER }
      })
    } catch (e) {
      setError(toMessage(e))
    }
  }

  const exportList = async (name: string): Promise<void> => {
    try {
      const done = await ipcInvoke('playlist:exportM3u', { name })
      if (done.path) setNotice(t('playlist.exported', { count: done.tracks }))
    } catch (e) {
      setError(toMessage(e))
    }
  }

  const removeTrack = async (track: MediaListItem): Promise<void> => {
    if (!selected) return
    try {
      await ipcInvoke('playlist:remove', {
        targets: [{ libraryId: track.libraryId, mediaId: track.id }],
        name: selected
      })
      await loadTracks()
    } catch (e) {
      setError(toMessage(e))
    }
  }

  /*
   * Dropping. The renderer names a neighbour rather than an index: by the time
   * the write lands the list may have changed, and "after this track" still
   * means what it said where "position 7" does not.
   */
  const endDrag = async (): Promise<void> => {
    const moving = tracks.find((track) => track.id === dragging)
    setDragging(null)
    const after = dropAfter
    setDropAfter(undefined)
    if (!moving || !selected || after === undefined) return
    try {
      await ipcInvoke('playlist:move', {
        libraryId: moving.libraryId,
        mediaId: moving.id,
        name: selected,
        afterMediaId: after
      })
      await loadTracks()
    } catch (e) {
      setError(toMessage(e))
    }
  }

  const deleteList = async (name: string): Promise<void> => {
    const ok = await askConfirm({
      message: t('playlist.deleteConfirm', { name }),
      confirmLabel: t('playlist.delete'),
      danger: true
    })
    if (!ok) return
    try {
      await ipcInvoke('taxonomy:delete', { kind: 'playlists', name })
      if (selected === name) onSelect(null)
    } catch (e) {
      setError(toMessage(e))
    }
  }

  // Each does its write inside the dialog, so a name that is taken is fixed
  // there rather than lost to an error banner behind it.
  const createList = (): void =>
    void askName({
      title: t('playlist.createPrompt'),
      confirmLabel: t('playlist.create'),
      submit: async (name) => {
        await ipcInvoke('taxonomy:create', { kind: 'playlists', name })
        onSelect(name)
      }
    })

  const renameList = (from: string): void =>
    void askName({
      title: t('playlist.renamePrompt'),
      initial: from,
      confirmLabel: t('playlist.rename'),
      submit: async (name) => {
        if (name === from) return
        await ipcInvoke('taxonomy:update', { kind: 'playlists', name: from, patch: { name } })
        if (selected === from) onSelect(name)
      }
    })

  const duplicateList = (from: string): void =>
    void askName({
      title: t('playlist.duplicatePrompt'),
      initial: t('playlist.copyOf', { name: from }),
      confirmLabel: t('playlist.duplicate'),
      submit: async (name) => {
        const made = await ipcInvoke('playlist:duplicate', { from, to: name })
        onSelect(made.name)
      }
    })

  const menuList = menu ? lists.find((list) => list.name === menu.name) : undefined

  return (
    <div className="panel playlist-panel">
      <div className="panel-head">
        <ListVideo size={15} className="pl-icon" />
        <span className="grow">{t('playlist.title')}</span>
        <button className="icon-btn" title={t('playlist.create')} onClick={createList}>
          <ListPlus size={14} />
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

      {/* ---- every playlist, in a frame that scrolls on its own ---- */}
      <div className={`plbox${folded ? ' folded' : ''}`}>
        <div className="plbox-bar">
          <button
            className="plbox-fold"
            aria-expanded={!folded}
            title={t(folded ? 'playlist.expandLists' : 'playlist.collapseLists')}
            onClick={() => fold(!folded)}
          >
            {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          </button>
          {folded ? (
            <button className="plbox-sum" onClick={() => fold(false)}>
              {t('playlist.listCount', { count: lists.length })}
            </button>
          ) : (
            <>
              <Search size={12} />
              <input
                className="bare"
                value={query}
                placeholder={t('playlist.searchLists')}
                onChange={(e) => setQuery(e.target.value)}
              />
            </>
          )}
        </div>
        <div className="plbox-list" hidden={folded}>
          {shown.length === 0 && <div className="plbox-empty">{t('playlist.none')}</div>}
          {shown.map((list) => (
            <div
              key={list.name}
              className={`plrow${selected === list.name ? ' on' : ''}${dropOnto === list.name ? ' dropping' : ''}${dragOver && selected === list.name ? ' removing' : ''}`}
              onClick={() => onSelect(list.name)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ name: list.name, x: e.clientX, y: e.clientY })
              }}
              /* Cards dragged out of the grid land here — the shortest path
                 there is, which is the point of the panel being on this side. */
              onDragOver={(e) => {
                if (!isMediaDrag(e)) return
                e.preventDefault()
                e.dataTransfer.dropEffect = selected === list.name ? 'move' : 'copy'
                setDropOnto(list.name)
                setDragOver(true)
              }}
              onDragLeave={() => setDropOnto((cur) => (cur === list.name ? null : cur))}
              onDrop={(e) => {
                const targets = readMediaDrag(e)
                setDropOnto(null)
                setDragOver(false)
                if (!targets) return
                e.preventDefault()
                void dropOn(list.name, targets)
              }}
            >
              {dragOver && selected === list.name ? (
                <ListX size={13} className="pl-icon" />
              ) : (
                <ListVideo size={13} className="pl-icon" />
              )}
              <span className="grow" title={list.name}>
                {dragOver && selected === list.name ? t('playlist.dropToRemove') : list.name}
              </span>
              {isPinned(list.order) && <Pin size={11} className="pl-pin" />}
              <span className="n">{list.countWithDescendants}</span>
              <button
                className={`rowmenu${menu?.name === list.name ? ' open' : ''}`}
                aria-label={t('common.more')}
                onClick={(e) => {
                  e.stopPropagation()
                  const box = e.currentTarget.getBoundingClientRect()
                  setMenu(
                    menu?.name === list.name ? null : { name: list.name, x: box.left, y: box.bottom + 4 }
                  )
                }}
              >
                <Ellipsis size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>

      {menu && menuList && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              key: 'rename',
              label: t('playlist.rename'),
              onPick: () => renameList(menuList.name)
            },
            {
              key: 'pin',
              label: t(isPinned(menuList.order) ? 'playlist.unpin' : 'playlist.pin'),
              onPick: () => void pinList(menuList.name, !isPinned(menuList.order))
            },
            {
              key: 'duplicate',
              label: t('playlist.duplicate'),
              onPick: () => duplicateList(menuList.name)
            },
            {
              key: 'export',
              label: t('playlist.exportM3u'),
              onPick: () => void exportList(menuList.name)
            },
            {
              key: 'delete',
              label: t('playlist.delete'),
              danger: true,
              onPick: () => void deleteList(menuList.name)
            }
          ]}
        />
      )}

      {/* ---- the one that is open, and what is in it ---- */}
      {selected === null ? (
        <div className="empty">{t('playlist.pickOne')}</div>
      ) : (
        <div className="pl-cur">
          <div className="cur-head">
            <div className="cur-title">
              <span className="cur-name" title={selected}>
                {selected}
              </span>
            </div>
            <div className="cur-meta">
              {t('playlist.summary', { count: tracks.length, duration: formatSpan(totalMs) })}
            </div>
            <div className="cur-tools">
              <button
                className="ghost sm"
                disabled={tracks.length === 0}
                onClick={() => void startQueue(0)}
              >
                <Play size={12} fill="currentColor" /> {t('playlist.playAll')}
              </button>
              <button
                className={`icon-btn${queue?.shuffle ? ' on' : ''}`}
                title={t('playlist.shuffle')}
                aria-pressed={queue?.shuffle ?? false}
                onClick={() =>
                  void ipcInvoke('queue:setMode', { shuffle: !queue?.shuffle }).catch(() => {})
                }
              >
                <Shuffle size={13} />
              </button>
              <button
                className={`icon-btn${queue?.repeat ? ' on' : ''}`}
                title={t('playlist.repeat')}
                aria-pressed={queue?.repeat ?? false}
                onClick={() =>
                  void ipcInvoke('queue:setMode', { repeat: !queue?.repeat }).catch(() => {})
                }
              >
                <Repeat size={13} />
              </button>
            </div>
            {tracks.length > 8 && (
              <div className="cur-find">
                <Search size={12} />
                <input
                  className="bare"
                  value={trackQuery}
                  placeholder={t('playlist.searchTracks')}
                  onChange={(e) => setTrackQuery(e.target.value)}
                />
              </div>
            )}
          </div>

          <div
            className="cur-list"
            onDragOver={(e) => {
              if (dragging) e.preventDefault()
            }}
          >
            {visibleTracks.length === 0 && <div className="empty">{t('playlist.emptyList')}</div>}
            {visibleTracks.map((track, i) => (
              <div
                key={track.id}
                className={`qrow${track.id === playingId ? ' now' : ''}${dragging === track.id ? ' moving' : ''}${ticked.has(track.id) ? ' ticked' : ''}${dropAfter === (i === 0 ? null : (visibleTracks[i - 1]?.id ?? null)) ? ' droptarget' : ''}`}
                draggable={trackQuery.trim() === ''}
                onDragStart={() => setDragging(track.id)}
                onDragEnd={() => void endDrag()}
                onDragOver={(e) => {
                  if (!dragging) return
                  e.preventDefault()
                  // Above the midpoint drops before this row, below it after.
                  const box = e.currentTarget.getBoundingClientRect()
                  const before = e.clientY < box.top + box.height / 2
                  setDropAfter(
                    before ? (i === 0 ? null : (visibleTracks[i - 1]?.id ?? null)) : track.id
                  )
                }}
                /* Ctrl- or Shift-click ticks rows instead of opening one, so
                   several can leave the list together — clicking ✕ two hundred
                   times is what makes a long list feel like work. */
                onClick={(e) => {
                  if (e.ctrlKey || e.metaKey || e.shiftKey) {
                    setTicked((cur) => {
                      const next = new Set(cur)
                      if (next.has(track.id)) next.delete(track.id)
                      else next.add(track.id)
                      return next
                    })
                    return
                  }
                  onOpen({ libraryId: track.libraryId, mediaId: track.id })
                }}
                /* A track row opens the video; its number plays from here. */
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  void startQueue(tracks.indexOf(track))
                }}
              >
                <span className="qgrip">
                  <GripVertical size={13} />
                </span>
                <span className="qn">
                  {track.id === playingId ? <Play size={10} fill="currentColor" /> : i + 1}
                </span>
                {/* Same row as the queue's, so the two tabs read as one thing. */}
                <button
                  className="qart"
                  aria-label={t('playlist.playFrom')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void startQueue(tracks.indexOf(track))
                  }}
                >
                  <CachedIpcImage
                    className="qart-img"
                    cache={thumbCache}
                    channel="media:getThumbnail"
                    libraryId={track.libraryId}
                    mediaId={track.id}
                  />
                  <span className="qart-play">
                    <Play size={13} fill="currentColor" />
                  </span>
                </button>
                <span className="qtxt">
                  <b title={track.title ?? track.fileName}>{track.title ?? track.fileName}</b>
                  <i>{track.filePath}</i>
                </span>
                <span className="qd">{formatSpan(track.durationMs)}</span>
                <button
                  className="qx"
                  aria-label={t('playlist.removeTrack')}
                  onClick={(e) => {
                    e.stopPropagation()
                    void removeTrack(track)
                  }}
                >
                  <ListX size={12} />
                </button>
              </div>
            ))}
          </div>

          {ticked.size > 0 && (
            <div className="cur-sel">
              <span className="grow">{t('playlist.tickedCount', { count: ticked.size })}</span>
              <button className="ghost sm" onClick={() => setTicked(new Set())}>
                {t('media.batch.clear')}
              </button>
              <button className="ghost sm danger" onClick={() => void removeTicked()}>
                {t('playlist.removeTicked')}
              </button>
            </div>
          )}
        </div>
      )}
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
