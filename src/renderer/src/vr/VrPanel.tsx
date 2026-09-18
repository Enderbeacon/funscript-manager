import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  EyeOff,
  Hand,
  Heart,
  LayoutGrid,
  Maximize2,
  Moon,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  Tags,
  X
} from 'lucide-react'
import { VR_SORTS } from '@shared/schemas/app-config'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { VrPanelAction } from '@shared/vr'
import { ipcInvoke, ipcOn } from '../ipc'
import { pinnedFirst } from '../pinnedTags'
import { applyThemeSetting, currentTheme, onThemeChange } from '../theme'
import { useAppearance } from '../useAppearance'
import { useErrorMessage } from '../useErrorMessage'
import { useVrKeyboard } from './useVrKeyboard'
import VrBrowse from './VrBrowse'
import VrDetail from './VrDetail'
import VrLookSettings from './VrLookSettings'
import VrNowBar from './VrNowBar'
import VrPlaylists, { VrAddToPlaylist } from './VrPlaylists'
import VrQueue from './VrQueue'
import VrTags, { type TagRow } from './VrTags'
import './vr-surfaces.css'
import './vr.css'

/**
 * The panel shown inside the headset.
 *
 * Everything here is sized for a laser pointer a metre away: big targets, big
 * text, nothing that needs hovering or a right click. It covers what someone
 * wearing the headset actually does — find a video, look at it, play it or
 * queue it, and tidy the queue — and leaves the rest to the desktop.
 *
 * Playing always goes to HereSphere, since that is where the viewer is.
 */

type View = 'browse' | 'tags' | 'queue'

/** How long a note at the foot of the panel stays up. */
const NOTICE_MS = 3000

function place(action: VrPanelAction): void {
  void ipcInvoke('vr:panel', { action }).catch(() => {})
}

export default function VrPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [view, setView] = useState<View>('browse')
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [detail, setDetail] = useState<MediaListItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [lookOpen, setLookOpen] = useState(false)
  const [favorites, setFavorites] = useState(false)
  const [playlistsOpen, setPlaylistsOpen] = useState(false)
  const [addingToPlaylist, setAddingToPlaylist] = useState<MediaListItem | null>(null)
  const [sortOpen, setSortOpen] = useState(false)
  const settings = useAppearance()
  const theme = useResolvedTheme()
  const hideOnPlay = settings?.vr.hideOnPlay ?? true
  const sort = settings?.vr.sort ?? 'path'
  const seekBarOpen = settings?.vr.seekBar ?? true
  const hideOnPlayRef = useRef(hideOnPlay)
  hideOnPlayRef.current = hideOnPlay
  const tags = useTags()
  useVrKeyboard()

  const background = settings?.vr.main.background ?? 1
  useEffect(() => {
    document.documentElement.style.setProperty('--vr-bg-alpha', String(background))
  }, [background])

  // Typing on the headset keyboard sends a letter at a time; the grid waits
  // for a pause rather than reloading on each.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchText.trim()), 300)
    return () => clearTimeout(timer)
  }, [searchText])

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const say = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
  }, [])

  const toggleHideOnPlay = (): void => {
    ipcInvoke('settings:update', { vr: { hideOnPlay: !hideOnPlay } }).catch((e) => say(toMessage(e)))
  }

  const toggleSeekBar = (): void => {
    ipcInvoke('settings:update', { vr: { seekBar: !seekBarOpen } }).catch((e) => say(toMessage(e)))
  }

  // The same setting as the desktop's, so both change together.
  const toggleTheme = (): void => {
    const next = theme === 'dark' ? 'light' : 'dark'
    applyThemeSetting(next)
    ipcInvoke('settings:update', { ui: { theme: next } }).catch((e) => say(toMessage(e)))
  }

  /** Resolves with the script version loaded, or undefined when it failed. */
  const play = useCallback(
    async (
      item: { libraryId: string; mediaId: string },
      scriptVersionId?: string,
      resumePosition = false
    ): Promise<string | null | undefined> => {
      try {
        const result = await ipcInvoke('vr:play', {
          ...item,
          ...(scriptVersionId ? { scriptVersionId } : {}),
          ...(resumePosition ? { resumePosition } : {})
        })
        // A script swap on the video already playing is adjusting it, not
        // starting something to watch.
        if (!resumePosition && hideOnPlayRef.current) place('hide')
        return result.scriptVersionId
      } catch (e) {
        say(toMessage(e))
        return undefined
      }
    },
    [say, toMessage]
  )

  const playPlaylist = async (name: string, items: MediaListItem[], at: number): Promise<void> => {
    try {
      await ipcInvoke('vr:queue', {
        action: 'start',
        source: { kind: 'playlist', name },
        items: items.map((item) => ({ libraryId: item.libraryId, mediaId: item.id })),
        at
      })
      setPlaylistsOpen(false)
      if (hideOnPlayRef.current) place('hide')
    } catch (e) {
      say(toMessage(e))
    }
  }

  const enqueue = useCallback(
    async (item: MediaListItem, mode: 'next' | 'end') => {
      try {
        const state = await ipcInvoke('queue:add', {
          items: [{ libraryId: item.libraryId, mediaId: item.id }],
          mode
        })
        say(t(mode === 'next' ? 'vr.queuedNext' : 'vr.queuedEnd', { total: state.items.length }))
      } catch (e) {
        say(toMessage(e))
      }
    },
    [say, t, toMessage]
  )

  const togglePick = (name: string): void => {
    setPicked((current) =>
      current.includes(name) ? current.filter((n) => n !== name) : [...current, name]
    )
  }

  const togglePin = async (tag: TagRow): Promise<void> => {
    try {
      await ipcInvoke('taxonomy:update', { kind: 'tags', name: tag.name, patch: { pinned: !tag.pinned } })
    } catch (e) {
      say(toMessage(e))
    }
  }

  // The row under the bar: pinned tags, then anything picked from the full
  // list that is not pinned, so every active filter can be seen and undone.
  const pinned = tags.filter((tag) => tag.pinned)
  const rowNames = [
    ...pinned.map((tag) => tag.name),
    ...picked.filter((name) => !pinned.some((tag) => tag.name === name))
  ]

  return (
    <div className="vr-panel">
      <header className="vr-bar">
        <label className="vr-search">
          <Search size={26} />
          <input
            value={searchText}
            placeholder={t('vr.search')}
            onChange={(e) => setSearchText(e.target.value)}
          />
          {searchText && (
            <button className="vr-icon-btn" aria-label={t('vr.clearSearch')} onClick={() => setSearchText('')}>
              <X size={24} />
            </button>
          )}
        </label>

        <nav className="vr-tabs">
          <button className={view !== 'queue' ? 'on' : ''} onClick={() => setView('browse')}>
            <LayoutGrid size={24} />
            {t('vr.browse')}
          </button>
        </nav>

        <div className="vr-place">
          <button onClick={() => place('wrist')}>
            <Hand size={24} />
            {t('vr.toWrist')}
          </button>
          <button onClick={() => place('front')}>
            <Maximize2 size={24} />
            {t('vr.toFront')}
          </button>
          <button className="vr-icon-btn vr-close" aria-label={t('vr.hide')} onClick={() => place('hide')}>
            <X size={30} />
          </button>
        </div>
      </header>

      <div className="vr-toolrow">
        <button onClick={() => place('scriptPlayer')}>
          <SlidersHorizontal size={24} />
          {t('vr.scriptPlayer')}
        </button>
        <button
          className="vr-square"
          aria-label={t(theme === 'dark' ? 'vr.toLight' : 'vr.toDark')}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={24} /> : <Moon size={24} />}
        </button>
        <button onClick={() => setLookOpen(true)}>
          <Settings2 size={24} />
          {t('vr.panelSettings')}
        </button>
        <div className="vr-menu-root">
          <button aria-haspopup="listbox" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>
            <ArrowUpDown size={24} />
            {t(`media.sort.${sort}`)}
            <ChevronDown size={22} />
          </button>
          {sortOpen && (
            <>
              <div className="vr-menu-scrim" onPointerDown={() => setSortOpen(false)} />
              <div className="vr-menu" role="listbox" aria-label={t('media.sort.label')}>
                {VR_SORTS.map((option) => (
                  <button
                    key={option}
                    role="option"
                    aria-selected={option === sort}
                    className={option === sort ? 'on' : ''}
                    onClick={() => {
                      setSortOpen(false)
                      if (option !== sort) {
                        ipcInvoke('settings:update', { vr: { sort: option } }).catch((e) => say(toMessage(e)))
                      }
                    }}
                  >
                    <span className="vr-menu-check">{option === sort && <Check size={24} />}</span>
                    {t(`media.sort.${option}`)}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="grow" />
        <button className={`vr-chip vr-chip-plain${hideOnPlay ? ' on' : ''}`} aria-pressed={hideOnPlay} onClick={toggleHideOnPlay}>
          <EyeOff size={22} />
          {t('vr.hideOnPlay')}
        </button>
      </div>

      {view !== 'queue' && (
        <div className="vr-tagrow">
          <div className="vr-tagrow-chips">
            <button
              className={`vr-chip vr-chip-fav${favorites ? ' on' : ''}`}
              aria-pressed={favorites}
              onClick={() => setFavorites((on) => !on)}
            >
              <Heart size={22} fill={favorites ? 'currentColor' : 'none'} />
              {t('media.filter.flag.favorite')}
            </button>
            {rowNames.length === 0 && <span className="vr-hint">{t('vr.noPinned')}</span>}
            {rowNames.map((name) => (
              <button
                key={name}
                className={`vr-chip${picked.includes(name) ? ' on' : ''}`}
                onClick={() => togglePick(name)}
              >
                {name}
              </button>
            ))}
          </div>
          {(picked.length > 0 || favorites) && (
            <button
              className="vr-chip vr-chip-plain"
              onClick={() => {
                setPicked([])
                setFavorites(false)
              }}
            >
              {t('vr.clearTags')}
            </button>
          )}
          <button
            className={`vr-chip vr-chip-plain${view === 'tags' ? ' on' : ''}`}
            onClick={() => setView(view === 'tags' ? 'browse' : 'tags')}
          >
            <Tags size={22} />
            {t(view === 'tags' ? 'vr.showVideos' : 'vr.allTags')}
          </button>
        </div>
      )}

      <div className="vr-body">
        <main className={`vr-content${detail ? ' narrow' : ''}`}>
          {view === 'browse' && (
            <VrBrowse
              search={search}
              tags={picked}
              favorites={favorites}
              sort={sort}
              selectedId={detail?.id ?? null}
              onOpen={setDetail}
            />
          )}
          {view === 'tags' && (
            <VrTags tags={tags} picked={picked} onPick={togglePick} onPin={(tag) => void togglePin(tag)} />
          )}
          {view === 'queue' && (
            <VrQueue onPlay={(item) => void play(item)} onSaved={say} onError={(e) => say(toMessage(e))} />
          )}
        </main>

        {detail && (
          <VrDetail
            key={detail.id}
            item={detail}
            picked={picked}
            onPickTag={togglePick}
            onClose={() => setDetail(null)}
            onPlay={(scriptVersionId, resume) =>
              play({ libraryId: detail.libraryId, mediaId: detail.id }, scriptVersionId, resume)
            }
            onQueue={(mode) => void enqueue(detail, mode)}
            onAddToPlaylist={() => setAddingToPlaylist(detail)}
            onError={(e) => say(toMessage(e))}
          />
        )}
      </div>

      <VrNowBar
        queueOpen={view === 'queue'}
        onQueue={() => {
          if (view === 'queue') {
            setView('browse')
          } else {
            setView('queue')
            setDetail(null)
          }
        }}
        onPlaylists={() => setPlaylistsOpen(true)}
        seekBarOpen={seekBarOpen}
        onToggleSeekBar={toggleSeekBar}
        onError={(e) => say(toMessage(e))}
      />

      {playlistsOpen && (
        <VrPlaylists
          onPlay={playPlaylist}
          onClose={() => setPlaylistsOpen(false)}
          onError={(e) => say(toMessage(e))}
        />
      )}

      {addingToPlaylist && (
        <VrAddToPlaylist
          item={addingToPlaylist}
          onDone={(name) => {
            setAddingToPlaylist(null)
            say(t('playlist.added', { count: 1, name }))
          }}
          onClose={() => setAddingToPlaylist(null)}
          onError={(e) => say(toMessage(e))}
        />
      )}

      {lookOpen && settings && (
        <VrLookSettings look={settings.vr} onClose={() => setLookOpen(false)} onError={(e) => say(toMessage(e))} />
      )}

      {notice && <div className="vr-notice">{notice}</div>}
    </div>
  )
}

/** The theme on screen, with 'system' already resolved. */
function useResolvedTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(currentTheme)
  useEffect(() => onThemeChange(setTheme), [])
  return theme
}

/** The tags in display order, kept current. */
function useTags(): TagRow[] {
  const [tags, setTags] = useState<TagRow[]>([])
  useEffect(() => {
    const load = (): void => {
      ipcInvoke('taxonomy:get')
        .then((taxonomy) =>
          // Pinned first, the latest pinned at the top, as in the desktop sidebar.
          setTags(pinnedFirst(taxonomy.entities.tags).filter((tag) => tag.countWithDescendants > 0))
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
  return tags
}
