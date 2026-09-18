import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, ListMusic, Play, Trash2, X } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { FilterNode } from '@shared/schemas/taxonomy'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { ipcInvoke, ipcOn } from '../ipc'
import { clockDuration, displayTitle } from './format'

/** The most of one playlist the popup lists and plays; a queue longer than this is not one anybody means. */
const MAX_ROWS = 500

interface PlaylistRow {
  name: string
  count: number
}

/** A playlist's videos that can be played: the file is there to play. */
function inPlaylist(name: string): FilterNode {
  return {
    kind: 'group',
    match: 'all',
    children: [
      { kind: 'rule', field: 'playlists', op: 'includes', value: [name] },
      { kind: 'rule', field: 'wanted', op: 'is', value: false },
      { kind: 'rule', field: 'missing', op: 'is', value: false }
    ]
  }
}

/** The playlists, kept current. */
export function usePlaylists(): PlaylistRow[] {
  const [lists, setLists] = useState<PlaylistRow[]>([])
  useEffect(() => {
    const load = (): void => {
      ipcInvoke('taxonomy:get')
        .then((taxonomy) =>
          setLists(taxonomy.entities.playlists.map((row) => ({ name: row.name, count: row.count })))
        )
        .catch(() => {})
    }
    load()
    const offTaxonomy = ipcOn('event:taxonomy-changed', load)
    const offMedia = ipcOn('event:media-changed', load)
    return () => {
      offTaxonomy()
      offMedia()
    }
  }, [])
  return lists
}

/**
 * The playlists, as a card over the panel: pick one on the left, see what is
 * in it on the right, play it from the top or from any of its videos, and
 * tidy it — move up, move down, take out.
 */
export default function VrPlaylists({
  onPlay,
  onClose,
  onError
}: {
  /** Plays the list from `at`; resolves once playback has started. */
  onPlay: (name: string, items: MediaListItem[], at: number) => Promise<void>
  onClose: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const lists = usePlaylists()
  const [open, setOpen] = useState<string | null>(null)
  const [items, setItems] = useState<MediaListItem[] | null>(null)

  // The first list is open to begin with, so the card never starts empty.
  useEffect(() => {
    if (open === null && lists.length > 0) setOpen(lists[0]!.name)
  }, [lists, open])

  const load = useCallback((name: string) => {
    ipcInvoke('media:list', {
      limit: MAX_ROWS,
      filter: inPlaylist(name),
      sort: 'playlist',
      playlistOrder: name
    })
      .then((page) => setItems(page.items))
      .catch(() => setItems([]))
  }, [])

  useEffect(() => {
    if (open === null) return
    setItems(null)
    load(open)
    return ipcOn('event:media-changed', () => load(open))
  }, [open, load])

  const run = (call: Promise<unknown>): void => {
    call.then(() => open && load(open)).catch(onError)
  }

  return (
    <div className="vr-sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vr-sheet-card vr-lists" role="dialog" aria-label={t('playlist.title')}>
        <header className="vr-sheet-head">
          <h2>{t('playlist.title')}</h2>
          <button className="vr-icon-btn" aria-label={t('vr.close')} onClick={onClose}>
            <X size={28} />
          </button>
        </header>

        {lists.length === 0 ? (
          <div className="vr-empty">{t('playlist.none')}</div>
        ) : (
          <div className="vr-lists-body">
            <nav className="vr-lists-names">
              {lists.map((list) => (
                <button
                  key={list.name}
                  className={list.name === open ? 'on' : ''}
                  aria-pressed={list.name === open}
                  onClick={() => setOpen(list.name)}
                >
                  <ListMusic size={24} />
                  <span className="vr-lists-name">{list.name}</span>
                  <span className="vr-lists-count">{list.count}</span>
                </button>
              ))}
            </nav>

            <section className="vr-lists-tracks">
              {open && items && items.length > 0 && (
                <button className="vr-primary-inline" onClick={() => void onPlay(open, items, 0)}>
                  <Play size={26} />
                  {t('playlist.playAll')}
                </button>
              )}
              {items && items.length === 0 && <div className="vr-empty">{t('playlist.emptyList')}</div>}
              {open && items && items.length > 0 && (
                <Virtuoso
                  className="vr-scroll"
                  data={items}
                  increaseViewportBy={{ top: 200, bottom: 400 }}
                  computeItemKey={(_, item) => `${item.libraryId}/${item.id}`}
                  itemContent={(i, item) => (
                    <div className="vr-qrow">
                      <button
                        className="vr-qrow-main"
                        aria-label={t('playlist.playFrom')}
                        onClick={() => void onPlay(open, items, i)}
                      >
                        <span className="vr-qrow-index">{i + 1}</span>
                        <span className="vr-qrow-thumb">
                          <CachedIpcImage
                            className="vr-cover-img"
                            cache={thumbCache}
                            channel="media:getThumbnail"
                            libraryId={item.libraryId}
                            mediaId={item.id}
                          />
                        </span>
                        <span className="vr-qrow-title">{displayTitle(item)}</span>
                        <span className="vr-qrow-time">{clockDuration(item.durationMs)}</span>
                      </button>
                      <div className="vr-qrow-tools">
                        <button
                          aria-label={t('vr.moveUp')}
                          disabled={i === 0}
                          onClick={() =>
                            run(
                              ipcInvoke('playlist:move', {
                                libraryId: item.libraryId,
                                mediaId: item.id,
                                name: open,
                                afterMediaId: i >= 2 ? items[i - 2]!.id : null
                              })
                            )
                          }
                        >
                          <ArrowUp size={26} />
                        </button>
                        <button
                          aria-label={t('vr.moveDown')}
                          disabled={i === items.length - 1}
                          onClick={() =>
                            run(
                              ipcInvoke('playlist:move', {
                                libraryId: item.libraryId,
                                mediaId: item.id,
                                name: open,
                                afterMediaId: items[i + 1]!.id
                              })
                            )
                          }
                        >
                          <ArrowDown size={26} />
                        </button>
                        <button
                          aria-label={t('playlist.removeTrack')}
                          onClick={() =>
                            run(
                              ipcInvoke('playlist:remove', {
                                targets: [{ libraryId: item.libraryId, mediaId: item.id }],
                                name: open
                              })
                            )
                          }
                        >
                          <Trash2 size={26} />
                        </button>
                      </div>
                    </div>
                  )}
                />
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

/** Picks a playlist to put one video in. */
export function VrAddToPlaylist({
  item,
  onDone,
  onClose,
  onError
}: {
  item: MediaListItem
  onDone: (name: string) => void
  onClose: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const lists = usePlaylists()

  const add = (name: string): void => {
    ipcInvoke('playlist:add', { targets: [{ libraryId: item.libraryId, mediaId: item.id }], name })
      .then((result) => onDone(result.name))
      .catch(onError)
  }

  return (
    <div className="vr-sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vr-sheet-card vr-addto" role="dialog" aria-label={t('playlist.addTo')}>
        <header className="vr-sheet-head">
          <h2>{t('playlist.addTo')}</h2>
          <button className="vr-icon-btn" aria-label={t('vr.close')} onClick={onClose}>
            <X size={28} />
          </button>
        </header>
        <p className="vr-addto-title">{displayTitle(item)}</p>
        {lists.length === 0 ? (
          <div className="vr-empty">{t('playlist.none')}</div>
        ) : (
          <nav className="vr-lists-names">
            {lists.map((list) => (
              <button key={list.name} onClick={() => add(list.name)}>
                <ListMusic size={24} />
                <span className="vr-lists-name">{list.name}</span>
                <span className="vr-lists-count">{list.count}</span>
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  )
}
