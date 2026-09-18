import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Hand, ListOrdered, LayoutGrid, Maximize2, Search, Tags, X } from 'lucide-react'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { VrPanelAction } from '@shared/vr'
import { applyLanguageSetting } from '../i18n'
import { ipcInvoke, ipcOn } from '../ipc'
import { pinnedFirst } from '../pinnedTags'
import { applyPaletteSetting, applyThemeSetting } from '../theme'
import { useErrorMessage } from '../useErrorMessage'
import VrBrowse from './VrBrowse'
import VrDetail from './VrDetail'
import VrQueue from './VrQueue'
import VrTags, { type TagRow } from './VrTags'
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

export default function VrPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [view, setView] = useState<View>('browse')
  const [searchText, setSearchText] = useState('')
  const [search, setSearch] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [detail, setDetail] = useState<MediaListItem | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const tags = useTags()
  const queueLength = useQueueLength()

  useEffect(() => {
    ipcInvoke('settings:get')
      .then((settings) => {
        applyLanguageSetting(settings.ui.language)
        applyPaletteSetting(settings.ui.palette)
        applyThemeSetting(settings.ui.theme)
      })
      .catch(() => {})
  }, [])

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

  const place = (action: VrPanelAction): void => {
    void ipcInvoke('vr:panel', { action }).catch(() => {})
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
        // A new video closes the column; a script swap is still about this one.
        if (!resumePosition) setDetail(null)
        return result.scriptVersionId
      } catch (e) {
        say(toMessage(e))
        return undefined
      }
    },
    [say, toMessage]
  )

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
          <button
            className={view === 'queue' ? 'on' : ''}
            onClick={() => {
              setView('queue')
              setDetail(null)
            }}
          >
            <ListOrdered size={24} />
            {t('vr.queue')}
            {queueLength > 0 && <span className="vr-count">{queueLength}</span>}
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

      {view !== 'queue' && (
        <div className="vr-tagrow">
          <div className="vr-tagrow-chips">
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
          {picked.length > 0 && (
            <button className="vr-chip vr-chip-plain" onClick={() => setPicked([])}>
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
            <VrBrowse search={search} tags={picked} selectedId={detail?.id ?? null} onOpen={setDetail} />
          )}
          {view === 'tags' && (
            <VrTags tags={tags} picked={picked} onPick={togglePick} onPin={(tag) => void togglePin(tag)} />
          )}
          {view === 'queue' && <VrQueue onPlay={(item) => void play(item)} onError={(e) => say(toMessage(e))} />}
        </main>

        {detail && (
          <VrDetail
            key={detail.id}
            item={detail}
            onClose={() => setDetail(null)}
            onPlay={(scriptVersionId, resume) =>
              play({ libraryId: detail.libraryId, mediaId: detail.id }, scriptVersionId, resume)
            }
            onQueue={(mode) => void enqueue(detail, mode)}
          />
        )}
      </div>

      {notice && <div className="vr-notice">{notice}</div>}
    </div>
  )
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

function useQueueLength(): number {
  const [length, setLength] = useState(0)
  useEffect(() => {
    ipcInvoke('queue:get')
      .then((state) => setLength(state.items.length))
      .catch(() => {})
    return ipcOn('event:queue-changed', (state) => setLength(state.items.length))
  }, [])
  return length
}
