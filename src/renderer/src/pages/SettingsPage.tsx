import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/schemas/app-config'
import type { BinaryId, BinaryStatus, InstallProgress } from '@shared/schemas/dependencies'
import type { IpcOutput } from '@shared/ipc/contract'
import { isSupportedProxy } from '@shared/url'
import { applyLanguageSetting, type LanguageSetting } from '../i18n'
import { applyThemeSetting, type ThemeSetting } from '../theme'
import HosterBadge from '../components/HosterBadge'
import PaletteEditor from '../components/PaletteEditor'
import StartupArtworkSettings from '../components/StartupArtworkSettings'
import Select from '../components/Select'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { showToast } from '../toasts'

type SessionDir = IpcOutput<'playback:sessionDirs'>[number]
type PluginStatus = IpcOutput<'playback:mfpPluginStatus'>

/**
 * Settings. Top row is what has to be in place before anything works —
 * the EroScripts session, and the UI language beside it. Below that, two
 * columns while the window is wide enough: players on the left, the pieces
 * downloading needs on the right.
 *
 * Path inputs save on blur/pick; selects save immediately and apply on the spot.
 */

/** Grouped so each tab answers one question, rather than one long wall. */
const SECTIONS = ['general', 'appearance', 'playback'] as const
export type Section = (typeof SECTIONS)[number]

export interface SettingsNavigationRequest {
  section: Section
  /** A card to scroll to once the section is up, for requests that want one. */
  target?: 'scriptRoute'
  nonce: number
}

export default function SettingsPage({
  onOpenScriptPlayer,
  navigationRequest
}: {
  onOpenScriptPlayer?: () => void
  navigationRequest?: SettingsNavigationRequest | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [tab, setTab] = useState<Section>(navigationRequest?.section ?? 'general')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [mfpPath, setMfpPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [detectResult, setDetectResult] = useState<'found' | 'notFound' | null>(null)
  const [sessionDirs, setSessionDirs] = useState<SessionDir[]>([])
  const [plugin, setPlugin] = useState<PluginStatus | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)
  const [installMsg, setInstallMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [pluginBusy, setPluginBusy] = useState(false)
  const scriptRouteCard = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (navigationRequest) setTab(navigationRequest.section)
  }, [navigationRequest])

  const settingsReady = settings !== null
  useEffect(() => {
    if (navigationRequest?.target !== 'scriptRoute' || tab !== 'playback' || !settingsReady)
      return

    const frame = window.requestAnimationFrame(() => {
      scriptRouteCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      scriptRouteCard.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [navigationRequest, settingsReady, tab])

  useEffect(() => {
    ipcInvoke('settings:get')
      .then((s) => {
        setSettings(s)
        setMfpPath(s.playback.mfpExePath)
      })
      .catch((e) => setError(toMessage(e)))
  }, [toMessage])

  const refreshPlugin = (): void => {
    ipcInvoke('playback:mfpPluginStatus').then(setPlugin).catch(() => setPlugin(null))
  }

  const scriptRoute = settings?.playback.scriptRoute ?? 'internal'

  // MFP integration data: session dirs to register + control plugin status.
  // Only while MFP is the chosen route — probing a program the user has not
  // opted into is exactly what this release set out to stop doing.
  useEffect(() => {
    if (scriptRoute !== 'mfp') return
    ipcInvoke('playback:sessionDirs').then(setSessionDirs).catch(() => setSessionDirs([]))
    refreshPlugin()
    // Re-check the plugin when MFP comes up/goes down (conn indicator changes).
    return ipcOn('event:conn-status', () => refreshPlugin())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptRoute])

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(path)
      setTimeout(() => setCopiedPath((cur) => (cur === path ? null : cur)), 1500)
    } catch {
      // clipboard unavailable — the path stays visible for manual copy
    }
  }

  const installPlugin = async (): Promise<void> => {
    setPluginBusy(true)
    setInstallMsg(null)
    try {
      const res = await ipcInvoke('playback:installMfpPlugin', {})
      if (res.ok) {
        setInstallMsg({ kind: 'ok', text: t('settings.mfp.installOk') })
        refreshPlugin()
      } else {
        setInstallMsg({
          kind: 'err',
          text: t(res.reason === 'mfp_not_found' ? 'settings.mfp.installNoMfp' : 'settings.mfp.installFailed')
        })
      }
    } catch (e) {
      setInstallMsg({ kind: 'err', text: toMessage(e) })
    } finally {
      setPluginBusy(false)
    }
  }

  // Installing only copies the file; MFP compiles plugins when it loads them.
  const restartMfp = async (): Promise<void> => {
    setPluginBusy(true)
    setInstallMsg(null)
    try {
      const { status } = await ipcInvoke('playback:restartMfp')
      setInstallMsg({
        kind: status === 'restarted' || status === 'launched' ? 'ok' : 'err',
        text: t(`settings.mfp.restart.${status}`)
      })
      // Compiling + binding takes a moment; re-check once it should be up.
      setTimeout(refreshPlugin, 6000)
    } catch (e) {
      setInstallMsg({ kind: 'err', text: toMessage(e) })
    } finally {
      setPluginBusy(false)
    }
  }

  const patch = async (p: Record<string, unknown>): Promise<void> => {
    try {
      const s = await ipcInvoke('settings:update', p)
      setSettings(s)
    } catch (e) {
      // The control that changed can be anywhere down a long page.
      showToast({ message: toMessage(e) })
    }
  }

  const saveMfpPath = (value: string): void => {
    setMfpPath(value)
    if (value !== settings?.playback.mfpExePath) void patch({ playback: { mfpExePath: value } })
  }

  const browseMfp = async (): Promise<void> => {
    const { path } = await ipcInvoke('dialog:pickFile', { title: t('settings.mfpPath') })
    if (path) saveMfpPath(path)
  }

  const autoDetectMfp = async (): Promise<void> => {
    const { path } = await ipcInvoke('playback:detectMfp')
    setDetectResult(path ? 'found' : 'notFound')
    if (path) saveMfpPath(path)
  }

  const changeLanguage = (value: LanguageSetting): void => {
    void patch({ ui: { language: value } })
    applyLanguageSetting(value)
  }
  const changeTheme = (value: ThemeSetting): void => {
    void patch({ ui: { theme: value } })
    applyThemeSetting(value)
  }

  if (!settings) {
    return (
      <>
        <h1 className="page-title">{t('nav.settings')}</h1>
        {error && <div className="error-banner">{error}</div>}
      </>
    )
  }

  return (
    <div className="settings-page">
      <h1 className="page-title">{t('nav.settings')}</h1>

      <div className="settings-tabs">
        {SECTIONS.map((key) => (
          <button
            key={key}
            className={`settings-tab${tab === key ? ' on' : ''}`}
            onClick={() => setTab(key)}
          >
            {t(`settings.tab.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'general' && (
      <>
      {/* Five short cards on one line while the page is wide, fewer per line
          as it narrows; the long cards get their own row below. */}
      <div className="settings-row">
          <EroScriptsCard />

          <div className="card">
            <h2 className="settings-section-title">{t('settings.downloads.title')}</h2>
            <div className="settings-field">
              <span className="settings-label">{t('settings.downloads.quality')}</span>
              <Select
                className="block"
                value={settings.download.preferredQuality}
                onChange={(v) => void patch({ download: { preferredQuality: v } })}
                options={[
                  { value: 'best', label: t('settings.downloads.qualityBest') },
                  { value: '2160p', label: '4K' },
                  { value: '1440p', label: '1440p' },
                  { value: '1080p', label: '1080p' },
                  { value: '720p', label: '720p' },
                  { value: '480p', label: '480p' },
                  { value: '360p', label: '360p' }
                ]}
              />
            </div>
            <div className="settings-field">
              <span className="settings-label">{t('settings.downloads.linkCheck')}</span>
              <Select
                className="block"
                value={settings.download.linkCheck}
                onChange={(v) => void patch({ download: { linkCheck: v } })}
                options={[
                  { value: 'all', label: t('settings.downloads.linkCheckAll') },
                  { value: 'cheap', label: t('settings.downloads.linkCheckCheap') },
                  { value: 'off', label: t('settings.downloads.linkCheckOff') }
                ]}
              />
            </div>
            <GofileFields
              value={settings.download.gofile}
              onSave={(gofile) => void patch({ download: { gofile } })}
            />
          </div>

          <NetworkCard settings={settings} onPatch={patch} />

          <div className="card">
            <h2 className="settings-section-title">{t('settings.library.title')}</h2>
            <div className="settings-field">
              <span className="settings-label">{t('settings.library.companionMatch')}</span>
              <Select
                className="block"
                value={settings.library.companionMatch}
                onChange={(v) => void patch({ library: { companionMatch: v } })}
                options={[
                  { value: 'exact', label: t('settings.library.matchExact') },
                  { value: 'separators', label: t('settings.library.matchSeparators') },
                  { value: 'affixes', label: t('settings.library.matchAffixes') },
                  { value: 'loose', label: t('settings.library.matchLoose') }
                ]}
              />
              <p className="settings-hint">{t('settings.library.companionMatchHint')}</p>
            </div>
          </div>

        <div className="card">
          <h2 className="settings-section-title">{t('settings.uiSection')}</h2>
          <div className="settings-inline">
            <div className="settings-field">
              <span className="settings-label">{t('settings.language')}</span>
              <Select
                className="block"
                value={settings.ui.language}
                onChange={(v) => changeLanguage(v as LanguageSetting)}
                options={[
                  { value: 'system', label: t('settings.followSystem') },
                  { value: 'en', label: 'English' },
                  { value: 'zh-CN', label: '中文' },
                  { value: 'ja', label: '日本語' },
                  { value: 'fr', label: 'Français' },
                  { value: 'de', label: 'Deutsch' }
                ]}
              />
            </div>

            <div className="settings-field">
              <span className="settings-label">{t('settings.theme')}</span>
              <Select
                className="block"
                value={settings.ui.theme}
                onChange={(v) => changeTheme(v as ThemeSetting)}
                options={[
                  { value: 'system', label: t('settings.followSystem') },
                  { value: 'light', label: t('settings.themeLight') },
                  { value: 'dark', label: t('settings.themeDark') }
                ]}
              />
            </div>

            {/* Only asked when a player is in a window of its own; this is
                where an answer given once can be taken back. */}
            <div className="settings-field">
              <span className="settings-label">{t('settings.onCloseMainWindow')}</span>
              <Select
                className="block"
                value={settings.ui.onCloseMainWindow}
                onChange={(v) => void patch({ ui: { onCloseMainWindow: v } })}
                options={[
                  { value: 'ask', label: t('settings.onClose.ask') },
                  { value: 'closePlayers', label: t('settings.onClose.closePlayers') },
                  { value: 'keepPlayers', label: t('settings.onClose.keepPlayers') }
                ]}
              />
            </div>
          </div>

        </div>
      </div>

      {/* Two long cards side by side while there is room for both. */}
      <div className="settings-row long">
        <DependenciesCard settings={settings} onPatch={patch} />
        <SiteLoginCard />
        <MegaCard settings={settings} onPatch={patch} />
      </div>
      </>
      )}

      {tab === 'appearance' && (
      <div className="settings-row appearance">
        <StartupArtworkSettings
          value={settings.ui.startupArtwork}
          libraryId={settings.ui.mediaLibraryId}
          onChange={(startupArtwork) => patch({ ui: { startupArtwork } })}
        />
        <div className="card">
          <h2 className="settings-section-title">{t('settings.palette.title')}</h2>
          <PaletteEditor
            value={settings.ui.palette}
            onChange={(palette) => void patch({ ui: { palette } })}
          />
        </div>
      </div>
      )}

      {tab === 'playback' && (
      <div className="settings-row playback">
          <div className="card settings-route-card" ref={scriptRouteCard} tabIndex={-1}>
            <h2 className="settings-section-title">{t('settings.scriptRoute.title')}</h2>
            <p className="settings-hint">{t('settings.scriptRoute.exclusiveHint')}</p>
            <div className="route-choice">
              {(['internal', 'mfp'] as const).map((route) => (
                <label key={route} className={`route-option${scriptRoute === route ? ' on' : ''}`}>
                  <input
                    type="radio"
                    name="script-route"
                    checked={scriptRoute === route}
                    onChange={() => void patch({ playback: { scriptRoute: route } })}
                  />
                  <span className="route-text">
                    <span className="route-name">{t(`settings.scriptRoute.${route}`)}</span>
                    <span className="route-hint">{t(`settings.scriptRoute.${route}Hint`)}</span>
                  </span>
                </label>
              ))}
            </div>
            {scriptRoute === 'internal' && onOpenScriptPlayer && (
              <div className="row">
                <button className="ghost" onClick={onOpenScriptPlayer}>
                  {t('scriptPlayer.open')}
                </button>
              </div>
            )}
          </div>



          {scriptRoute === 'mfp' && (
          <div className="card mfp-card">
            <h2 className="settings-section-title">{t('settings.mfp.title')}</h2>
            <p className="settings-hint">{t('settings.mfp.pluginHint')}</p>

            {/* Where the program is, and what state its plugin is in: two
                separate things, so they sit side by side once the card is
                wide enough for both. */}
            <div className="mfp-split">
              <label className="settings-field mfp-where">
                <span className="settings-label">{t('settings.mfpPath')}</span>
                <div className="row mfp-path-row">
                  <input
                    className="settings-input grow"
                    type="text"
                    value={mfpPath}
                    placeholder={t('settings.mfpPathPlaceholder')}
                    onChange={(e) => setMfpPath(e.target.value)}
                    onBlur={(e) => saveMfpPath(e.target.value.trim())}
                  />
                  <button className="ghost" onClick={() => void browseMfp()}>
                    {t('settings.browse')}
                  </button>
                  <button className="ghost" onClick={() => void autoDetectMfp()}>
                    {t('settings.autoDetect')}
                  </button>
                </div>
                <span className="settings-hint">{t('settings.autoDetectHint')}</span>
                {detectResult === 'notFound' && (
                  <span className="settings-hint">{t('settings.mfpNotFound')}</span>
                )}
              </label>

              <div className="mfp-plugin">
                <div className="row mfp-plugin-row">
                  <span className={`mfp-plugin-status ${plugin?.reachable ? 'ok' : plugin?.installed ? 'warn' : 'off'}`}>
                    {plugin?.reachable
                      ? t('settings.mfp.pluginReachable', { version: plugin.version ?? '?' })
                      : plugin?.installed
                        ? t('settings.mfp.pluginInstalled')
                        : t('settings.mfp.pluginMissing')}
                  </span>
                  <div className="grow" />
                  <button className="ghost" onClick={() => void restartMfp()} disabled={pluginBusy}>
                    {t('settings.mfp.restartMfp')}
                  </button>
                  <button className="primary" onClick={() => void installPlugin()} disabled={pluginBusy}>
                    {plugin?.installed ? t('settings.mfp.reinstall') : t('settings.mfp.install')}
                  </button>
                </div>
                <p className="settings-hint">{t('settings.mfp.restartHint')}</p>
                {installMsg && (
                  <p className={installMsg.kind === 'ok' ? 'settings-hint' : 'mfp-install-error'}>
                    {installMsg.text}
                  </p>
                )}
                <p className="settings-hint mfp-tip">{t('settings.mfp.recommended')}</p>
              </div>
            </div>

            <details className="mfp-alt">
              <summary>{t('settings.mfp.altSummary')}</summary>
              <p className="settings-hint">{t('settings.mfp.foldersHint')}</p>
              {sessionDirs.length === 0 ? (
                <p className="settings-hint">{t('settings.mfp.noLibraries')}</p>
              ) : (
                <ul className="mfp-dir-list">
                  {sessionDirs.map((d) => (
                    <li key={d.libraryId} className="mfp-dir-row">
                      <span className="mfp-dir-name">{d.name}</span>
                      <code className="mfp-dir-path" title={d.path}>
                        {d.path}
                      </code>
                      <button className="ghost mfp-copy" onClick={() => void copyPath(d.path)}>
                        {copiedPath === d.path ? t('settings.mfp.copied') : t('settings.mfp.copy')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
          )}
      </div>
      )}

    </div>
  )
}

/** The rate limit is stored in bytes per second and shown in MB/s. */
const MB = 1024 * 1024

/**
 * Proxy and transfer limit. Both reach every part of the app that touches the
 * network, including yt-dlp — which is a separate process and has to be told
 * on its command line.
 */
function NetworkCard({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Record<string, unknown>) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { proxyUrl, rateLimit } = settings.download
  const [proxy, setProxy] = useState(proxyUrl)
  const [speed, setSpeed] = useState(
    rateLimit.bytesPerSec ? String(+(rateLimit.bytesPerSec / MB).toFixed(2)) : ''
  )
  const proxyValid = isSupportedProxy(proxy)

  const saveProxy = (value: string): void => {
    if (!isSupportedProxy(value) || value === proxyUrl) return
    void onPatch({ download: { proxyUrl: value } })
  }

  const saveSpeed = (value: string): void => {
    const mb = Number(value)
    const bytesPerSec = Number.isFinite(mb) && mb > 0 ? Math.round(mb * MB) : 0
    if (bytesPerSec === rateLimit.bytesPerSec) return
    void onPatch({ download: { rateLimit: { ...rateLimit, bytesPerSec } } })
  }

  return (
    <div className="card">
      <h2 className="settings-section-title">{t('settings.network.title')}</h2>

      <label className="settings-field">
        <span className="settings-label">{t('settings.network.proxy')}</span>
        <input
          className="settings-input"
          type="text"
          value={proxy}
          placeholder={t('settings.network.proxyPlaceholder')}
          onChange={(e) => setProxy(e.target.value)}
          onBlur={(e) => saveProxy(e.target.value.trim())}
        />
        {!proxyValid && <span className="settings-error">{t('settings.network.proxyInvalid')}</span>}
      </label>

      <div className="settings-field">
        <span className="settings-label">{t('settings.network.limit')}</span>
        <div className="row limit-row">
          <Select
            className="grow"
            value={rateLimit.mode}
            onChange={(v) => void onPatch({ download: { rateLimit: { ...rateLimit, mode: v } } })}
            options={[
              { value: 'off', label: t('settings.network.limitOff') },
              { value: 'perTask', label: t('settings.network.limitPerTask') },
              { value: 'total', label: t('settings.network.limitTotal') }
            ]}
          />
          <input
            className="settings-input speed"
            type="number"
            min="0"
            step="0.5"
            disabled={rateLimit.mode === 'off'}
            value={speed}
            placeholder="0"
            onChange={(e) => setSpeed(e.target.value)}
            onBlur={(e) => saveSpeed(e.target.value.trim())}
          />
          <span className="settings-unit">MB/s</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Signing in to a download source. The window is the site's own page on the
 * app's session, so what it leaves behind is used by the page parsers directly
 * and handed to yt-dlp for the length of one download.
 */
function SiteLoginCard(): React.JSX.Element {
  const { t } = useTranslation()
  const [sites, setSites] = useState<IpcOutput<'sites:list'>['sites']>([])
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = (): void => {
    ipcInvoke('sites:list')
      .then((r) => setSites(r.sites))
      .catch(() => setSites([]))
  }

  useEffect(refresh, [])

  const act = async (id: string, channel: 'sites:login' | 'sites:signOut'): Promise<void> => {
    setBusy(id)
    try {
      await ipcInvoke(channel, { id })
    } finally {
      setBusy(null)
      refresh()
    }
  }

  const row = (site: (typeof sites)[number]): React.JSX.Element => (
    <div key={site.id} className="site-row">
      <HosterBadge hoster={site.id} label={site.label} />
      <span className="site-need">
        {site.signedIn ? t('settings.sites.saved') : t(`settings.sites.need.${site.need}`)}
      </span>
      <div className="grow" />
      <button
        className="ghost"
        disabled={busy !== null}
        onClick={() => void act(site.id, site.signedIn ? 'sites:signOut' : 'sites:login')}
      >
        {t(site.signedIn ? 'settings.sites.signOut' : 'settings.sites.signIn')}
      </button>
    </div>
  )

  // Sources that need an account come first; the rest fold away, because a
  // working install never has to touch them.
  const required = sites.filter((s) => s.need === 'some' || s.signedIn)
  const optional = sites.filter((s) => s.need === 'no' && !s.signedIn)

  return (
    <div className="card">
      <h2 className="settings-section-title">{t('settings.sites.title')}</h2>
      <p className="settings-hint">{t('settings.sites.hint')}</p>
      {required.map(row)}
      {optional.length > 0 && (
        <details className="settings-sub">
          <summary>{t('settings.sites.optionalSummary', { count: optional.length })}</summary>
          <p className="settings-hint">{t('settings.sites.optionalHint')}</p>
          {optional.map(row)}
        </details>
      )}
    </div>
  )
}

/**
 * How MEGA links download: here, signed out, or through MEGAcmd — MEGA's own
 * client, which uses whatever account the user signs in to inside it. MEGAcmd
 * is only asked about while it is the chosen method; asking starts its
 * background server.
 */
function MegaCard({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Record<string, unknown>) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const mega = settings.download.mega
  const [connections, setConnections] = useState(String(mega.connections))
  const [path, setPath] = useState(mega.megacmdPath)
  const [cmd, setCmd] = useState<IpcOutput<'megacmd:status'> | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ phase: string; bytesDownloaded: number; totalBytes: number | null } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const useCmd = mega.method === 'megacmd'

  const refresh = useCallback((): void => {
    ipcInvoke('megacmd:status')
      .then(setCmd)
      .catch(() => setCmd(null))
  }, [])

  useEffect(() => {
    if (!useCmd) return
    refresh()
    // Signing in happens in MEGAcmd's own window; coming back is the moment
    // to find out whether it worked.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [useCmd, refresh])
  useEffect(() => ipcOn('event:megacmd-progress', (p) => setProgress(p)), [])

  const saveConnections = (value: string): void => {
    const n = Math.round(Number(value))
    const next = Number.isFinite(n) ? Math.min(64, Math.max(2, n)) : mega.connections
    setConnections(String(next))
    if (next !== mega.connections) void onPatch({ download: { mega: { connections: next } } })
  }

  const savePath = (value: string): void => {
    setPath(value)
    if (value !== mega.megacmdPath) void onPatch({ download: { mega: { megacmdPath: value } } }).then(refresh)
  }

  const pickPath = async (): Promise<void> => {
    const picked = await ipcInvoke('dialog:pickDirectory', { title: t('settings.mega.path') })
    if (picked.path) savePath(picked.path)
  }

  const install = async (): Promise<void> => {
    setBusy(true)
    setFailed(null)
    setProgress(null)
    try {
      setCmd(await ipcInvoke('megacmd:install'))
    } catch (e) {
      setFailed(toMessage(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const installText = (): string => {
    if (!busy) return t('settings.deps.install')
    if (progress?.phase === 'installing') return t('settings.mega.installing')
    return progress?.totalBytes
      ? `${Math.floor((progress.bytesDownloaded / progress.totalBytes) * 100)}%`
      : t('settings.deps.working')
  }

  return (
    <div className="card">
      <h2 className="settings-section-title">MEGA</h2>

      <div className="settings-field">
        <span className="settings-label">{t('settings.mega.method')}</span>
        <Select
          value={mega.method}
          onChange={(v) => void onPatch({ download: { mega: { method: v } } })}
          options={[
            { value: 'builtin', label: t('settings.mega.builtin') },
            { value: 'megacmd', label: 'MEGAcmd' }
          ]}
        />
      </div>

      {!useCmd && (
        <label className="settings-field">
          <span className="settings-label">{t('settings.mega.connections')}</span>
          <input
            className="settings-input speed"
            type="number"
            min="2"
            max="64"
            step="1"
            value={connections}
            onChange={(e) => setConnections(e.target.value)}
            onBlur={(e) => saveConnections(e.target.value.trim())}
          />
          <span className="settings-hint">{t('settings.mega.connectionsHint')}</span>
        </label>
      )}

      {useCmd && (
        <>
          <div className="dep-row">
            <span className={`dep-dot ${cmd?.installed ? 'ok' : 'off'}`} />
            <span className="dep-name">MEGAcmd</span>
            <span className="dep-version">
              {cmd === null
                ? t('settings.deps.working')
                : cmd.installed
                  ? t('settings.deps.installed', { version: cmd.version ?? '?' })
                  : t('settings.deps.notInstalled')}
            </span>
            {cmd && !cmd.installed && (
              <button className="primary" disabled={busy} onClick={() => void install()}>
                {installText()}
              </button>
            )}
          </div>
          {failed && <p className="mfp-install-error">{failed}</p>}

          {cmd?.installed && (
            <div className="site-row">
              <span className="site-need">
                {cmd.account
                  ? t('settings.mega.signedInAs', { account: cmd.account })
                  : t('settings.mega.signedOut')}
              </span>
              <div className="grow" />
              {!cmd.account && (
                <button className="ghost" onClick={() => void ipcInvoke('megacmd:login').catch(() => {})}>
                  {t('settings.sites.signIn')}
                </button>
              )}
            </div>
          )}
          {cmd?.installed && !cmd.account && <p className="settings-hint">{t('settings.mega.signInHint')}</p>}

          <details className="mfp-alt">
            <summary>{t('settings.deps.customPaths')}</summary>
            <label className="settings-field">
              <span className="settings-label">{t('settings.mega.path')}</span>
              <div className="row">
                <input
                  className="settings-input grow"
                  type="text"
                  value={path}
                  placeholder={t('settings.deps.pathPlaceholder')}
                  onChange={(e) => setPath(e.target.value)}
                  onBlur={(e) => savePath(e.target.value.trim())}
                />
                <button className="ghost" onClick={() => void pickPath()}>
                  {t('settings.browse')}
                </button>
              </div>
            </label>
          </details>
        </>
      )}
    </div>
  )
}

/**
 * yt-dlp and ffmpeg: install or update them from here rather than making the
 * user go find them. The download URL is editable because GitHub is slow or
 * blocked in places, and a custom path is there for people who keep their own.
 */
function DependenciesCard({
  settings,
  onPatch
}: {
  settings: Settings
  onPatch: (patch: Record<string, unknown>) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [binaries, setBinaries] = useState<BinaryStatus[] | null>(null)
  const [busy, setBusy] = useState<BinaryId | null>(null)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [urls, setUrls] = useState({
    ytdlp: settings.dependencies.ytdlpUrl,
    ffmpeg: settings.dependencies.ffmpegUrl
  })
  const [paths, setPaths] = useState({
    ytdlp: settings.dependencies.ytdlpPath,
    ffmpeg: settings.dependencies.ffmpegPath
  })

  const refresh = (): void => {
    ipcInvoke('deps:status')
      .then((r) => setBinaries(r.binaries))
      .catch(() => setBinaries([]))
  }

  useEffect(refresh, [])
  useEffect(() => ipcOn('event:dep-progress', (p) => setProgress(p)), [])

  const install = async (id: BinaryId): Promise<void> => {
    setBusy(id)
    setFailed(null)
    setProgress(null)
    try {
      const { binary } = await ipcInvoke('deps:install', { id })
      setBinaries((cur) => (cur ?? []).map((b) => (b.id === binary.id ? binary : b)))
    } catch (e) {
      setFailed(toMessage(e))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const saveUrl = (id: BinaryId, value: string): void => {
    setUrls((cur) => ({ ...cur, [id]: value }))
    const key = id === 'ytdlp' ? 'ytdlpUrl' : 'ffmpegUrl'
    if (value !== settings.dependencies[key]) void onPatch({ dependencies: { [key]: value } })
  }

  const savePath = (id: BinaryId, value: string): void => {
    setPaths((cur) => ({ ...cur, [id]: value }))
    const key = id === 'ytdlp' ? 'ytdlpPath' : 'ffmpegPath'
    if (value !== settings.dependencies[key]) {
      void onPatch({ dependencies: { [key]: value } }).then(refresh)
    }
  }

  const pickPath = async (id: BinaryId): Promise<void> => {
    const { path } = await ipcInvoke('dialog:pickFile', { title: t(`settings.deps.${id}Path`) })
    if (path) savePath(id, path)
  }

  const label = (id: BinaryId): string => (id === 'ytdlp' ? 'yt-dlp' : 'ffmpeg')

  const buttonText = (b: BinaryStatus, ours: boolean): string => {
    if (busy === b.id) {
      if (progress?.id !== b.id) return t('settings.deps.working')
      if (progress.phase === 'extracting') return t('settings.deps.extracting')
      const pct = progress.totalBytes
        ? Math.floor((progress.bytesDownloaded / progress.totalBytes) * 100)
        : null
      return pct === null ? t('settings.deps.working') : `${pct}%`
    }
    return ours && b.version ? t('settings.deps.update') : t('settings.deps.install')
  }

  return (
    <div className="card">
      <h2 className="settings-section-title">{t('settings.deps.title')}</h2>

      {(binaries ?? []).map((b) => {
        // Ours to update only when it is the copy we installed (or one the
        // user pointed us at). A build that came with the app or sits on PATH
        // has a version string from a different world — comparing it with a
        // GitHub release would be noise, so we just say what we found and
        // offer to install a copy we can keep current.
        const ours = b.source === 'managed' || b.source === 'configured'
        return (
          <div key={b.id} data-tour={`dep-${b.id}`} className={`dep-row ${b.id}`}>
            <span className={`dep-dot ${b.version ? 'ok' : 'off'}`} />
            <span className="dep-name">{label(b.id)}</span>
            <span className="dep-version" title={b.version ?? ''}>
              {b.version
                ? t(ours ? 'settings.deps.installed' : 'settings.deps.detected', { version: b.version })
                : t('settings.deps.notInstalled')}
              {ours && b.latest && (
                <span className="dep-latest">{t('settings.deps.latest', { version: b.latest })}</span>
              )}
            </span>
            {b.hasUpdate && <span className="badge dep-update">{t('settings.deps.hasUpdate')}</span>}
            <button
              className={ours && b.version ? 'ghost' : 'primary'}
              disabled={busy !== null}
              onClick={() => void install(b.id)}
            >
              {buttonText(b, ours)}
            </button>
          </div>
        )
      })}
      {failed && <p className="mfp-install-error">{failed}</p>}

      <details className="mfp-alt">
        <summary>{t('settings.deps.mirrors')}</summary>
        {(['ytdlp', 'ffmpeg'] as BinaryId[]).map((id) => (
          <label key={id} className="settings-field">
            <span className="settings-label">{t(`settings.deps.${id}Url`)}</span>
            <input
              className="settings-input dep-url"
              type="text"
              value={urls[id]}
              placeholder={t(`settings.deps.${id}UrlPlaceholder`)}
              onChange={(e) => setUrls((cur) => ({ ...cur, [id]: e.target.value }))}
              onBlur={(e) => saveUrl(id, e.target.value.trim())}
            />
          </label>
        ))}
      </details>

      <details className="mfp-alt">
        <summary>{t('settings.deps.customPaths')}</summary>
        {(['ytdlp', 'ffmpeg'] as BinaryId[]).map((id) => (
          <label key={id} className="settings-field">
            <span className="settings-label">{t(`settings.deps.${id}Path`)}</span>
            <div className="row">
              <input
                className="settings-input grow"
                type="text"
                value={paths[id]}
                placeholder={t('settings.deps.pathPlaceholder')}
                onChange={(e) => setPaths((cur) => ({ ...cur, [id]: e.target.value }))}
                onBlur={(e) => savePath(id, e.target.value.trim())}
              />
              <button className="ghost" onClick={() => void pickPath(id)}>
                {t('settings.browse')}
              </button>
            </div>
          </label>
        ))}
      </details>
    </div>
  )
}

/**
 * EroScripts sign-in state. Downloading from a post only needs this for
 * gated (adult) sections, so the card stays quiet: it says whether a session
 * exists and lets the user start or drop one. The app never sees credentials —
 * the button opens the forum's own login page.
 */
function EroScriptsCard(): React.JSX.Element {
  const { t } = useTranslation()
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = (): void => {
    ipcInvoke('scrape:loginStatus')
      .then(({ loggedIn: ok }) => setLoggedIn(ok))
      .catch(() => setLoggedIn(null))
  }

  useEffect(refresh, [])

  const act = async (channel: 'scrape:login' | 'scrape:logout'): Promise<void> => {
    setBusy(true)
    try {
      await ipcInvoke(channel)
    } catch {
      /* the status line below is the feedback that matters */
    } finally {
      setBusy(false)
      refresh()
    }
  }

  return (
    <div className="card">
      <h2 className="settings-section-title">{t('settings.eroscripts.title')}</h2>
      <div className="eros-row">
        <span className={`eros-status ${loggedIn ? 'ok' : 'off'}`}>
          {loggedIn === null
            ? '…'
            : loggedIn
              ? t('settings.eroscripts.signedIn')
              : t('settings.eroscripts.signedOut')}
        </span>
        {loggedIn ? (
          <button className="ghost" disabled={busy} onClick={() => void act('scrape:logout')}>
            {t('settings.eroscripts.signOut')}
          </button>
        ) : (
          <button className="primary" disabled={busy} onClick={() => void act('scrape:login')}>
            {t('settings.eroscripts.signIn')}
          </button>
        )}
      </div>
      <p className="settings-hint">{t('settings.eroscripts.hint')}</p>
    </div>
  )
}

/**
 * gofile's access values. Folded away because a working install never
 * needs them: the app derives the token itself. They exist for the day gofile
 * rotates its scheme — the user can paste a replacement, or a URL that carries
 * one, without waiting for a new build.
 *
 * Saves on blur, like every other text field on this page.
 */
function GofileFields({
  value,
  onSave
}: {
  value: Settings['download']['gofile']
  onSave: (gofile: Settings['download']['gofile']) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(value)

  useEffect(() => setDraft(value), [value])

  const commit = (): void => {
    if (draft.websiteToken !== value.websiteToken || draft.salt !== value.salt || draft.configUrl !== value.configUrl) {
      onSave(draft)
    }
  }

  const field = (
    key: keyof Settings['download']['gofile'],
    label: string,
    placeholder: string
  ): React.JSX.Element => (
    <label className="settings-field">
      <span className="settings-label">{label}</span>
      <input
        className="settings-input grow"
        value={draft[key]}
        placeholder={placeholder}
        onChange={(e) => setDraft((cur) => ({ ...cur, [key]: e.target.value }))}
        onBlur={commit}
      />
    </label>
  )

  return (
    <details className="settings-sub">
      <summary>{t('settings.downloads.gofileSummary')}</summary>
      {field('websiteToken', t('settings.downloads.gofileToken'), t('settings.downloads.gofileAuto'))}
      {field('salt', t('settings.downloads.gofileSalt'), t('settings.downloads.gofileAuto'))}
      {field('configUrl', t('settings.downloads.gofileConfigUrl'), t('settings.downloads.gofileNone'))}
    </details>
  )
}
