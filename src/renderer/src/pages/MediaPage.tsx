import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Check, Heart, ListVideo } from 'lucide-react'
import { memo } from 'react'
import { Virtuoso, VirtuosoGrid } from 'react-virtuoso'
import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import type { MediaListItem, SyncProgress } from '@shared/schemas/media-index'
import type { NameField } from '@shared/schemas/media-meta'
import { folderRef, parseFolderRef, type FilterNode } from '@shared/schemas/taxonomy'
import type { MediaSelection } from '../App'
import Select from '../components/Select'
import FilterSidebar from '../components/FilterSidebar'
import ConditionBuilder from '../components/ConditionBuilder'
import BatchPanel, { type BatchEditPayload } from '../components/BatchPanel'
import DeleteMediaDialog from '../components/DeleteMediaDialog'
import MergeWantedDialog from '../components/MergeWantedDialog'
import LayerStack, { dismissesLayer } from '../components/LayerStack'
import NameSearchPanel from '../components/NameSearchPanel'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import MediaDetailPage from './MediaDetailPage'
import type { Taxonomy } from '../components/NameChips'
import {
  applyNamePick,
  describePills,
  emptySidebar,
  isEmptySidebar,
  keepFoldersIn,
  namePickFromEvent,
  removePill,
  soloFolder,
  toFilterNode,
  type NamePick,
  type SidebarState
} from '../filters'
import { folderRows, type FolderCount } from '../folders'
import { askName } from '../dialogs'
import { ipcInvoke, ipcOn } from '../ipc'
import { isPreviewable, mediaPreviewUrl } from '../mediaUrl'
import CachedIpcImage, { clearImageCaches, heatmapCache, thumbCache } from '../ipcImage'
import { setMediaDrag, type MediaDragTarget } from '../mediaDrag'
import { closeFrontSurface, raiseSurface } from '../surfaces'
import { showToast } from '../toasts'
import { useErrorMessage } from '../useErrorMessage'
import { usePopover } from '../usePopover'

const PAGE_SIZE = 200

/**
 * The flags that say which shelf you are looking at, rather than what is true
 * of a file. They ride the top bar as chips; the sidebar keeps the ones that
 * really are properties of the scripts.
 */
const VIEW_FLAGS = ['favorite', 'wanted', 'noScript'] as const

/**
 * Virtuoso measures each row's own box, and a margin is not part of it — the
 * space between rows has to be padding on the wrapper Virtuoso itself renders,
 * or every row is accounted a few pixels short and the scroll position drifts.
 * Defined out here so its identity never changes and rows are not remounted.
 */
const ListRow = (props: React.ComponentPropsWithoutRef<'div'>): React.JSX.Element => (
  <div {...props} className="media-list-row" />
)

/** Slowest the progress bar is allowed to move; a scan reports per file. */
const PROGRESS_INTERVAL_MS = 250

/** How long index changes are collected before the list is re-read. */
const CHANGED_DEBOUNCE_MS = 400

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

type MediaView = 'grid' | 'list'

/** Sort orders the grid offers; mirrors MediaSort on the index side. */
type MediaSort = Settings['ui']['mediaSort']
  /** Only offered while the grid is narrowed to exactly one playlist. */
  | 'playlist'

export default function MediaPage({
  sidebar,
  onSidebarChange,
  onPickName,
  detailRequest,
  onDetailChange,
  drawerOpen,
  onToggleDrawer
}: {
  /** Owned by App so it survives a trip to another tab. */
  sidebar: SidebarState
  onSidebarChange: React.Dispatch<React.SetStateAction<SidebarState>>
  /** A name clicked anywhere picks the same filter as its sidebar row. */
  onPickName: (field: NameField, name: string, pick: NamePick) => void
  /**
   * A video asked for from outside this page — a queue row, the artwork on the
   * bar. The nonce is what makes asking for the same one twice arrive twice.
   */
  detailRequest: { selection: MediaSelection | null; nonce: number } | null
  /** What the detail panel is showing, so the bar's artwork can toggle it. */
  onDetailChange: (selection: MediaSelection | null) => void
  /** The playback drawer, which is App's; the toolbar button only toggles it. */
  drawerOpen: boolean
  onToggleDrawer: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // Icon grid vs detailed list; persisted so it survives restarts and the
  // choice is the same whether or not the detail panel is open.
  const [viewMode, setViewMode] = useState<MediaView>('grid')
  const toMessage = useErrorMessage()
  const [libraries, setLibraries] = useState<RegisteredLibrary[]>([])
  /** Avoid querying once with defaults before the persisted view is restored. */
  const [preferencesReady, setPreferencesReady] = useState(false)
  /** null = all libraries (the default view); a specific id filters to one. */
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const [items, setItems] = useState<MediaListItem[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** What the last action actually did — dismissed by the next one. */
  const [notice, setNotice] = useState<string | null>(null)
  // Bumped on media-changed so mounted heatmap strips refetch (scripts may
  // have changed on disk; the main process re-validates against mtime).
  const [heatmapEpoch, setHeatmapEpoch] = useState(0)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const setSidebar = onSidebarChange
  /** What the condition builder produced; ANDed with the sidebar. */
  const [advanced, setAdvanced] = useState<FilterNode | null>(null)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [builderPreview, setBuilderPreview] = useState<number | null>(null)
  const [sort, setSort] = useState<MediaSort>('path')
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null)
  /** The libraries' folder trees, and which list the sidebar is showing. */
  const [folderCounts, setFolderCounts] = useState<FolderCount[]>([])
  const [listKind, setListKind] = useState<NameField | 'folder'>('tags')
  /**
   * Selected media, as id → the library it lives in. Empty = the panel on the
   * right is the detail view.
   *
   * A map rather than a set of ids because a selection has to be able to name
   * its targets without the rows being loaded: "select all" matches the whole
   * filter, which is routinely more than the pages fetched so far.
   */
  const [selected, setSelected] = useState<Map<string, string>>(() => new Map())
  const [batchBusy, setBatchBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** Entries the context menu asked to take out of the library. */
  const [removing, setRemoving] = useState<{ libraryId: string; mediaId: string }[] | null>(null)
  const [merging, setMerging] = useState(false)

  /*
   * The right-hand layers. Three of them can be open at once and they stack
   * rather than evict each other: opening a video to check something must not
   * throw away the playlist being ordered underneath it. See LayerStack.
   */
  const [detail, setDetail] = useState<MediaSelection | null>(null)
  /** The right-click menu on a card: where it opened, and what it acts on. */
  const [menu, setMenu] = useState<{
    x: number
    y: number
    targets: MediaDragTarget[]
    /** The card under the pointer — where "play everything here" starts. */
    at: MediaDragTarget
    /** The folder that card sits in, for the jump to the rest of it. */
    folder: string
  } | null>(
    null
  )
  /** The cross-kind name search; null = shut, a string = open with that query. */
  const [nameSearch, setNameSearch] = useState<string | null>(null)

  /**
   * The single playlist the grid is narrowed to, if it is narrowed to one.
   *
   * Its own order only means something here: two playlists at once have two
   * orders and no way to reconcile them, and none at all has nothing to order
   * by. So this is what gates both the sort option and the track numbers.
   */
  const orderedPlaylist = useMemo(() => {
    const picked = sidebar.names.playlists.include
    return picked.length === 1 ? picked[0]! : null
  }, [sidebar])

  const folders = useMemo(() => folderRows(folderCounts, libraries), [folderCounts, libraries])

  /** A folder as the pill row names it: its path, or the library it is the root of. */
  const folderLabel = useCallback(
    (ref: string): string => {
      const known = folders.find((row) => row.ref === ref)
      if (known) return known.fullPath
      // A pick can outlive the folder it named — the files moved, or the
      // library was closed. The path still says which one it was.
      const parsed = parseFolderRef(ref)
      if (!parsed) return ref
      const library = libraries.find((l) => l.id === parsed.libraryId)
      return parsed.path === '' ? (library?.name ?? ref) : parsed.path
    },
    [folders, libraries]
  )

  const filter = useMemo(() => toFilterNode(sidebar, advanced), [sidebar, advanced])
  const pills = useMemo(
    () => describePills(sidebar, advanced, (k, p) => t(k, p ?? {}), folderLabel),
    [sidebar, advanced, t, folderLabel]
  )

  // Latest query state for callbacks without re-subscribing effects.
  const queryRef = useRef({
    libraryId: null as string | null,
    search: '',
    filter: null as FilterNode | null,
    sort: 'path' as MediaSort,
    playlistOrder: null as string | null
  })
  queryRef.current = { libraryId, search, filter, sort, playlistOrder: orderedPlaylist }

  /** How many rows are loaded, for callbacks that must not re-subscribe. */
  const loadedRef = useRef(0)

  const fetchPage = useCallback(async (offset: number, limit: number) => {
    const { libraryId: lib, search: q, filter: f, sort: order, playlistOrder } = queryRef.current
    return ipcInvoke('media:list', {
      offset,
      limit,
      sort: order,
      ...(order === 'playlist' && playlistOrder ? { playlistOrder } : {}),
      ...(lib ? { libraryId: lib } : {}),
      ...(q ? { search: q } : {}),
      ...(f ? { filter: f } : {})
    })
  }, [])

  const loadPage = useCallback(
    async (offset: number): Promise<void> => {
      try {
        const page = await fetchPage(offset, PAGE_SIZE)
        setTotal(page.total)
        setItems((prev) => {
          const next = offset === 0 ? page.items : [...prev, ...page.items]
          loadedRef.current = next.length
          return next
        })
        setLoadError(null)
      } catch (e) {
        setLoadError(toMessage(e))
      }
    },
    [fetchPage, toMessage]
  )

  /**
   * Re-read what is already on screen, rather than starting over.
   *
   * The index changing is not a reason to throw away the user's place in the
   * list. Reloading from offset 0 cut the rows back to one page, which put the
   * scroll position past the end; the list snapped up, `endReached` fired at
   * once, the page came back, and it snapped down again — a loop that ran every
   * time a sync finished or a heart was clicked.
   */
  const refreshLoaded = useCallback(async (): Promise<void> => {
    const wanted = Math.max(PAGE_SIZE, loadedRef.current)
    try {
      const pages: MediaListItem[] = []
      let total = 0
      for (let offset = 0; offset < wanted; offset += PAGE_SIZE) {
        const page = await fetchPage(offset, PAGE_SIZE)
        total = page.total
        pages.push(...page.items)
        if (page.items.length < PAGE_SIZE) break
      }
      setTotal(total)
      loadedRef.current = pages.length
      setItems(pages)
      setLoadError(null)
    } catch (e) {
      setLoadError(toMessage(e))
    }
  }, [fetchPage, toMessage])

  // Restore the whole media view together. In particular, do not query once
  // with defaults and then visibly replace it when these local IPC calls land.
  useEffect(() => {
    let mounted = true
    void Promise.all([ipcInvoke('library:list'), ipcInvoke('settings:get')])
      .then(([libs, settings]) => {
        if (!mounted) return
        setLibraries(libs)
        setViewMode(settings.ui.mediaView)
        setLibraryId(
          settings.ui.mediaLibraryId && libs.some((library) => library.id === settings.ui.mediaLibraryId)
            ? settings.ui.mediaLibraryId
            : null
        )
        setSort(settings.ui.mediaSort)
      })
      .catch(console.error)
      .finally(() => {
        if (mounted) setPreferencesReady(true)
      })
    const offLibraries = ipcOn('event:libraries-changed', ({ libraries: libs }) => {
      setLibraries(libs)
      setLibraryId((cur) => (cur && libs.some((l) => l.id === cur) ? cur : null))
    })
    return () => {
      mounted = false
      offLibraries()
    }
  }, [])

  const setView = (mode: MediaView): void => {
    setViewMode(mode)
    void ipcInvoke('settings:update', { ui: { mediaView: mode } }).catch(console.error)
  }

  const setMediaLibrary = (value: string): void => {
    setLibraryId(value || null)
    // Folders belong to a library, and the list below is about to stop showing
    // the other libraries' ones.
    if (value) setSidebar((cur) => keepFoldersIn(cur, value))
    void ipcInvoke('settings:update', { ui: { mediaLibraryId: value } }).catch(console.error)
  }

  const setMediaSort = useCallback((next: MediaSort): void => {
    setSort(next)
    // Playlist order cannot be restored without the playlist filter, which is
    // deliberately session state. Keep the last generally valid order instead.
    if (next !== 'playlist') {
      void ipcInvoke('settings:update', { ui: { mediaSort: next } }).catch(console.error)
    }
  }, [])

  // Dropping the playlist filter takes its order with it — leaving the grid
  // sorted by a list it is no longer showing would order it by nothing.
  useEffect(() => {
    if (sort === 'playlist' && orderedPlaylist === null) setMediaSort('path')
  }, [sort, orderedPlaylist, setMediaSort])

  // Reload on filter/search change (debounced for typing).
  useEffect(() => {
    if (!preferencesReady) return
    const timer = setTimeout(() => void loadPage(0), search ? 250 : 0)
    return () => clearTimeout(timer)
  }, [preferencesReady, libraryId, search, filter, sort, orderedPlaylist, loadPage])

  // The vocabulary the sidebar and the chip pickers draw from.
  useEffect(() => {
    const load = (): void => {
      ipcInvoke('taxonomy:get').then(setTaxonomy).catch(() => setTaxonomy(null))
    }
    load()
    const offTaxonomy = ipcOn('event:taxonomy-changed', load)
    const offMedia = ipcOn('event:media-changed', load)
    return () => {
      offTaxonomy()
      offMedia()
    }
  }, [])

  /*
   * The folders behind the sidebar's folder list. Scoped to the library on
   * screen, so picking one in the header takes its name off the top of the
   * tree; a scan moves files about, so this follows the index rather than
   * being read once.
   */
  useEffect(() => {
    const load = (): void => {
      ipcInvoke('library:folders', libraryId ? { libraryId } : {})
        .then(({ folders: rows }) => setFolderCounts(rows))
        .catch(() => setFolderCounts([]))
    }
    load()
    const offMedia = ipcOn('event:media-changed', load)
    return offMedia
  }, [libraryId])

  /*
   * A selection is a statement about a result set, so it ends when the result
   * set does. It used to be pruned to the loaded rows instead, which quietly
   * cut "select all 1400" back to the 200 that happened to be fetched — the
   * count in the bar said 1400 and the edit reached 200.
   */
  useEffect(() => {
    setSelected((cur) => (cur.size === 0 ? cur : new Map()))
  }, [libraryId, search, filter, sort])

  // The card callbacks are memoised so a card only re-renders when something
  // about that card changed — see the memo on MediaCard itself.
  const toggleSelected = useCallback((item: MediaListItem): void => {
    setSelected((cur) => {
      const next = new Map(cur)
      if (next.has(item.id)) next.delete(item.id)
      else next.set(item.id, item.libraryId)
      return next
    })
  }, [])

  /**
   * Opening a video has to bring its panel forward, not only the first time.
   * Mounting raises the layer on its own, but the panel stays mounted while
   * you move from video to video — so with the detail panel already open and
   * behind something, picking another card would swap the contents of a panel
   * you cannot see.
   */
  const openDetail = useCallback((selection: MediaSelection): void => {
    setDetail(selection)
    raiseSurface('detail')
  }, [])

  /**
   * Close the front-most of this page's own panels.
   *
   * Which one that is depends on what the user touched last, not on a fixed
   * order — and the drawer is left out of it: it is a tool the user put there,
   * not something that happened to be in the way of a click on the grid.
   */
  const dismissTopLayer = useCallback((): void => {
    closeFrontSurface((id) => id !== 'drawer')
  }, [])

  // A video asked for from the queue or the now-playing bar — or, with a null
  // selection, the same button asking for the panel to go away again.
  useEffect(() => {
    if (!detailRequest) return
    setDetail(detailRequest.selection)
    if (detailRequest.selection) raiseSurface('detail')
  }, [detailRequest])

  // Tell App what is open, so a second press on the artwork can put it away.
  useEffect(() => {
    onDetailChange(detail)
  }, [detail, onDetailChange])

  // Ctrl+K opens the cross-kind name search wherever the focus happens to be.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'k' || !(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setNameSearch((cur) => (cur === null ? '' : null))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * One click from the grid. The row is updated from what came back rather
   * than assumed, so a write that failed leaves the heart where it was.
   */
  const toggleFavorite = useCallback(
    async (item: MediaListItem): Promise<void> => {
      try {
        const updated = await ipcInvoke('media:setUserMeta', {
          libraryId: item.libraryId,
          mediaId: item.id,
          favorite: !item.favorite
        })
        setItems((cur) =>
          cur.map((i) => (i.id === item.id ? { ...i, favorite: updated.favorite } : i))
        )
      } catch (e) {
        showToast({ message: toMessage(e) })
      }
    },
    [toMessage]
  )

  /**
   * What dragging this card is about. A ticked card drags the whole selection:
   * the tick already says what the next action applies to, and having this one
   * action ignore it would be a surprise.
   */
  const dragTargets = useCallback(
    (item: MediaListItem): MediaDragTarget[] =>
      selected.has(item.id)
        ? [...selected].map(([mediaId, libraryId]) => ({ libraryId, mediaId }))
        : [{ libraryId: item.libraryId, mediaId: item.id }],
    [selected]
  )

  /*
   * Sending media to the queue. The right-click menu and the selection bar
   * both do it, so the calls live here rather than in either of them.
   */

  const playNow = useCallback(
    async (targets: MediaDragTarget[]): Promise<void> => {
      if (targets.length === 0) return
      try {
        if (targets.length === 1) {
          // One card joins the queue and plays, right after whatever was
          // playing — pick four out of the library and the queue is those four.
          await ipcInvoke('playback:play', targets[0]!)
        } else {
          // Several at once is a statement about the whole set, so it becomes
          // the queue rather than being threaded into the middle of one.
          await ipcInvoke('queue:start', {
            source: { kind: 'custom' },
            items: targets,
            at: 0
          })
        }
      } catch (e) {
        showToast({ message: toMessage(e) })
      }
    },
    [toMessage]
  )

  /**
   * Take the whole result as the queue, starting at one card.
   *
   * The page used to do this by itself, on every play, and it was wrong more
   * often than right: someone playing one video out of eighteen hundred did
   * not mean "and then the other 1799 in file order". So it is a menu item —
   * the one gesture where the user has said the view is the list they meant.
   */
  const playView = useCallback(
    async (at: MediaDragTarget): Promise<void> => {
      const { libraryId: lib, search: q, filter: f, sort: order, playlistOrder } = queryRef.current
      try {
        const view = await ipcInvoke('media:viewTargets', {
          ...(lib ? { libraryId: lib } : {}),
          ...(q ? { search: q } : {}),
          ...(f ? { filter: f } : {}),
          ...(order ? { sort: order } : {}),
          ...(order === 'playlist' && playlistOrder ? { playlistOrder } : {})
        })
        const index = view.targets.findIndex((target) => target.mediaId === at.mediaId)
        if (view.targets.length === 0) return
        await ipcInvoke('queue:start', {
          source: { kind: 'view' },
          items: view.targets,
          // The card is past the cap: play it, and let the queue be the rest.
          at: index < 0 ? 0 : index
        })
        if (view.capped) setNotice(t('queue.capped', { count: view.targets.length }))
      } catch (e) {
        showToast({ message: toMessage(e) })
      }
    },
    [t, toMessage]
  )

  /**
   * Double-click plays.
   *
   * The first click of the pair has already opened the detail panel, which is
   * not what someone double-clicking a card is asking for — so it closes again.
   * Single click still opens it, the way it always has.
   */
  const playCard = useCallback(
    (item: MediaListItem): void => {
      setDetail(null)
      void playNow([{ libraryId: item.libraryId, mediaId: item.id }])
    },
    [playNow]
  )

  const enqueue = useCallback(
    async (targets: MediaDragTarget[], mode: 'next' | 'end'): Promise<void> => {
      if (targets.length === 0) return
      try {
        const state = await ipcInvoke('queue:add', { items: targets, mode })
        setNotice(t('queue.added', { count: targets.length, total: state.items.length }))
      } catch (e) {
        showToast({ message: toMessage(e) })
      }
    },
    [t, toMessage]
  )

  const addToPlaylist = useCallback(
    async (targets: MediaDragTarget[], name: string): Promise<void> => {
      if (targets.length === 0) return
      try {
        const done = await ipcInvoke('playlist:add', { targets, name })
        setNotice(t('playlist.added', { count: done.added, name: done.name }))
      } catch (e) {
        showToast({ message: toMessage(e) })
      }
    },
    [t, toMessage]
  )

  /* The card callbacks must keep their identity or every card re-renders on
     every selection change; the latest targets are read through a ref. */
  const dragTargetsRef = useRef(dragTargets)
  dragTargetsRef.current = dragTargets

  /** A tag on a card picks the same filter as its row in the sidebar. */
  const pickTag = useCallback(
    (name: string, pick: NamePick): void =>
      setSidebar((current) => applyNamePick(current, 'tags', name, pick)),
    [setSidebar]
  )

  /** Which tags the filter is already holding, so the cards can say so. */
  const pickedTags = useMemo(
    () => ({
      include: new Set(sidebar.names.tags.include.map((n) => n.toLowerCase())),
      exclude: new Set(sidebar.names.tags.exclude.map((n) => n.toLowerCase()))
    }),
    [sidebar]
  )

  /**
   * Right-clicking a card. A ticked card opens the menu for the whole
   * selection, the same rule dragging one follows: the tick is already a
   * statement about what the next action applies to.
   */
  const openMenu = useCallback((e: React.MouseEvent, item: MediaListItem): void => {
    e.preventDefault()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      targets: dragTargetsRef.current(item),
      at: { libraryId: item.libraryId, mediaId: item.id },
      folder: folderRef(item.libraryId, item.filePath.slice(0, Math.max(0, item.filePath.lastIndexOf('/'))))
    })
  }, [])

  const menuItems = useMemo<MenuItem[]>(() => {
    const targets = menu?.targets ?? []
    const count = targets.length
    const lists = taxonomy?.entities.playlists ?? []
    return [
      {
        key: 'play',
        label: count > 1 ? t('media.menu.playCount', { count }) : t('media.menu.play'),
        onPick: () => void playNow(targets)
      },
      {
        key: 'view',
        label: t('media.menu.playView'),
        onPick: () => menu && void playView(menu.at)
      },
      { key: 'next', label: t('media.menu.playNext'), onPick: () => void enqueue(targets, 'next') },
      { key: 'end', label: t('media.menu.addToQueue'), onPick: () => void enqueue(targets, 'end') },
      {
        key: 'playlist',
        label: t('playlist.addTo'),
        searchable: true,
        children: [
          {
            key: 'new',
            label: t('media.menu.newPlaylist'),
            onPick: () =>
              void askName({
                title: t('playlist.createPrompt'),
                confirmLabel: t('playlist.create')
              }).then((name) => {
                if (name) void addToPlaylist(targets, name)
              })
          },
          ...lists.map((list) => ({
            key: list.name,
            label: list.name,
            hint: String(list.countWithDescendants),
            onPick: () => void addToPlaylist(targets, list.name)
          }))
        ]
      },
      {
        /* The card under the pointer, not the selection: this is about where
           one file sits, which several of them need not agree on. */
        key: 'folder',
        label: t('media.menu.onlyThisFolder'),
        onPick: () => {
          if (!menu) return
          setSidebar((cur) => soloFolder(cur, menu.folder))
          setListKind('folder')
        }
      },
      {
        key: 'open',
        label: t('media.menu.openDetail'),
        disabled: count !== 1,
        onPick: () => targets[0] && openDetail(targets[0])
      },
      {
        // Last, and only ever the gentle one: deleting files stays behind the
        // dialog's own choice, never one misplaced click in a menu.
        key: 'remove',
        label: t('media.menu.removeFromLibrary'),
        onPick: () => setRemoving(targets)
      }
    ]
  }, [menu, taxonomy, t, playNow, playView, enqueue, addToPlaylist, openDetail, setSidebar])

  /** Every selected media, loaded or not — what an edit is applied to. */
  const selectedTargets = useMemo(
    () => [...selected].map(([mediaId, libraryId]) => ({ libraryId, mediaId })),
    [selected]
  )

  /** The subset whose rows are loaded — all the batch panel can describe. */
  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected])

  /**
   * A selection the merge can act on: two or more rows of one library, at least
   * one still waiting for its file and at most one that has one. Two real files
   * is not a merge — one of them would be orphaned — and a selection reaching
   * past the loaded pages cannot be described, so neither is offered.
   */
  const mergeRows = useMemo(() => {
    if (selected.size < 2 || selectedItems.length !== selected.size) return null
    const libraryId = selectedItems[0]!.libraryId
    if (selectedItems.some((i) => i.libraryId !== libraryId)) return null
    const waiting = selectedItems.filter((i) => i.wanted).length
    if (waiting === 0 || selectedItems.length - waiting > 1) return null
    return {
      libraryId,
      rows: selectedItems.map((i) => ({
        mediaId: i.id,
        name: i.title || i.fileName,
        path: i.filePath,
        wanted: i.wanted
      }))
    }
  }, [selected, selectedItems])

  /*
   * The list's own props, kept stable. They used to be rebuilt on every render
   * of the page, which meant every progress tick during a scan re-rendered
   * every mounted card — pictures and all — while the user was scrolling.
   */
  const itemKey = useCallback((index: number) => items[index]?.id ?? index, [items])

  const onEndReached = useCallback(() => {
    if (loadedRef.current < total) void loadPage(loadedRef.current)
  }, [total, loadPage])

  const renderItem = useCallback(
    (index: number) => {
      const item = items[index]
      return item ? (
        <MediaCard
          item={item}
          heatmapEpoch={heatmapEpoch}
          playing={item.id === playingId}
          active={item.id === detail?.mediaId}
          list={viewMode === 'list'}
          selected={selected.has(item.id)}
          onToggleSelected={toggleSelected}
          onToggleFavorite={toggleFavorite}
          onOpen={openDetail}
          pickedTags={pickedTags}
          onPickTag={pickTag}
          onDragTargets={dragTargets}
          onContextMenu={openMenu}
          onPlay={playCard}
          // Only while the grid *is* the playlist, in its order — a number
          // beside a card sorted by size would mean nothing.
          ordinal={sort === 'playlist' ? index + 1 : null}
        />
      ) : null
    },
    [
      items,
      heatmapEpoch,
      playingId,
      detail?.mediaId,
      viewMode,
      selected,
      toggleSelected,
      toggleFavorite,
      openDetail,
      pickedTags,
      pickTag,
      dragTargets,
      openMenu,
      playCard
    ]
  )

  // `picking` moved off the item container so it can sit on the scroller,
  // which both list shapes share.
  const scrollerClass = `media-grid-scroller${selected.size > 0 ? ' picking' : ''}`

  const applyBatch = async (edit: BatchEditPayload): Promise<void> => {
    setBatchBusy(true)
    try {
      await ipcInvoke('media:batchEdit', { targets: selectedTargets, edit })
      await refreshLoaded()
      setSelected(new Map())
    } catch (e) {
      showToast({ message: toMessage(e) })
    } finally {
      setBatchBusy(false)
    }
  }

  /**
   * One forum post, folded into everything selected. The post is read once —
   * the forum is asked at a request a second, so per-media fetches would make
   * a selection of ten take ten seconds for no reason.
   */
  const applyPostLink = async (url: string): Promise<void> => {
    setBatchBusy(true)
    setNotice(null)
    try {
      const result = await ipcInvoke('media:applyPostLink', {
        targets: selectedTargets,
        postUrl: url
      })
      await refreshLoaded()
      setNotice(
        t('media.batch.fromPostDone', {
          title: result.postTitle,
          count: result.applied,
          tags: result.tagsAdded.length
        })
      )
    } catch (e) {
      showToast({ message: toMessage(e) })
    } finally {
      setBatchBusy(false)
    }
  }

  /**
   * Everything the current filter matches, not just the loaded page. The
   * targets come back with their library on them, so nothing has to be fetched
   * into the list for the selection to be complete.
   */
  const selectAll = async (): Promise<void> => {
    try {
      const { targets } = await ipcInvoke('media:matchingIds', {
        ...(libraryId ? { libraryId } : {}),
        ...(search ? { search } : {}),
        ...(filter ? { filter } : {})
      })
      setSelected(new Map(targets.map((target) => [target.mediaId, target.libraryId])))
    } catch (e) {
      showToast({ message: toMessage(e) })
    }
  }

  const saveFilter = (node: FilterNode): void =>
    void askName({
      title: t('media.filter.savePrompt'),
      confirmLabel: t('media.filter.save'),
      submit: async (name) => {
        await ipcInvoke('taxonomy:saveFilter', { name, filter: node })
      }
    })

  // The builder shows how many its current draft would match, before applying.
  const previewFilter = (draft: FilterNode | null): void => {
    const combined = toFilterNode(sidebar, draft)
    setBuilderPreview(null)
    ipcInvoke('media:matchingIds', {
      ...(libraryId ? { libraryId } : {}),
      ...(search ? { search } : {}),
      ...(combined ? { filter: combined } : {})
    })
      .then(({ targets }) => setBuilderPreview(targets.length))
      .catch(() => setBuilderPreview(null))
  }

  // Push events: sync progress + index changes.
  useEffect(() => {
    /*
     * A scan reports progress per file, and re-rendering the page thousands of
     * times over is felt everywhere else on it. The bar only has to look alive.
     */
    let pending: SyncProgress | null = null
    let progressTimer: ReturnType<typeof setTimeout> | null = null
    const offProgress = ipcOn('event:sync-progress', (p) => {
      const selected = queryRef.current.libraryId
      if (selected && p.libraryId !== selected) return
      if (p.phase === 'done') {
        if (progressTimer) clearTimeout(progressTimer)
        progressTimer = null
        pending = null
        setProgress(null)
        return
      }
      pending = p
      progressTimer ??= setTimeout(() => {
        progressTimer = null
        if (pending) setProgress(pending)
      }, PROGRESS_INTERVAL_MS)
    })

    /*
     * Coalesced: one sync writes many sidecars, and each would otherwise mean
     * a full re-read of the list and a thrown-away thumbnail cache.
     */
    let changedTimer: ReturnType<typeof setTimeout> | null = null
    const offChanged = ipcOn('event:media-changed', ({ libraryId: lib }) => {
      const selected = queryRef.current.libraryId
      if (selected && lib !== selected) return
      if (changedTimer) clearTimeout(changedTimer)
      changedTimer = setTimeout(() => {
        changedTimer = null
        clearImageCaches()
        setHeatmapEpoch((e) => e + 1)
        void refreshLoaded()
      }, CHANGED_DEBOUNCE_MS)
    })

    const offPlayback = ipcOn('event:playback-changed', ({ mediaId }) => setPlayingId(mediaId))
    return () => {
      if (progressTimer) clearTimeout(progressTimer)
      if (changedTimer) clearTimeout(changedTimer)
      offProgress()
      offChanged()
      offPlayback()
    }
  }, [refreshLoaded])

  const requestSync = async (): Promise<void> => {
    const targets = libraryId ? [libraryId] : libraries.map((l) => l.id)
    try {
      await Promise.all(targets.map((id) => ipcInvoke('library:sync', { id })))
    } catch (e) {
      showToast({ message: toMessage(e) })
    }
  }

  if (libraries.length === 0) {
    return (
      <>
        <h1 className="page-title">{t('media.title')}</h1>
        <div className="empty">{t('media.noLibraries')}</div>
      </>
    )
  }

  return (
    <div
      className="media-page with-filters"
      /*
       * A click on nothing in particular takes one layer off the stack. Bound
       * on mousedown so it happens before a drag can start, and filtered by
       * `dismissesLayer` so using the grid — a card, a tag, a button — is never
       * mistaken for dismissing.
       */
      onMouseDown={(e) => {
        if (dismissesLayer(e.target)) dismissTopLayer()
      }}
    >
      <FilterSidebar
        state={sidebar}
        onChange={setSidebar}
        taxonomy={taxonomy}
        folders={folders}
        kind={listKind}
        onKindChange={setListKind}
        onOpenBuilder={() => {
          setBuilderOpen(true)
          previewFilter(advanced)
        }}
        onSaveFilter={() => filter && saveFilter(filter)}
        onOpenNameSearch={setNameSearch}
      />

      <div className="media-main">
      <div className="media-stage" data-tour="media-stage">
      <div className="row page-header">
        <h1 className="page-title">{t('media.title')}</h1>
        <Select
          value={libraryId ?? ''}
          onChange={setMediaLibrary}
          ariaLabel={t('media.allLibraries')}
          options={[
            { value: '', label: t('media.allLibraries') },
            ...libraries.map((lib) => ({ value: lib.id, label: lib.name }))
          ]}
        />
        {/* Searching the library is about the list as a whole, so it belongs
            up here with the rest of what the list is — the box in the sidebar
            narrows the names below it and nothing else. */}
        <input
          data-tour="media-search"
          className="search"
          type="search"
          value={search}
          placeholder={t('media.searchPlaceholder')}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          value={sort}
          onChange={(v) => setMediaSort(v as MediaSort)}
          ariaLabel={t('media.sort.label')}
          /* A playlist's own order is only an order when exactly one playlist
             is being looked at — across two of them the question has no
             answer, so the option is not offered. */
          options={(
            [
              ...(orderedPlaylist ? (['playlist'] as MediaSort[]) : []),
              'path',
              'title',
              'addedAt',
              'updatedAt',
              'size',
              'rating',
              'scriptCount'
            ] as MediaSort[]
          ).map((key) => ({ value: key, label: t(`media.sort.${key}`) }))}
        />
        <div className="grow" />
        <span className="media-count">{t('media.count', { count: total })}</span>
        {/* Named and tinted rather than one more grey glyph in a row of them:
            this is the way into the queue and the lists, and it was being lost
            next to the view switcher. */}
        <button
          data-tour="media-playlists"
          className={`drawer-open${drawerOpen ? ' on' : ''}`}
          aria-pressed={drawerOpen}
          onClick={onToggleDrawer}
        >
          <ListVideo size={14} />
          <span>{t('playlist.title')}</span>
        </button>
        <div className="view-toggle" data-tour="media-view" role="group">
          <button
            className={viewMode === 'grid' ? 'active' : ''}
            title={t('media.view.grid')}
            aria-label={t('media.view.grid')}
            aria-pressed={viewMode === 'grid'}
            onClick={() => setView('grid')}
          >
            ▦
          </button>
          <button
            className={viewMode === 'list' ? 'active' : ''}
            title={t('media.view.list')}
            aria-label={t('media.view.list')}
            aria-pressed={viewMode === 'list'}
            onClick={() => setView('list')}
          >
            ☰
          </button>
        </div>
        <button
          data-tour="media-sync"
          className="ghost"
          onClick={requestSync}
          disabled={progress !== null}
        >
          {t('media.sync')}
        </button>
      </div>

      {/*
        Which shelf you are looking at, as opposed to how it is filtered. These
        were checkboxes buried in the sidebar's "script" group, where a heart
        sat between "multi-axis" and "no script yet" and read as a property of
        the file rather than as a place to go.
      */}
      <div className="vbar" data-tour="media-shelves">
        <button
          className={`vchip${VIEW_FLAGS.every((f) => !sidebar.flags[f]) ? ' on' : ''}`}
          onClick={() =>
            setSidebar((cur) => ({
              ...cur,
              flags: { ...cur.flags, favorite: false, wanted: false, noScript: false }
            }))
          }
        >
          {t('media.view.all')}
        </button>
        {VIEW_FLAGS.map((flag) => (
          <button
            key={flag}
            className={`vchip${flag === 'favorite' ? ' fav' : ''}${sidebar.flags[flag] ? ' on' : ''}`}
            aria-pressed={sidebar.flags[flag]}
            onClick={() =>
              setSidebar((cur) => ({ ...cur, flags: { ...cur.flags, [flag]: !cur.flags[flag] } }))
            }
          >
            {flag === 'favorite' && <Heart size={11} fill={sidebar.flags[flag] ? 'currentColor' : 'none'} />}
            {t(`media.filter.flag.${flag}`)}
          </button>
        ))}
        <button
          className={`vchip${sort === 'addedAt' ? ' on' : ''}`}
          aria-pressed={sort === 'addedAt'}
          onClick={() => setMediaSort(sort === 'addedAt' ? 'path' : 'addedAt')}
        >
          {t('media.sort.addedAt')}
        </button>
      </div>

      {progress && (
        <div className="sync-banner">
          {t(`media.phase.${progress.phase}`)}
          {progress.total > 0 && ` · ${progress.processed}/${progress.total}`}
        </div>
      )}

      {notice && (
        <div className="detail-notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {pills.length > 0 && (
        <div className="pills">
          {pills.map((pill) => (
            <span key={pill.id} className={`pill${pill.negated ? ' neg' : ''}`}>
              <span className="pill-k">{t(`media.filter.pill.${pill.kind}`)}</span>
              {pill.label}
              <button
                className="pill-x"
                aria-label={t('common.remove')}
                onClick={() =>
                  pill.id === 'advanced' ? setAdvanced(null) : setSidebar(removePill(sidebar, pill.id))
                }
              >
                ✕
              </button>
            </span>
          ))}
          <button
            className="ghost sm"
            onClick={() => {
              setSidebar(emptySidebar())
              setAdvanced(null)
            }}
          >
            {t('media.filter.clearAll')}
          </button>
        </div>
      )}

      {/* The list could not be read: said where the list goes. The rows already
          on screen stay, since they are only out of date. */}
      {loadError && items.length > 0 && <div className="error-banner">{loadError}</div>}
      {items.length === 0 ? (
        loadError ? (
          <div className="error-banner">{loadError}</div>
        ) : (
          <div className="empty">
            {isEmptySidebar(sidebar) && !advanced && !search ? t('media.empty') : t('media.noMatches')}
          </div>
        )
      ) : viewMode === 'list' ? (
        /*
         * Rows, unlike tiles, are not all the same height: a long name wraps
         * and badges wrap with it. VirtuosoGrid measures one item and assumes
         * the rest match, so it has to keep correcting an estimate that is
         * never right, and the correction is felt as the list shifting under
         * the pointer. Virtuoso measures every row instead.
         */
        <Virtuoso
          className={scrollerClass}
          components={{ Item: ListRow }}
          totalCount={items.length}
          computeItemKey={itemKey}
          increaseViewportBy={{ top: 200, bottom: 600 }}
          endReached={onEndReached}
          itemContent={renderItem}
        />
      ) : (
        <VirtuosoGrid
          className={scrollerClass}
          listClassName="media-grid"
          totalCount={items.length}
          /*
           * A tile's identity is the media it shows, not the slot it sits in.
           * Without this the list re-keys by index on every change — a
           * favourite toggled, a page appended — and each tile remounts and is
           * measured again from scratch, which is measurement churn the
           * scroll position then has to absorb.
           */
          computeItemKey={itemKey}
          /*
           * Keep a screenful mounted past the fold. The bouncing near the
           * bottom was the last row flipping in and out of existence: render
           * it, the content grows, the distance to the bottom changes, un-render
           * it, it shrinks again. With overscan the row is already there before
           * it is needed, so there is nothing to flip.
           */
          increaseViewportBy={{ top: 200, bottom: 600 }}
          endReached={onEndReached}
          itemContent={renderItem}
        />
      )}

      {/*
        Bottom to top: the selection you are editing, the video you opened to
        check something. The stack belongs to the media stage so the batch
        action bar below always remains visible. Dismissing removes one layer —
        see LayerStack. The queue and the playlists are not here: they are the
        app's drawer now, because playback outlives this page.
      */}
      <LayerStack
        layers={[
          selected.size > 0 && {
            id: 'batch',
            onClose: () => setSelected(new Map()),
            node: (
              <BatchPanel
                selection={selectedItems}
                selectionCount={selected.size}
                taxonomy={taxonomy}
                busy={batchBusy}
                onApply={(edit) => void applyBatch(edit)}
                onApplyPostLink={(url) => void applyPostLink(url)}
                onClose={() => setSelected(new Map())}
              />
            )
          },
          detail && {
            id: 'detail',
            onClose: () => setDetail(null),
            node: (
              <MediaDetailPage
                key={`${detail.libraryId}:${detail.mediaId}`}
                selection={detail}
                onBack={() => setDetail(null)}
                picked={sidebar.names}
                onPickName={onPickName}
              />
            )
          }
        ]}
      />
      </div>

      {selected.size > 0 && (
        <div className="actionbar glass">
          <span className="actionbar-n">{t('media.batch.selected', { count: selected.size })}</span>
          <div className="btn-row">
            {selected.size < total && (
              <button className="ghost sm" onClick={() => void selectAll()}>
                {t('media.batch.selectAll', { count: total })}
              </button>
            )}
            {/* What the selection is for, before what it can be edited into:
                a handful of ticked cards is most often a queue in the making. */}
            <button className="ghost sm" onClick={() => void playNow(selectedTargets)}>
              {t('media.menu.play')}
            </button>
            <button className="ghost sm" onClick={() => void enqueue(selectedTargets, 'end')}>
              {t('media.menu.addToQueue')}
            </button>
            {/* The edit people make in bulk, without opening the panel. The
                playlist picker adds to an existing list or names a new one;
                either way the media land in that list's own order. */}
            <QuickAdd
              field="playlists"
              taxonomy={taxonomy}
              disabled={batchBusy}
              onPick={(name) => void addToPlaylist(selectedTargets, name)}
            />
            <QuickAdd
              field="tags"
              taxonomy={taxonomy}
              disabled={batchBusy}
              onPick={(name) => void applyBatch({ add: { tags: [name] }, remove: {} })}
            />
            {/* Only when the selection says which entry can survive it. */}
            {mergeRows && (
              <button className="ghost sm" disabled={batchBusy} onClick={() => setMerging(true)}>
                {t('media.merge.action')}
              </button>
            )}
            <button className="ghost sm" onClick={() => setSelected(new Map())}>
              {t('media.batch.clear')}
            </button>
            {/* Set apart from the edits: everything else on this bar can be
                undone by doing it again. */}
            <button
              className="ghost sm danger"
              disabled={batchBusy}
              onClick={() => setDeleting(true)}
            >
              {t('media.delete.action')}
            </button>
          </div>
        </div>
      )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}

      {deleting && (
        <DeleteMediaDialog
          targets={selectedTargets}
          onClose={() => setDeleting(false)}
          onDone={() => {
            setDeleting(false)
            setSelected(new Map())
            void refreshLoaded()
          }}
        />
      )}

      {removing && (
        <DeleteMediaDialog
          targets={removing}
          initialMode="library"
          onClose={() => setRemoving(null)}
          onDone={() => {
            setSelected((cur) => {
              const next = new Map(cur)
              for (const target of removing) next.delete(target.mediaId)
              return next
            })
            setRemoving(null)
            void refreshLoaded()
          }}
        />
      )}

      {merging && mergeRows && (
        <MergeWantedDialog
          libraryId={mergeRows.libraryId}
          rows={mergeRows.rows}
          onClose={() => setMerging(false)}
          onDone={() => {
            setMerging(false)
            setSelected(new Map())
            void refreshLoaded()
          }}
        />
      )}

      {nameSearch !== null && (
        <NameSearchPanel
          taxonomy={taxonomy}
          initialQuery={nameSearch}
          picked={(field, name) => {
            const f = sidebar.names[field]
            const has = (list: string[]): boolean =>
              list.some((n) => n.toLowerCase() === name.toLowerCase())
            return has(f.include) ? 'in' : has(f.exclude) ? 'ex' : null
          }}
          matchCount={total}
          onPick={(field, name, pick) => onPickName(field, name, pick)}
          onClose={() => setNameSearch(null)}
        />
      )}

      {builderOpen && (
        <ConditionBuilder
          initial={advanced}
          matchCount={builderPreview}
          onPreview={previewFilter}
          onApply={(next) => {
            setAdvanced(next)
            setBuilderOpen(false)
          }}
          onSave={saveFilter}
          onClose={() => setBuilderOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * One button in the selection bar that adds a name to everything selected.
 * The picker is the same one the detail panel uses, so an existing collection
 * is one click and a new one is one click plus typing it.
 */
function QuickAdd({
  field,
  taxonomy,
  disabled,
  onPick
}: {
  field: NameField
  taxonomy: Taxonomy | null
  disabled: boolean
  onPick: (name: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const buttonRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // This one sits on the bottom action bar, so it almost always opens upwards;
  // the placement works that out rather than being told.
  const placement = usePopover(buttonRef, open, close, { maxHeight: 260 })

  const options = (taxonomy?.entities[field] ?? [])
    .filter((e) => !query.trim() || e.name.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 10)
  const exact = (taxonomy?.entities[field] ?? []).some(
    (e) => e.name.toLowerCase() === query.trim().toLowerCase()
  )

  const pick = (name: string): void => {
    if (!name.trim()) return
    onPick(name.trim())
    setQuery('')
    setOpen(false)
  }

  return (
    <span className="chip-add-wrap">
      <button
        ref={buttonRef}
        className="ghost sm"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        ＋ {t(`media.filter.kind.${field}`)}
      </button>
      {open &&
        placement &&
        createPortal(
          <>
            {/* Untouched menus dismiss on an outside click; one with something
                typed in it does not. */}
            <div className="chip-scrim" onClick={() => !query.trim() && close()} />
            <div className="chip-menu" style={placement}>
              <input
                className="chip-input"
                autoFocus
                value={query}
                placeholder={t('media.info.addPlaceholder')}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') pick(query)
                  if (e.key === 'Escape') close()
                }}
              />
              {options.map((option) => (
                <button key={option.name} className="chip-hit" onClick={() => pick(option.name)}>
                  <span className="chip-hit-name">{option.name}</span>
                  <span className="chip-hit-n">{option.countWithDescendants}</span>
                </button>
              ))}
              {query.trim() && !exact && (
                <button className="chip-hit new" onClick={() => pick(query)}>
                  {t('media.info.createNamed', { name: query.trim() })}
                </button>
              )}
            </div>
          </>,
          document.body
        )}
    </span>
  )
}

/**
 * Counts the chips a one-line badge row has pushed out of sight.
 *
 * Which ones wrap depends on the text, the column width and the font, so it
 * can only be read back from the laid-out DOM. The count itself is absolutely
 * positioned over a reserved gutter, so writing it changes the row's width but
 * never its wrapping: the count settles after one extra pass and stays put.
 */
function useHiddenBadges(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(0)
  const count = useCallback((): void => {
    const row = ref.current
    if (!row) return
    const chips = (Array.from(row.children) as HTMLElement[]).filter(
      (c) => !c.classList.contains('badge-more')
    )
    const firstLine = chips[0]?.offsetTop ?? 0
    setHidden(chips.filter((c) => c.offsetTop > firstLine).length)
  }, [])
  // No dependency list: recount after every render, because the badges change
  // with the card's own data and the gutter takes a second pass to settle.
  useLayoutEffect(count)
  // Watching the border box, not the content box, keeps the gutter from
  // reporting itself as a resize and re-entering the observer.
  useLayoutEffect(() => {
    const row = ref.current
    if (!row) return
    const observer = new ResizeObserver(count)
    observer.observe(row, { box: 'border-box' })
    return () => observer.disconnect()
  }, [count])
  return [ref, hidden]
}

/**
 * Memoised: a card is expensive (two cached images and a hover preview) and
 * the page around it re-renders for reasons that have nothing to do with it.
 */
const MediaCard = memo(function MediaCard({
  item,
  heatmapEpoch,
  playing,
  active,
  list,
  selected,
  onToggleSelected,
  onToggleFavorite,
  onOpen,
  pickedTags,
  onPickTag,
  onDragTargets,
  onContextMenu,
  onPlay,
  ordinal
}: {
  item: MediaListItem
  heatmapEpoch: number
  playing: boolean
  active: boolean
  list: boolean
  selected: boolean
  onToggleSelected: (item: MediaListItem) => void
  onToggleFavorite: (item: MediaListItem) => void
  onOpen: (selection: MediaSelection) => void
  /** Lower-cased names the filter already holds, for the chips' own state. */
  pickedTags: { include: Set<string>; exclude: Set<string> }
  onPickTag: (name: string, pick: NamePick) => void
  /** What dragging this card carries — itself, or the whole selection. */
  onDragTargets: (item: MediaListItem) => MediaDragTarget[]
  /** Right-click: play it, queue it, file it. */
  onContextMenu: (e: React.MouseEvent, item: MediaListItem) => void
  /** Double-click: play it, rather than read about it. */
  onPlay: (item: MediaListItem) => void
  /** Place in the playlist being shown, or null when that is not the order. */
  ordinal: number | null
}): React.JSX.Element {
  // Hover plays a muted inline preview; a click opens the detail panel (where
  // the real device playback lives). Only mount the <video> while hovered so
  // one preview streams at a time, not every visible card.
  const { t } = useTranslation()
  const [preview, setPreview] = useState(false)
  const canPreview = !item.missing && isPreviewable(item.fileName)
  const open = (): void => onOpen({ libraryId: item.libraryId, mediaId: item.id })
  const [badgesRef, hiddenBadges] = useHiddenBadges()
  return (
    <div
      className={`media-card${list ? ' list' : ''}${item.missing && !item.wanted ? ' missing' : ''}${item.wanted ? ' wanted' : ''}${playing ? ' playing' : ''}${active ? ' active' : ''}${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      // The whole card is the grip, the way a track row is in a music player.
      // A separate handle only earns its place where a drag would otherwise be
      // mistaken for selecting, which is not the case out here.
      draggable
      onDragStart={(e) => setMediaDrag(e, onDragTargets(item))}
      onClick={open}
      onContextMenu={(e) => onContextMenu(e, item)}
      onDoubleClick={() => onPlay(item)}
      onKeyDown={(e) => {
        // Only the card's own Enter opens it: the buttons inside it — the tick,
        // the heart, a tag — answer for themselves.
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
      onMouseEnter={canPreview ? () => setPreview(true) : undefined}
      onMouseLeave={canPreview ? () => setPreview(false) : undefined}
    >
      {/* Both controls are the same glass chip, and both fade in on hover —
          two different-looking buttons in opposite corners read as two
          unrelated things stuck on the picture. What is already true stays
          visible: a ticked card and a favourite are states, not offers. */}
      {/* The number and the tick share the corner: hovering means you are
          about to act on the card, not read where it sits. */}
      {ordinal !== null && <span className="media-ord">{ordinal}</span>}
      <button
        className={`card-chip media-check${selected ? ' on' : ''}`}
        aria-label={t('media.batch.select')}
        aria-pressed={selected}
        onClick={(e) => {
          e.stopPropagation()
          onToggleSelected(item)
        }}
      >
        <Check size={14} strokeWidth={2.5} />
      </button>
      <button
        className={`card-chip media-fav${item.favorite ? ' on' : ''}`}
        aria-label={t(item.favorite ? 'media.batch.favoriteOff' : 'media.batch.favoriteOn')}
        aria-pressed={item.favorite}
        title={t(item.favorite ? 'media.batch.favoriteOff' : 'media.batch.favoriteOn')}
        onClick={(e) => {
          e.stopPropagation()
          onToggleFavorite(item)
        }}
      >
        <Heart size={14} fill={item.favorite ? 'currentColor' : 'none'} />
      </button>
      <div className="media-thumb sfw">
        <span className="media-ext">{item.fileName.split('.').pop()?.toUpperCase()}</span>
        {!item.missing && (
          <CachedIpcImage
            className="media-thumb-img"
            cache={thumbCache}
            channel="media:getThumbnail"
            libraryId={item.libraryId}
            mediaId={item.id}
            epoch={heatmapEpoch}
          />
        )}
        {preview && (
          <HoverPreview libraryId={item.libraryId} mediaId={item.id} />
        )}
        {item.scriptVersionCount > 0 && (
          <CachedIpcImage
            className="media-heatmap"
            cache={heatmapCache}
            channel="media:getHeatmap"
            libraryId={item.libraryId}
            mediaId={item.id}
            epoch={heatmapEpoch}
          />
        )}
      </div>
      <div className="media-body">
        {/* Size rides with the name rather than competing with the badges for
            the one line below: three badges and a size did not fit, and the
            loser was truncated on some tiles and not others. */}
        <div className="media-name-row">
          <div className="media-name" title={item.filePath}>
            {item.title ?? item.fileName}
          </div>
          <span className="media-size">{formatSize(item.fileSize)}</span>
        </div>
        {list && <div className="media-subpath">{item.filePath}</div>}
        <div ref={badgesRef} className={`media-badges${hiddenBadges > 0 ? ' has-more' : ''}`}>
          {item.wanted ? (
            <span className="badge wanted">{t('media.badges.wanted')}</span>
          ) : (
            item.missing && <span className="badge danger">{t('media.badges.missing')}</span>
          )}
          {item.scriptVersionCount > 0 && (
            <span className="badge accent">
              {t('media.badges.scripts', { count: item.scriptVersionCount })}
            </span>
          )}
          {item.hasMultiAxis && <span className="badge">{t('media.badges.multiAxis')}</span>}
          {item.subtitleLanguages.length > 0 && (
            <span className="badge">
              {t('media.badges.subtitles', { langs: item.subtitleLanguages.join(', ') })}
            </span>
          )}
          {/* Tags come last so they are the ones the row drops: what the file
              has is worth more than which tags it carries. Whatever misses the
              line wraps out of the clip, so a chip is whole or absent. */}
          {item.tags.map((tag) => {
            const key = tag.toLowerCase()
            const state = pickedTags.include.has(key)
              ? ' on'
              : pickedTags.exclude.has(key)
                ? ' off'
                : ''
            return (
              // Same three gestures as the sidebar row of that name, and the
              // click stops here: picking a tag is not opening the card.
              <button
                key={tag}
                className={`badge tag${state}`}
                title={tag}
                onClick={(e) => {
                  e.stopPropagation()
                  onPickTag(tag, namePickFromEvent(e))
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onPickTag(tag, 'exclude')
                }}
              >
                <i className="badge-dot" />
                <span className="badge-text">{tag}</span>
              </button>
            )
          })}
          {/* Chips wrap out of view in order, so the ones being held back are
              the last N — which makes them nameable on hover. */}
          {hiddenBadges > 0 && (
            <span
              className="badge badge-more"
              title={item.tags.slice(item.tags.length - hiddenBadges).join(', ')}
            >
              +{hiddenBadges}
            </span>
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * Muted inline preview shown while a card is hovered. Seeks a little past the
 * start so the frame is representative, loops, and stays silent. Sits above the
 * thumbnail; if the file can't be decoded it errors out and the thumb shows.
 */
function HoverPreview({
  libraryId,
  mediaId
}: {
  libraryId: string
  mediaId: string
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  if (failed) return <></>
  return (
    <video
      className="media-preview-video"
      src={mediaPreviewUrl(libraryId, mediaId)}
      muted
      autoPlay
      loop
      playsInline
      preload="metadata"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget
        if (Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration * 0.1, 20)
      }}
      onError={() => setFailed(true)}
    />
  )
}

/** Lazily fetched, session-cached image (thumbnail / heatmap) for one card. */
