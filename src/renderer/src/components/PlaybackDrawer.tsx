import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaSelection } from '../App'
import { ipcInvoke, ipcOn } from '../ipc'
import { useSurface } from '../surfaces'
import type { Taxonomy } from './NameChips'
import PlaylistPanel from './PlaylistPanel'
import QueuePanel from './QueuePanel'

/**
 * The playback drawer: what is playing next, and the lists to build it from.
 *
 * App-level rather than one of the media page's layers, because playback is
 * app-level: the queue button on the bar used to have to drag the user back to
 * the media page before it could show them anything, which changed the page
 * out from under someone who only wanted to know what was next.
 *
 * It floats over the content instead of pushing it aside, so the grid keeps its
 * full width and dragging a card into a playlist or the queue stays a short
 * movement rather than a trip across the window.
 */

export type DrawerTab = 'queue' | 'playlists'

export default function PlaybackDrawer({
  tab,
  onTab,
  onClose,
  onOpenMedia,
  playingId
}: {
  tab: DrawerTab
  onTab: (tab: DrawerTab) => void
  onClose: () => void
  /** Show a video's detail — which lives on the media page, wherever we are. */
  onOpenMedia: (selection: MediaSelection) => void
  playingId: string | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null)
  /** Which playlist is expanded; kept here so switching tabs does not lose it. */
  const [openPlaylist, setOpenPlaylist] = useState<string | null>(null)
  const { z, front, raise } = useSurface('drawer', onClose)

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

  return (
    <aside
      className={`playback-drawer${front ? '' : ' behind'}`}
      style={{ zIndex: z }}
      /* Clicking the drawer brings it forward, the way clicking a window does:
         it shares the right-hand strip with the media page's own panels. */
      onPointerDown={raise}
    >
      <div className="drawer-tabs" role="tablist">
        <button
          className={`drawer-tab${tab === 'queue' ? ' on' : ''}`}
          role="tab"
          aria-selected={tab === 'queue'}
          onClick={() => onTab('queue')}
        >
          {t('queue.title')}
        </button>
        <button
          className={`drawer-tab${tab === 'playlists' ? ' on' : ''}`}
          role="tab"
          aria-selected={tab === 'playlists'}
          onClick={() => onTab('playlists')}
        >
          {t('playlist.title')}
        </button>
      </div>
      {tab === 'queue' ? (
        <QueuePanel onOpen={onOpenMedia} onClose={onClose} playingId={playingId} />
      ) : (
        <PlaylistPanel
          taxonomy={taxonomy}
          selected={openPlaylist}
          onSelect={setOpenPlaylist}
          onOpen={onOpenMedia}
          onClose={onClose}
          playingId={playingId}
        />
      )}
    </aside>
  )
}
