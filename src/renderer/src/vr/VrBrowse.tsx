import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { VirtuosoGrid } from 'react-virtuoso'
import type { VR_SORTS } from '@shared/schemas/app-config'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { FilterNode } from '@shared/schemas/taxonomy'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { ipcInvoke, ipcOn } from '../ipc'
import { clockDuration, displayTitle } from './format'

/** Rows fetched per request; a laser scrolls a few screens at a time at most. */
const PAGE = 60

/** A library change comes as a burst of events; the grid answers the burst once. */
const CHANGED_DEBOUNCE_MS = 400

/**
 * What the grid holds: only videos that can be played. Every picked tag must
 * be present, tags counting their children, as the desktop sidebar does; with
 * `favorites`, only the favourites.
 */
function browseFilter(tags: string[], favorites: boolean): FilterNode {
  return {
    kind: 'group',
    match: 'all',
    children: [
      { kind: 'rule', field: 'wanted', op: 'is', value: false },
      { kind: 'rule', field: 'missing', op: 'is', value: false },
      ...(favorites ? [{ kind: 'rule' as const, field: 'favorite' as const, op: 'is' as const, value: true }] : []),
      ...tags.map((name) => ({
        kind: 'rule' as const,
        field: 'tags' as const,
        op: 'includes' as const,
        value: [name],
        includeDescendants: true
      }))
    ]
  }
}

export default function VrBrowse({
  search,
  tags,
  favorites,
  sort,
  selectedId,
  onOpen
}: {
  search: string
  tags: string[]
  favorites: boolean
  sort: (typeof VR_SORTS)[number]
  /** The one open in the column beside the grid. */
  selectedId: string | null
  onOpen: (item: MediaListItem) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [items, setItems] = useState<MediaListItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  // Answers to an older query arrive late; only the newest one may land.
  const generation = useRef(0)
  const loading = useRef(false)
  const loaded = useRef(0)

  const query = useCallback(
    (offset: number) =>
      ipcInvoke('media:list', {
        offset,
        limit: PAGE,
        ...(search ? { search } : {}),
        filter: browseFilter(tags, favorites),
        sort
      }),
    [search, tags, favorites, sort]
  )

  // A new search or tag starts again from the top.
  useEffect(() => {
    const mine = ++generation.current
    loading.current = true
    query(0)
      .then((page) => {
        if (mine !== generation.current) return
        loaded.current = page.items.length
        setItems(page.items)
        setTotal(page.total)
      })
      .catch(() => {})
      .finally(() => {
        if (mine === generation.current) loading.current = false
      })
  }, [query])

  /*
   * A change in the library reads again everything already loaded, rather
   * than starting over from the first page: starting over drops the rows
   * under the viewer, and the list jumps back to wherever the first page ends.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = async (): Promise<void> => {
      const mine = ++generation.current
      loading.current = true
      try {
        const wanted = Math.max(PAGE, loaded.current)
        const rows: MediaListItem[] = []
        let count = 0
        for (let offset = 0; offset < wanted; offset += PAGE) {
          const page = await query(offset)
          if (mine !== generation.current) return
          count = page.total
          rows.push(...page.items)
          if (page.items.length < PAGE) break
        }
        loaded.current = rows.length
        setItems(rows)
        setTotal(count)
      } catch {
        // The rows on screen stay; they are only out of date.
      } finally {
        if (mine === generation.current) loading.current = false
      }
    }
    const off = ipcOn('event:media-changed', () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void refresh()
      }, CHANGED_DEBOUNCE_MS)
    })
    return () => {
      if (timer) clearTimeout(timer)
      off()
    }
  }, [query])

  const more = (): void => {
    if (loading.current || total === null || items.length >= total) return
    const mine = generation.current
    loading.current = true
    query(items.length)
      .then((page) => {
        if (mine !== generation.current) return
        loaded.current += page.items.length
        setItems((current) => [...current, ...page.items])
        setTotal(page.total)
      })
      .catch(() => {})
      .finally(() => {
        if (mine === generation.current) loading.current = false
      })
  }

  if (total === 0) {
    return <div className="vr-empty">{t(search || tags.length || favorites ? 'vr.noMatches' : 'vr.emptyLibrary')}</div>
  }

  return (
    <VirtuosoGrid
      className="vr-scroll"
      listClassName="vr-grid"
      data={items}
      endReached={more}
      // A screenful mounted past the fold, so the last row is already there
      // before it is needed instead of flipping in and out as it nears.
      increaseViewportBy={{ top: 200, bottom: 600 }}
      computeItemKey={(_, item) => `${item.libraryId}/${item.id}`}
      itemContent={(_, item) => (
        <button className={`vr-card${item.id === selectedId ? ' on' : ''}`} onClick={() => onOpen(item)}>
          <div className="vr-cover">
            <CachedIpcImage
              className="vr-cover-img"
              cache={thumbCache}
              channel="media:getThumbnail"
              libraryId={item.libraryId}
              mediaId={item.id}
            />
            {clockDuration(item.durationMs) && <span className="vr-badge">{clockDuration(item.durationMs)}</span>}
          </div>
          <span className="vr-card-title">{displayTitle(item)}</span>
        </button>
      )}
    />
  )
}
