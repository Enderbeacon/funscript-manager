import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages, LogIn, MonitorPlay, Moon, RadioTower, Sun, User } from 'lucide-react'
import type { IpcOutput } from '@shared/ipc/contract'
import type { Settings } from '@shared/schemas/app-config'
import { applyLanguageSetting, type LanguageSetting } from '../i18n'
import { applyThemeSetting, currentTheme, onThemeChange, type ResolvedTheme } from '../theme'
import { ipcInvoke, ipcOn } from '../ipc'
import { playerLabel } from '../playerLabel'
import TourButton from '../tour/TourButton'

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
  onOpenScriptPlayer,
  onOpenSources,
  scriptPlayerActive,
  scriptPlayerDetached,
  sourcesActive
}: {
  onOpenScriptPlayer: () => void
  onOpenSources: () => void
  scriptPlayerActive: boolean
  scriptPlayerDetached: boolean
  sourcesActive: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [theme, setTheme] = useState<ResolvedTheme>(currentTheme())
  const [signedIn, setSignedIn] = useState<boolean | null>(null)
  const [langOpen, setLangOpen] = useState(false)
  const [sources, setSources] = useState<SourceStatus[]>([])

  useEffect(() => {
    ipcInvoke('settings:get').then(setSettings).catch(() => {})
    ipcInvoke('scrape:loginStatus')
      .then(({ loggedIn }) => setSignedIn(loggedIn))
      .catch(() => setSignedIn(null))
    ipcInvoke('playback:sources').then(setSources).catch(() => {})
    const offSources = ipcOn('event:playback-sources', setSources)
    const offTheme = onThemeChange(setTheme)
    return () => {
      offSources()
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

  return (
    <header className="topbar">
      <span className="topbar-brand">{t('app.title')}</span>

      <div className="topbar-actions">
        <button
          data-tour="topbar-sources"
          className={`topbar-btn script-player-entry${sourcesActive ? ' active' : ''}`}
          type="button"
          onClick={onOpenSources}
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
          onClick={onOpenScriptPlayer}
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
          className="topbar-btn"
          onClick={() => setTheme_(theme === 'dark' ? 'light' : 'dark')}
          title={t('topbar.toggleTheme')}
          aria-label={t('topbar.toggleTheme')}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        <div className="topbar-lang">
          <button
            className="topbar-btn"
            onClick={() => setLangOpen((v) => !v)}
            title={t('settings.language')}
            aria-label={t('settings.language')}
          >
            <Languages size={15} />
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
    </header>
  )
}
