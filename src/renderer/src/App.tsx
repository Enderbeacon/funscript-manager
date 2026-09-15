import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Film, Info, Link2, Newspaper, Settings, Tags } from 'lucide-react'
import type { NameField } from '@shared/schemas/media-meta'
import { ipcInvoke, ipcOn } from './ipc'
import { applyLanguageSetting } from './i18n'
import {
  applyNamePick,
  emptySidebar,
  type NamePick,
  type SidebarState
} from './filters'
import { applyPaletteSetting, applyThemeSetting } from './theme'
import { raiseSurface, useIsFrontSurface, useSurfaceEscape } from './surfaces'
import ConnStatusPanel from './components/ConnStatusPanel'
import NowPlayingBar from './components/NowPlayingBar'
import PlaybackDrawer, { type DrawerTab } from './components/PlaybackDrawer'
import TopBar from './components/TopBar'
import DownloadsPage from './pages/DownloadsPage'
import PostsPage from './pages/PostsPage'
import MediaPage from './pages/MediaPage'
import TagLibrariesPage from './pages/TagLibrariesPage'
import MatchPage from './pages/MatchPage'
import SettingsPage, { type SettingsNavigationRequest } from './pages/SettingsPage'
import { restoreQueue } from './organiseQueue'
import ScriptPlayerFloating from '@script-player/interface/renderer/ScriptPlayerFloating'
import MediaSourceFloating from './components/MediaSourceFloating'
import { type StageForm, useVideoIntent } from './components/VideoPlayerStage'
import CloseConfirmDialog from './components/CloseConfirmDialog'
import { DialogHost } from './dialogs'
import UpdateNotices from './components/UpdateNotices'
import AboutPage from './pages/AboutPage'
import VideoPlayerSurface from './components/VideoPlayerSurface'
import TourOverlay from './tour/TourOverlay'
import { loadTour, registerTourDriver, visitPage } from './tour/tour'

export type Page = 'media' | 'tagLibraries' | 'posts' | 'match' | 'settings' | 'about'

const NAV: { key: Page; Icon: typeof Film }[] = [
  { key: 'media', Icon: Film },
  { key: 'tagLibraries', Icon: Tags },
  { key: 'posts', Icon: Newspaper },
  { key: 'match', Icon: Link2 },
  { key: 'settings', Icon: Settings },
  { key: 'about', Icon: Info }
]

/** Which media the detail view is showing (null = the grid). */
export interface MediaSelection {
  libraryId: string
  mediaId: string
}

export default function App(): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState<Page>('media')
  const [appInfo, setAppInfo] = useState<{ version: string; electron: string } | null>(null)
  /**
   * The playback drawer — the queue, and the playlists to build it from. Null
   * is shut. App-level because playback is: it has to be reachable from the
   * whatever page is open without dragging the user back to media first.
   */
  const [drawer, setDrawer] = useState<DrawerTab | null>(null)
  /**
   * A video the user asked to see from outside the media page — a row in the
   * queue, the artwork on the bar. The detail view is one of the media page's
   * layers, so the request travels there with a nonce: asking twice for the
   * same video has to arrive twice.
   */
  const [detailRequest, setDetailRequest] = useState<{
    selection: MediaSelection | null
    nonce: number
  } | null>(null)
  /** What the detail panel is showing, so a second press can put it away. */
  const [openDetail, setOpenDetail] = useState<MediaSelection | null>(null)
  /** What is playing, for the panels that mark it. */
  const [playingId, setPlayingId] = useState<string | null>(null)
  /** Jobs still moving, for the badge on the combined Download Post tab. */
  const [activeJobs, setActiveJobs] = useState(0)
  /** Full queue opened from the compact download card on the Posts page. */
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  /** Library failure the user has to act on (e.g. the disk holding it is full). */
  const [libraryError, setLibraryError] = useState<string | null>(null)
  const [scriptPlayerOpen, setScriptPlayerOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [scriptPlayerDetached, setScriptPlayerDetached] = useState(false)
  /**
   * The window is on its way out and a player is in a window of its own, so
   * the question is on screen. Which windows those are decides its wording.
   */
  const [closing, setClosing] = useState<{ video: boolean; script: boolean } | null>(null)
  /**
   * The built-in picture. `intent` is the main process's; the two pieces of
   * state here are the ones only this window has an opinion about: what shape
   * the picture is in, and whether it has been put away while its sound
   * carries on (`playback.keepPlayingWhenClosed`).
   */
  const intent = useVideoIntent()
  const [videoDetached, setVideoDetached] = useState(false)
  const [videoForm, setVideoForm] = useState<StageForm>('fill')
  const [videoHidden, setVideoHidden] = useState(false)
  const [videoFullscreen, setVideoFullscreen] = useState(false)
  const [settingsRequest, setSettingsRequest] = useState<SettingsNavigationRequest | null>(null)
  /**
   * The filter sidebar's state lives here rather than in the media page so it
   * survives a trip to another tab: come back to the media page and the filter
   * is still the one you left.
   */
  const [sidebar, setSidebar] = useState<SidebarState>(emptySidebar)
  const pickName = (field: NameField, name: string, pick: NamePick): void =>
    setSidebar((current) => applyNamePick(current, field, name, pick))

  // Escape closes whichever floating panel is in front, drawer included.
  useSurfaceEscape()
  const drawerInFront = useIsFrontSurface('drawer')

  /**
   * The queue button on the bar, and the one on the media page's toolbar.
   *
   * Three states rather than two, because the drawer shares the right-hand
   * strip with the media page's panels and can be open but buried: shut opens
   * it, buried brings it forward, and only a press on the tab already in front
   * puts it away. A button that closed a drawer the user could not see would
   * feel like it had done nothing.
   */
  const toggleDrawer = (wanted: DrawerTab): void => {
    if (drawer === null) setDrawer(wanted)
    else if (!drawerInFront) {
      raiseSurface('drawer')
      setDrawer(wanted)
    } else if (drawer !== wanted) setDrawer(wanted)
    else setDrawer(null)
  }

  useEffect(() => {
    ipcInvoke('app:getInfo').then(setAppInfo).catch(console.error)
    // Apply persisted UI preferences on startup.
    ipcInvoke('settings:get')
      .then((s) => {
        applyLanguageSetting(s.ui.language)
        applyPaletteSetting(s.ui.palette)
        applyThemeSetting(s.ui.theme)
      })
      .catch(console.error)
    // Tag edits that did not finish last time. Picked up here rather than on
    // the organise page, so they carry on whether or not the user goes back to
    // it — and hold themselves until the libraries are up.
    void restoreQueue()
    // What the tour has already shown, so it knows whether to offer itself.
    void loadTour().catch(() => {})
  }, [])

  useEffect(() => {
    ipcInvoke('script-player:surface').then(({ detached }) => setScriptPlayerDetached(detached)).catch(() => {})
    return ipcOn('event:script-player-surface', ({ detached }) => {
      setScriptPlayerDetached(detached)
      if (detached) setScriptPlayerOpen(false)
    })
  }, [])

  /**
   * Closing the window with a player in one of its own: the main process has
   * held the close and is waiting for an answer (see main-window.ts).
   */
  useEffect(() => {
    return ipcOn('event:confirm-close', setClosing)
  }, [])

  useEffect(() => {
    return ipcOn('event:open-settings', ({ section, target }) => {
      setDownloadsOpen(false)
      setScriptPlayerOpen(false)
      setSettingsRequest((current) => ({
        section,
        target,
        nonce: (current?.nonce ?? 0) + 1
      }))
      setPage('settings')
    })
  }, [])

  /**
   * Closing the picture: away for good, or only out of sight?
   *
   * With the setting on it is the second — the sound carries on and the
   * artwork on the bar brings it back, the way a music player behaves. With it
   * off, closing lets go of the player, because the picture *is* the player.
   */
  const closeVideo = (): void => {
    void ipcInvoke('settings:get')
      .then((settings) => {
        if (settings.playback.keepPlayingWhenClosed) setVideoHidden(true)
        else void ipcInvoke('video:close').catch(() => {})
      })
      .catch(() => {})
  }

  const openSources = (): void => {
    setSourcesOpen(true)
    raiseSurface('media-source')
  }

  const openScriptPlayer = (): void => {
    if (scriptPlayerDetached) void ipcInvoke('script-player:detach')
    else {
      setScriptPlayerOpen(true)
      raiseSurface('script-player')
    }
  }

  /**
   * How the tour moves the app around. Re-registered on every render, because
   * these close over the state as it is now — a driver captured once would be
   * steering the window the app had at startup.
   */
  useEffect(() => {
    registerTourDriver({
      goto: (target) => {
        setDownloadsOpen(false)
        setSettingsRequest(null)
        setPage(target)
      },
      settingsTab: (section) => {
        setDownloadsOpen(false)
        setSettingsRequest((current) => ({ section, nonce: (current?.nonce ?? 0) + 1 }))
        setPage('settings')
      },
      sources: (open) => {
        if (open) openSources()
        else setSourcesOpen(false)
      },
      scriptPlayer: (open) => {
        if (open) openScriptPlayer()
        else setScriptPlayerOpen(false)
      },
      page: () => page
    })
  })

  /**
   * Starting a video puts the details away.
   *
   * You pressed play on that page; what you want next is the picture, and
   * having to close the panel you pressed play from is a step nobody wants.
   * Only where the picture would be behind it: filling the window or full
   * screen. Floating leaves the page alone by definition, and the picture's
   * own window is not covering anything here.
   *
   * Read through a ref so this fires when a video starts, not when the shape
   * changes — going from floating to filling is not "you pressed play".
   */
  const coveringRef = useRef(false)
  coveringRef.current = !videoDetached && (videoForm === 'fill' || videoFullscreen)
  const startedPath = intent?.active ? (intent.media?.path ?? null) : null

  useEffect(() => {
    setVideoHidden(false)
    if (startedPath === null || !coveringRef.current) return
    setDetailRequest((cur) => ({ selection: null, nonce: (cur?.nonce ?? 0) + 1 }))
  }, [startedPath])

  useEffect(() => ipcOn('event:video-surface', ({ detached }) => setVideoDetached(detached)), [])

  useEffect(() => {
    ipcInvoke('video:surface')
      .then(({ detached }) => setVideoDetached(detached))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const count = (): void => {
      ipcInvoke('download:list')
        .then(({ jobs }) =>
          setActiveJobs(
            jobs.filter((j) => j.state === 'running' || j.state === 'pending' || j.state === 'cooling')
              .length
          )
        )
        .catch(() => {})
    }
    count()
    return ipcOn('event:downloads-changed', count)
  }, [])

  useEffect(() => {
    ipcInvoke('playback:status').then((s) => setPlayingId(s.mediaId)).catch(() => {})
    return ipcOn('event:playback-changed', ({ mediaId }) => setPlayingId(mediaId))
  }, [])

  /**
   * Show a video's details — or put them away, if this is what opened them.
   *
   * The artwork on the bar is a button that is pressed twice: once to see what
   * is playing, once to get back to what you were doing. Opening only would
   * leave the second press looking broken.
   */
  const openMedia = (selection: MediaSelection): void => {
    const showing =
      openDetail?.mediaId === selection.mediaId && openDetail?.libraryId === selection.libraryId
    setDownloadsOpen(false)
    setPage('media')
    setDetailRequest((cur) => ({ selection: showing ? null : selection, nonce: (cur?.nonce ?? 0) + 1 }))
  }

  useEffect(() => {
    return ipcOn('event:library-error', ({ libraryName, code }) =>
      setLibraryError(t(`errors.${code}`, { path: libraryName }))
    )
  }, [t])

  return (
    <div className="app">
      <TopBar
        onOpenSources={openSources}
        sourcesActive={sourcesOpen}
        onOpenScriptPlayer={openScriptPlayer}
        scriptPlayerActive={scriptPlayerOpen || scriptPlayerDetached}
        scriptPlayerDetached={scriptPlayerDetached}
        onOpenUpdates={() => setPage('about')}
      />
      {libraryError && (
        <div className="error-banner">
          <div className="row">
            <div className="grow">{libraryError}</div>
            <button className="ghost sm" onClick={() => setLibraryError(null)}>
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
      <div className="app-body">
      <nav className="sidebar">
        <ConnStatusPanel
          onOpenScriptPlayer={openScriptPlayer}
          onOpenSources={openSources}
        />
        {NAV.map(({ key, Icon }) => (
          <button
            key={key}
            data-tour={`nav-${key}`}
            className={`nav-item${page === key ? ' active' : ''}`}
            title={t(`nav.${key}`)}
            onClick={() => {
              setDownloadsOpen(false)
              setSettingsRequest(null)
              setPage(key)
              // Only a press here counts as a first visit; the tour walking
              // itself onto a page must not set that page's own section off.
              visitPage(key)
            }}
          >
            <Icon size={16} />
            {/* The label is its own element so the collapsed rail can drop it. */}
            <span className="nav-label">{t(`nav.${key}`)}</span>
            {key === 'posts' && activeJobs > 0 && <span className="nav-count">{activeJobs}</span>}
          </button>
        ))}
        <div className="footer">
          {appInfo ? `v${appInfo.version} · Electron ${appInfo.electron}` : '…'}
        </div>
      </nav>
      <main className="content">
        {page === 'media' && (
          <MediaPage
            sidebar={sidebar}
            onSidebarChange={setSidebar}
            onPickName={pickName}
            detailRequest={detailRequest}
            onDetailChange={setOpenDetail}
            drawerOpen={drawer !== null && drawerInFront}
            onToggleDrawer={() => toggleDrawer('playlists')}
          />
        )}
        {page === 'tagLibraries' && <TagLibrariesPage />}
        {page === 'posts' && <PostsPage onOpenDownloads={() => setDownloadsOpen(true)} />}
        {page === 'match' && <MatchPage />}
        {page === 'settings' && (
          <SettingsPage
            onOpenScriptPlayer={openScriptPlayer}
            navigationRequest={settingsRequest}
          />
        )}
        {page === 'about' && <AboutPage />}
      </main>
      {drawer !== null && (
        <PlaybackDrawer
          tab={drawer}
          onTab={setDrawer}
          onClose={() => setDrawer(null)}
          onOpenMedia={openMedia}
          playingId={playingId}
        />
      )}
      {scriptPlayerOpen && !scriptPlayerDetached && (
        <ScriptPlayerFloating onClose={() => setScriptPlayerOpen(false)} />
      )}

      {/*
        The picture. `fill` covers the content area and leaves the page behind
        it untouched, so shrinking it back gives the user the screen they left
        — scroll position, filters and all.
      */}
      {intent?.active && !videoDetached && (
        <VideoPlayerSurface
          intent={intent}
          form={videoForm}
          onForm={setVideoForm}
          onClose={closeVideo}
          tucked={videoHidden}
          onFullscreenChange={setVideoFullscreen}
        />
      )}

      <DialogHost />
      <UpdateNotices />

      {closing && (
        <CloseConfirmDialog
          video={closing.video}
          script={closing.script}
          onCancel={() => setClosing(null)}
        />
      )}

      {sourcesOpen && <MediaSourceFloating onClose={() => setSourcesOpen(false)} />}
      {downloadsOpen && <DownloadsPage onClose={() => setDownloadsOpen(false)} />}
      </div>
      {/*
        Below the whole body, spanning the nav rail too: playback outlives the
        page that started it, so its controls have to be somewhere every page
        still has.
      */}
      <NowPlayingBar
        queueOpen={drawer === 'queue' && drawerInFront}
        onToggleQueue={() => toggleDrawer('queue')}
        onOpenMedia={openMedia}
        onArtwork={videoHidden ? () => setVideoHidden(false) : null}
      />
      <TourOverlay />
    </div>
  )
}
