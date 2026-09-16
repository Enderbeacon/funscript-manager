import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpCircle,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  LogIn,
  MonitorPlay,
  Moon,
  RadioTower,
  Sun,
  User
} from 'lucide-react'
import type { IpcOutput } from '@shared/ipc/contract'
import type { Settings } from '@shared/schemas/app-config'
import type { SyncProgress } from '@shared/schemas/media-index'
import type { UpdateState } from '@shared/schemas/updates'
import { applyLanguageSetting, type LanguageSetting } from '../i18n'
import { applyThemeSetting, currentTheme, onThemeChange, type ResolvedTheme } from '../theme'
import { ipcInvoke, ipcOn } from '../ipc'
import { playerLabel } from '../playerLabel'
import TourButton from '../tour/TourButton'
import brandMark from '../assets/brand/mark.svg'

type SourceStatus = IpcOutput<'playback:sources'>[number]

/**
 * The window's own title bar. The native one is a grey strip with nothing to do
 * with the rest of the window, so it is hidden and this runs to the edge; the
 * system buttons are overlaid on the right and the bar reserves their width
 * through `env(titlebar-area-*)`.
 *
 * What lives here is what you check or flip from anywhere: whether the forum
 * session is live, the script-player entry, and the two switches people
 * actually reach for. Everything else stays in settings.
 */

const LANGS: { key: LanguageSetting; label: string }[] = [
  { key: 'system', label: '—' },
  { key: 'en', label: 'English' },
  { key: 'zh-CN', label: '中文' },
  { key: 'ja', label: '日本語' },
  { key: 'fr', label: 'Français' },
  { key: 'de', label: 'Deutsch' }
]

/*
 * The system draws the window buttons itself and they cannot inherit CSS, so
 * the colours are handed over. The background stays transparent: this bar is
 * glass over a coloured backdrop, and any flat fill behind the buttons showed
 * as a patch that did not belong. Only the symbols need a colour, and they
 * need one dark enough to read against the bar.
 */
function overlayColors(theme: ResolvedTheme): { color: string; symbolColor: string } {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback
  return {
    color: '#00000000',
    symbolColor: read('--text-primary', theme === 'dark' ? '#f2f4f8' : '#161a24')
  }
}

export default function TopBar({
  onToggleScriptPlayer,
  onToggleSources,
  onOpenUpdates,
  scriptPlayerActive,
  scriptPlayerDetached,
  sourcesActive
}: {
  onToggleScriptPlayer: () => void
  onToggleSources: () => void
  onOpenUpdates: () => void
  scriptPlayerActive: boolean
  scriptPlayerDetached: boolean
  sourcesActive: boolean
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme())
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [langOpen, setLangOpen] = useState(false)
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [update, setUpdate] = useState<UpdateState | null>(null)
  /** Libraries still being scanned, by id; empty means nothing is running. */
  const [scans, setScans] = useState<Record<string, SyncProgress>>({})

  /*
   * A library scan that outlived the startup card. The window is fully usable
   * while it runs, so all this owes the user is a sign that the app is still
   * working — on whichever page they are on, not only the media one.
   */
  useEffect(
    () =>
      ipcOn('event:sync-progress', (p) =>
        setScans((current) => {
          if (p.phase === 'done') {
            if (!(p.libraryId in current)) return current
            const rest = { ...current }
            delete rest[p.libraryId]
            return rest
          }
          return { ...current, [p.libraryId]: p }
        })
      ),
    []
  )

  useEffect(() => {
    ipcInvoke('settings:get').then(setSettings).catch(() => {})
    ipcInvoke('scrape:loginStatus')
      .then(({ loggedIn }) => setSignedIn(loggedIn))
      .catch(() => setSignedIn(null))
    ipcInvoke('playback:sources').then(setSources).catch(() => {})
    ipcInvoke('updates:state').then(setUpdate).catch(() => {})
    const offSources = ipcOn('event:playback-sources', setSources)
    const offUpdate = ipcOn('event:update-state', setUpdate)
    const offTheme = onThemeChange(setTheme)
    return () => {
      offSources()
      offUpdate()
      offTheme()
    }
  }, [])

  useEffect(() => {
    const colors = overlayColors(theme)
    void ipcInvoke('app:setTitleBarColors', colors).catch(() => {})
  }, [theme, settings?.ui.palette])

  const setTheme_ = (next: 'light' | 'dark'): void => {
    setSettings((cur) => (cur ? { ...cur, ui: { ...cur.ui, theme: next } } : cur))
    applyThemeSetting(next)
    void ipcInvoke('settings:update', { ui: { theme: next } }).catch(() => {})
  }

  const sfw = settings?.ui.sfw ?? false

  /*
   * The marker the stylesheet blurs on. Set here, where the setting is read
   * and flipped, and at start from the saved value — a window that opened
   * sharp for a moment would defeat the point.
   */
  useEffect(() => {
    if (sfw) document.documentElement.dataset['sfw'] = ''
    else delete document.documentElement.dataset['sfw']
  }, [sfw])

  const setSfw = (next: boolean): void => {
    setSettings((cur) => (cur ? { ...cur, ui: { ...cur.ui, sfw: next } } : cur))
    void ipcInvoke('settings:update', { ui: { sfw: next } }).catch(() => {})
  }

  const setLanguage = (next: LanguageSetting): void => {
    setSettings((cur) => (cur ? { ...cur, ui: { ...cur.ui, language: next } } : cur))
    applyLanguageSetting(next)
    setLangOpen(false)
    void ipcInvoke('settings:update', { ui: { language: next } }).catch(() => {})
  }

  const login = (): void => {
    void ipcInvoke('scrape:login')
      .then(({ loggedIn }) => setSignedIn(loggedIn))
      .catch(() => {})
  }

  const current = sources.find((source) => source.current)
  const currentLive = current?.state === 'connected'

  const running = Object.values(scans)
  const scanned = running.reduce((sum, p) => sum + p.processed, 0)
  const scanTotal = running.reduce((sum, p) => sum + p.total, 0)
  const scanPercent = scanTotal > 0 ? Math.round((scanned / scanTotal) * 100) : 0

  return (
    <header className="topbar">
      <span className="topbar-brand">
        <img className="topbar-brand-mark" src={brandMark} alt="" aria-hidden="true" />
        <span>{t('app.title')}</span>
      </span>

      <div className="topbar-actions">
        {/* Only while there is something to do about it; the About page has
            the rest of the story. */}
        {(update?.phase === 'available' || update?.phase === 'ready') && (
          <button className="topbar-btn update-ready" type="button" onClick={onOpenUpdates}>
            <ArrowUpCircle size={14} />
            {update.phase === 'ready' ? t('updates.topbarReady') : t('updates.topbarAvailable')}
          </button>
        )}

        <button
          data-tour="topbar-sources"
          className={`topbar-btn script-player-entry${sourcesActive ? ' active' : ''}`}
          type="button"
          onClick={onToggleSources}
          aria-pressed={sourcesActive}
          title={t('players.title')}
        >
          <MonitorPlay size={14} />
          {playerLabel(current, t)}
          <span className={`topbar-sp-dot${currentLive ? '' : ' off'}`} />
        </button>

        <button
          data-tour="topbar-script-player"
          className={`topbar-btn script-player-entry${scriptPlayerActive ? ' active' : ''}`}
          type="button"
          onClick={onToggleScriptPlayer}
          aria-pressed={scriptPlayerActive}
          title={t('scriptPlayer.title')}
        >
          <RadioTower size={14} />
          {t('scriptPlayer.title')}
          <span className={`topbar-sp-dot${scriptPlayerDetached ? ' detached' : ''}`} />
        </button>

        {signedIn === false ? (
          <button
            data-tour="topbar-session"
            className="topbar-btn warn"
            onClick={login}
            title={t('downloads.login')}
          >
            <LogIn size={14} />
            {t('downloads.login')}
          </button>
        ) : (
          <span
            data-tour="topbar-session"
            className={`topbar-chip${signedIn ? ' ok' : ''}`}
            title={t('topbar.sessionTitle')}
          >
            <User size={14} />
            {signedIn ? t('posts.signedIn') : '—'}
          </span>
        )}

        <button
          className={`topbar-btn${sfw ? ' active' : ''}`}
          onClick={() => setSfw(!sfw)}
          aria-pressed={sfw}
          title={sfw ? t('topbar.sfwOn') : t('topbar.sfwOff')}
          aria-label={sfw ? t('topbar.sfwOn') : t('topbar.sfwOff')}
        >
          {sfw ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>

        <button
          className="topbar-btn"
          onClick={() => setTheme_(theme === 'dark' ? 'light' : 'dark')}
          title={t('topbar.toggleTheme')}
          aria-label={t('topbar.toggleTheme')}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        <div className="topbar-lang">
          {/* A globe and the current language's own name: both read the same to
              someone who cannot read the interface's language. */}
          <button
            className="topbar-btn topbar-lang-btn"
            onClick={() => setLangOpen((v) => !v)}
            title={t('settings.language')}
            aria-haspopup="menu"
            aria-expanded={langOpen}
          >
            <Globe size={14} />
            {LANGS.find((l) => l.key === i18n.language)?.label ?? 'English'}
            <ChevronDown size={12} className="topbar-lang-caret" />
          </button>
          {langOpen && (
            <>
              <div className="topbar-scrim" onClick={() => setLangOpen(false)} />
              <div className="topbar-menu">
                {LANGS.map((l) => (
                  <button
                    key={l.key}
                    className={settings?.ui.language === l.key ? 'on' : ''}
                    onClick={() => setLanguage(l.key)}
                  >
                    {l.key === 'system' ? t('settings.followSystem') : l.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <TourButton />
      </div>

      {running.length > 0 && (
        <div
          className="topbar-sync"
          title={t('topbar.scanning')}
          role="progressbar"
          aria-label={t('topbar.scanning')}
          aria-valuenow={scanPercent}
        >
          <span style={{ width: `${scanPercent}%` }} />
        </div>
      )}
    </header>
  )
}
