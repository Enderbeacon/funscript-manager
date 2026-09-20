import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  ChevronDown,
  Circle,
  CircleCheck,
  CircleX,
  ExternalLink,
  Link2Off,
  LoaderCircle,
  PlugZap,
  Plus,
  RefreshCcwDot,
  RefreshCw,
  Settings2,
  Trash2,
  Unplug,
  X
} from 'lucide-react'
import type { IpcOutput } from '@shared/ipc/contract'
import { ipcInvoke, ipcOn } from '@/ipc'
import { useErrorMessage } from '@/useErrorMessage'
import { useMainWindowOpen } from '@/useMainWindow'
import Select from '@/components/Select'
import AxisPanel, { ToolPopover } from './AxisPanel'
import RangeSlider from './RangeSlider'
import {
  DEFAULT_AXIS_RANGES,
  SCRIPT_PLAYER_AXES,
  TCODE_CHANNEL_BY_AXIS,
  type ScriptPlayerAxis,
  type TCodeOutputProfile,
  TCodeOutputProfileSchema
} from '../../shared/config'

type PlayerSettings = IpcOutput<'script-player:settings'>
type PlayerStatus = IpcOutput<'script-player:status'>
type Transport = TCodeOutputProfile['transport']

const TRANSPORTS = ['serial', 'udp', 'tcp', 'websocket', 'handy'] as const

const CONNECTION_OPEN_KEY = 'sp-connection-open'

/** Full name, for the moment the user is choosing what to add. */
function transportName(transport: Transport): string {
  switch (transport) {
    case 'handy': return 'The Handy'
    case 'websocket': return 'TCode WebSocket'
    case 'serial': return 'TCode Serial'
    default: return `TCode ${transport.toUpperCase()}`
  }
}

function makeProfile(transport: Transport, number: number): TCodeOutputProfile {
  return {
    id: crypto.randomUUID(),
    name: transport === 'handy' ? `The Handy ${number}` : `TCode ${number}`,
    transport,
    protocol: 'v0.3',
    endpoint: transport === 'serial' || transport === 'handy' ? '' : transport === 'websocket' ? 'ws://127.0.0.1:8000' : transport === 'udp' ? 'tcode.local' : '127.0.0.1',
    port: transport === 'tcp' ? 8080 : 8000,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
    flowControl: 'none',
    dtr: true,
    rts: true,
    connectionKey: '',
    sourceAxis: 'main',
    autoConnect: false,
    updateMode: transport === 'handy' ? 'polled' : 'fixed',
    updateIntervalMs: 10,
    sendDirtyValuesOnly: true,
    offloadElapsedTime: false,
    ranges: Object.fromEntries(
      SCRIPT_PLAYER_AXES.map((axis) => [axis, { ...DEFAULT_AXIS_RANGES[axis] }])
    ) as TCodeOutputProfile['ranges']
  }
}

function formatPosition(ms: number | null): string {
  if (ms === null) return '--:--.---'
  const total = Math.max(0, Math.floor(ms))
  const minutes = Math.floor(total / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(total % 1000).padStart(3, '0')}`
}

export default function ScriptPlayerPanel({
  standalone = false,
  onClose
}: {
  standalone?: boolean
  onClose?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  /** In its own window with no main window left, this is the way back. */
  const mainWindowOpen = useMainWindowOpen()
  const [settings, setSettings] = useState<PlayerSettings | null>(null)
  const [status, setStatus] = useState<PlayerStatus | null>(null)
  const [ports, setPorts] = useState<{ path: string; label: string }[]>([])
  const [adding, setAdding] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The output waiting on a yes before it is removed. */
  const [removing, setRemoving] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [route, setRoute] = useState<'internal' | 'mfp' | null>(null)
  // Connection settings start folded to one line, and stay the way they were
  // last left. One choice for every output: it is about how much of the panel
  // the person wants to see, not about any one device.
  const [connectionOpen, setConnectionOpen] = useState(() => {
    try {
      return window.localStorage.getItem(CONNECTION_OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const settingsRef = useRef<PlayerSettings | null>(null)
  const saveTimers = useRef(new Map<string, number>())
  const previewFrames = useRef(new Map<string, number>())

  const replaceSettings = (next: PlayerSettings): void => {
    settingsRef.current = next
    setSettings(next)
  }

  const toggleConnectionOpen = (): void => {
    setConnectionOpen((current) => {
      try {
        window.localStorage.setItem(CONNECTION_OPEN_KEY, current ? '0' : '1')
      } catch {
        // Remembering the fold is a convenience; losing it is fine.
      }
      return !current
    })
  }

  const refreshPorts = (): void => {
    ipcInvoke('script-player:listSerialPorts')
      .then(({ ports: found }) => setPorts(found))
      .catch(() => setPorts([]))
  }

  // Mount only, and it has to stay that way. This replaces the local settings
  // with what is on disk, while edits reach disk on a debounce — so a re-run
  // during a drag answers with the value from before the drag and yanks the
  // slider out from under the pointer. It also enumerates serial ports, which
  // is not something to do per pointer move.
  useEffect(() => {
    Promise.all([ipcInvoke('script-player:settings'), ipcInvoke('script-player:status')])
      .then(([nextSettings, nextStatus]) => {
        replaceSettings(nextSettings)
        setActiveId((current) => current && nextSettings.outputs.some(({ id }) => id === current)
          ? current
          : nextSettings.outputs[0]?.id ?? null)
        setStatus(nextStatus)
      })
      .catch((caught) => setError(toMessage(caught)))
    refreshPorts()
    // The route is app-level, so it comes from the app's settings rather than
    // the player's own; the status broadcast then keeps this panel honest
    // about whether it is standing down.
    ipcInvoke('settings:get')
      .then((app) => setRoute(app.playback.scriptRoute))
      .catch(() => {})
    return ipcOn('event:script-player-changed', setStatus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    for (const timer of saveTimers.current.values()) window.clearTimeout(timer)
    for (const frame of previewFrames.current.values()) window.cancelAnimationFrame(frame)
  }, [])

  // Escape belongs to the top-most sheet while it is open. Taken in the
  // capture phase so the surface stack does not read the same key and close
  // the whole player out from behind it.
  useEffect(() => {
    if (!adding && !settingsOpen && !removing) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (removing) setRemoving(null)
      else if (settingsOpen) setSettingsOpen(false)
      else setAdding(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [adding, settingsOpen, removing])

  const runtime = useMemo(
    () => new Map(status?.outputs.map((output) => [output.id, output]) ?? []),
    [status]
  )

  const persistProfile = (profile: TCodeOutputProfile, delay = 180): void => {
    const previous = saveTimers.current.get(profile.id)
    if (previous !== undefined) window.clearTimeout(previous)
    // Validation waits for the debounce too. This runs on every pointer move of
    // a range slider, and parsing the whole profile each time is work nobody
    // asked for — only the one that settles is going to be written.
    saveTimers.current.set(profile.id, window.setTimeout(() => {
      saveTimers.current.delete(profile.id)
      const parsed = TCodeOutputProfileSchema.safeParse(profile)
      if (!parsed.success) {
        // Expected while a field is mid-edit (an emptied name, say), so no
        // banner. Without this it would vanish untraceably until a restart.
        console.warn('[script-player] output not saved, invalid:', parsed.error.issues)
        return
      }
      ipcInvoke('script-player:saveOutput', parsed.data)
        .then(() => setError(null))
        .catch((caught) => setError(toMessage(caught)))
    }, delay))
  }

  const changeProfile = (
    id: string,
    update: (current: TCodeOutputProfile) => TCodeOutputProfile,
    delay?: number
  ): TCodeOutputProfile | null => {
    const current = settingsRef.current
    if (!current) return null
    const existing = current.outputs.find((profile) => profile.id === id)
    if (!existing) return null
    const changed = update(existing)
    replaceSettings({
      ...current,
      outputs: current.outputs.map((profile) => profile.id === id ? changed : profile)
    })
    persistProfile(changed, delay)
    return changed
  }

  const previewRanges = (id: string, ranges: TCodeOutputProfile['ranges']): void => {
    const previous = previewFrames.current.get(id)
    if (previous !== undefined) window.cancelAnimationFrame(previous)
    previewFrames.current.set(id, window.requestAnimationFrame(() => {
      previewFrames.current.delete(id)
      ipcInvoke('script-player:previewRanges', { id, ranges })
        .catch((caught) => setError(toMessage(caught)))
    }))
  }

  const changeRange = (
    id: string,
    axis: ScriptPlayerAxis,
    range: TCodeOutputProfile['ranges'][ScriptPlayerAxis]
  ): void => {
    const changed = changeProfile(id, (profile) => ({
      ...profile,
      ranges: { ...profile.ranges, [axis]: range }
    }), 240)
    if (changed) previewRanges(id, changed.ranges)
  }

  const addProfile = (transport: Transport): void => {
    const current = settingsRef.current
    if (!current) return
    const profile = makeProfile(transport, current.outputs.length + 1)
    replaceSettings({ ...current, outputs: [...current.outputs, profile] })
    setActiveId(profile.id)
    persistProfile(profile, 0)
    setAdding(false)
  }

  const removeProfile = async (id: string): Promise<void> => {
    setRemoving(null)
    setBusy(id)
    try {
      replaceSettings(await ipcInvoke('script-player:removeOutput', { id }))
      setError(null)
    } catch (caught) {
      setError(toMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const toggleConnection = async (profile: TCodeOutputProfile): Promise<void> => {
    const parsed = TCodeOutputProfileSchema.safeParse(profile)
    if (!parsed.success) {
      setError(t('scriptPlayer.invalidConfig'))
      return
    }
    const state = runtime.get(profile.id)?.state ?? 'disconnected'
    setBusy(profile.id)
    try {
      await ipcInvoke('script-player:saveOutput', parsed.data)
      setStatus(await ipcInvoke(
        state === 'connected' || state === 'connecting'
          ? 'script-player:disconnect'
          : 'script-player:connect',
        { id: profile.id }
      ))
      setError(null)
    } catch (caught) {
      setError(toMessage(caught))
    } finally {
      setBusy(null)
    }
  }

  const setGlobal = (patch: Partial<PlayerSettings>): void => {
    const current = settingsRef.current
    if (!current) return
    const next = { ...current, ...patch }
    replaceSettings(next)
    const previous = saveTimers.current.get('global')
    if (previous !== undefined) window.clearTimeout(previous)
    saveTimers.current.set('global', window.setTimeout(() => {
      saveTimers.current.delete('global')
      ipcInvoke('script-player:updateSettings', next)
        .then(() => setError(null))
        .catch((caught) => setError(toMessage(caught)))
    }, 180))
  }

  const updateAxis = (
    axis: ScriptPlayerAxis,
    update: (motion: PlayerSettings['axes'][ScriptPlayerAxis]) => PlayerSettings['axes'][ScriptPlayerAxis]
  ): void => {
    const current = settingsRef.current
    if (!current) return
    setGlobal({ axes: { ...current.axes, [axis]: update(current.axes[axis]) } })
  }

  const activeProfile = settings?.outputs.find(({ id }) => id === activeId) ?? settings?.outputs[0]
  /**
   * The script route points at MultiFunPlayer, so this player has let go of
   * every device. Showing the connection UI anyway would offer buttons that
   * cannot work; the panel says who has the script instead.
   */
  const standingDown = status !== null && !status.enabled

  /**
   * Which player gets the script. It decides whether anything else in this
   * panel means anything, so it sits at the top of it rather than only in the
   * settings page — switching back and forth is a thing people do mid-session.
   */
  const chooseRoute = (next: 'internal' | 'mfp'): void => {
    if (next === route) return
    setRoute(next)
    void ipcInvoke('settings:update', { playback: { scriptRoute: next } }).catch((caught) => {
      setError(toMessage(caught))
      setRoute(next === 'internal' ? 'mfp' : 'internal')
    })
  }

  const detach = async (): Promise<void> => {
    if (standalone) await ipcInvoke('script-player:attach')
    else await ipcInvoke('script-player:detach')
    onClose?.()
  }

  const openRouteSettings = (): void => {
    void ipcInvoke('app:openSettings', {
      section: 'playback',
      target: 'scriptRoute'
    }).catch((caught) => setError(toMessage(caught)))
  }

  return (
    <section className={`script-player${standalone ? ' standalone' : ''}`}>
      <header className="sp-header">
        <div>
          <h1>{t('scriptPlayer.title')}</h1>
          <div className="sp-now">
            <span className={`sp-phase ${status?.phase ?? 'idle'}`} />
            {t(`scriptPlayer.phase.${status?.phase ?? 'idle'}`)}
            <code>{formatPosition(status?.positionMs ?? null)}</code>
            {status?.syncing && <span className="sp-flag">{t('scriptPlayer.state.syncing')}</span>}
            {status?.homing && <span className="sp-flag">{t('scriptPlayer.state.homing')}</span>}
          </div>
        </div>
        <div className="row">
          {standalone && !mainWindowOpen && (
            <button
              className="icon-btn"
              type="button"
              title={t('common.showMainWindow')}
              onClick={() => void ipcInvoke('app:showMainWindow').catch(() => {})}
            >
              <AppWindow size={16} />
            </button>
          )}
          <button
            className={`icon-btn sp-settings-trigger${settingsOpen ? ' active' : ''}`}
            type="button"
            title={t('scriptPlayer.settings')}
            aria-label={t('scriptPlayer.settings')}
            aria-pressed={settingsOpen}
            onClick={() => {
              setAdding(false)
              setSettingsOpen(true)
            }}
          >
            <Settings2 size={16} />
          </button>
          <button className="icon-btn" title={t(standalone ? 'scriptPlayer.attach' : 'scriptPlayer.detach')} onClick={() => void detach()}>
            {standalone ? <Link2Off size={16} /> : <ExternalLink size={16} />}
          </button>
          {!standalone && onClose && (
            <button className="icon-btn" title={t('common.close')} onClick={onClose}><X size={17} /></button>
          )}
        </div>
      </header>

      {error && <div className="error-banner sp-error">{error}</div>}

      <div
        className="sp-route"
        data-tour="sp-route"
        role="group"
        aria-label={t('settings.scriptRoute.title')}
      >
        {(['internal', 'mfp'] as const).map((option) => (
          <button
            key={option}
            type="button"
            className={route === option ? 'on' : ''}
            aria-pressed={route === option}
            onClick={() => chooseRoute(option)}
          >
            {t(`settings.scriptRoute.${option}`)}
          </button>
        ))}
      </div>

      {standingDown && (
        <div className="sp-standing-down">
          <strong>{t('scriptPlayer.disabledTitle')}</strong>
          <span>{t('scriptPlayer.disabledHint')}</span>
          <button className="primary sp-standing-action" type="button" onClick={openRouteSettings}>
            <Settings2 size={13} />
            {t('scriptPlayer.openRouteSettings')}
          </button>
        </div>
      )}

      <div className="sp-scroll">
        {!standingDown && settings && (
          <AxisPanel
            settings={settings}
            status={status}
            onUpdateAxis={updateAxis}
            onStatus={setStatus}
            onError={(caught) => setError(toMessage(caught))}
          />
        )}
        {!standingDown && settings?.outputs.length === 0 && (
          <div className="sp-empty">{t('scriptPlayer.empty')}</div>
        )}
        {!standingDown && activeProfile && [activeProfile].map((profile) => {
          const output = runtime.get(profile.id)
          const connectionState = output?.state ?? 'disconnected'
          const serial = profile.transport === 'serial'
          const handy = profile.transport === 'handy'
          const settingsLocked = connectionState !== 'disconnected' && connectionState !== 'error'

          const transportSelect = (
            <Select
              value={profile.transport}
              disabled={settingsLocked}
              ariaLabel={t('scriptPlayer.transport')}
              onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, transport: value as Transport }), 0)}
              options={(['serial', 'udp', 'tcp', 'websocket', 'handy'] as Transport[]).map((value) => ({ value, label: value === 'websocket' ? 'WebSocket' : value === 'handy' ? 'The Handy' : value.toUpperCase() }))}
            />
          )
          const keyInput = (
            <span className="row">
              <input
                className="settings-input grow"
                type="password"
                autoComplete="off"
                disabled={settingsLocked}
                aria-label={t('scriptPlayer.connectionKey')}
                value={profile.connectionKey.startsWith('fsmgr-safe:v1:') ? '' : profile.connectionKey}
                placeholder={profile.connectionKey ? t('scriptPlayer.keyStored') : t('scriptPlayer.connectionKeyPlaceholder')}
                onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, connectionKey: event.target.value }))}
              />
              {profile.connectionKey && <button className="icon-btn" disabled={settingsLocked} title={t('scriptPlayer.clearKey')} onClick={() => changeProfile(profile.id, (item) => ({ ...item, connectionKey: '' }), 0)}><X size={14} /></button>}
            </span>
          )
          // A port is one of the ones this machine has, so it is chosen, not
          // typed. A port saved earlier stays in the list even when the scan
          // no longer sees it, so unplugging a device does not silently drop
          // the setting — it is marked instead.
          const portOptions = ports.map(({ path, label }) => ({ value: path, label }))
          if (profile.endpoint && !ports.some(({ path }) => path === profile.endpoint)) {
            portOptions.unshift({ value: profile.endpoint, label: t('scriptPlayer.portMissing', { port: profile.endpoint }) })
          }
          const endpointInput = (
            <span className="row">
              {serial ? (
                <Select
                  className="grow"
                  value={profile.endpoint}
                  options={portOptions}
                  disabled={settingsLocked || portOptions.length === 0}
                  ariaLabel={t('scriptPlayer.serialPort')}
                  placeholder={t('scriptPlayer.noPorts')}
                  onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, endpoint: value }), 0)}
                />
              ) : (
                <input
                  className="settings-input grow"
                  disabled={settingsLocked}
                  aria-label={profile.transport === 'websocket' ? 'URL' : t('scriptPlayer.host')}
                  value={profile.endpoint}
                  placeholder={profile.transport === 'websocket' ? 'ws://127.0.0.1:8000' : '127.0.0.1'}
                  onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, endpoint: event.target.value }))}
                />
              )}
              {serial && <button className="icon-btn" disabled={settingsLocked} title={t('scriptPlayer.refreshPorts')} onClick={refreshPorts}><RefreshCw size={14} /></button>}
            </span>
          )
          const portInput = (
            <input className="settings-input sp-number" disabled={settingsLocked} type="number" min={1} max={65535} aria-label={t('scriptPlayer.port')} value={profile.port} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, port: Number(event.target.value) }))} />
          )
          const connectButton = (compact: boolean): React.JSX.Element => (
            <button
              data-tour="sp-connect"
              className={`sp-connect-button${compact ? ' compact' : ''} ${connectionState === 'connected' ? 'ghost connected' : 'primary'}`}
              disabled={busy === profile.id || connectionState === 'connecting' || connectionState === 'disconnecting'}
              onClick={() => void toggleConnection(profile)}
            >
              {connectionState === 'connected' ? <Unplug size={15} /> : connectionState === 'connecting' || connectionState === 'disconnecting' ? <LoaderCircle className="sp-spin" size={15} /> : <PlugZap size={15} />}
              {t(connectionState === 'connected'
                ? 'scriptPlayer.disconnect'
                : connectionState === 'connecting'
                  ? 'scriptPlayer.connection.connecting'
                  : 'scriptPlayer.connect')}
            </button>
          )
          const autoConnectToggle = (
            <button
              type="button"
              className={`sp-toggle${profile.autoConnect ? ' on' : ''}`}
              title={t('scriptPlayer.autoConnect')}
              aria-label={t('scriptPlayer.autoConnect')}
              aria-pressed={profile.autoConnect}
              onClick={() => changeProfile(profile.id, (item) => ({ ...item, autoConnect: !item.autoConnect }), 0)}
            >
              <RefreshCcwDot size={15} />
            </button>
          )

          return (
            <article className={`sp-output ${connectionState}`} key={profile.id}>
              <div className="sp-output-tabs" data-tour="sp-outputs" role="tablist">
                {settings?.outputs.map((item) => {
                  const state = runtime.get(item.id)?.state ?? 'disconnected'
                  return (
                    <button key={item.id} type="button" role="tab" aria-selected={item.id === profile.id} className={item.id === profile.id ? 'active' : ''} onClick={() => setActiveId(item.id)}>
                      <span className={`sp-tab-dot ${state}`} />
                      <span>{item.name}</span>
                      <small>{t(`scriptPlayer.connection.${state}`)}</small>
                    </button>
                  )
                })}
              </div>

              <div className="sp-output-body">
                {handy && <div className="sp-handy-note">{t('scriptPlayer.handyExperimental')}</div>}
                <div className="sp-output-head">
                  <input
                    className="sp-name"
                    value={profile.name}
                    aria-label={t('scriptPlayer.outputName')}
                    onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, name: event.target.value }))}
                  />
                  <span className={`sp-state ${connectionState}`} role="status" aria-live="polite">
                    {connectionState === 'connected' ? (
                      <CircleCheck size={14} />
                    ) : connectionState === 'connecting' || connectionState === 'disconnecting' ? (
                      <LoaderCircle size={14} />
                    ) : connectionState === 'error' ? (
                      <CircleX size={14} />
                    ) : (
                      <Circle size={12} />
                    )}
                    {t(`scriptPlayer.connection.${connectionState}`)}
                  </span>
                  <button className="icon-btn danger" title={t('common.remove')} disabled={busy === profile.id} onClick={() => setRemoving(profile.id)}>
                    <Trash2 size={15} />
                  </button>
                  <button
                    type="button"
                    className={`sp-tool sp-axis-expand${connectionOpen ? ' open' : ''}`}
                    title={t(connectionOpen ? 'scriptPlayer.collapseConnection' : 'scriptPlayer.expandConnection')}
                    aria-expanded={connectionOpen}
                    onClick={toggleConnectionOpen}
                  >
                    <ChevronDown size={16} />
                  </button>
                </div>

                {!connectionOpen ? (
                  <div className="sp-connection-row" data-tour="sp-connection">
                    <span className="sp-connection-transport">{transportSelect}</span>
                    <span className="sp-connection-main">
                      {handy ? keyInput : endpointInput}
                      {(profile.transport === 'udp' || profile.transport === 'tcp') && portInput}
                      {serial && (
                        <ToolPopover icon={<Settings2 size={14} />} title={t('scriptPlayer.serialAdvanced')} buttonClass="icon-btn">
                          {() => (
                            <div className="sp-pop-body">
                              <label className="sp-pop-row">
                                <span>{t('scriptPlayer.baudRate')}</span>
                                <input className="settings-input sp-number" disabled={settingsLocked} type="number" value={profile.baudRate} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, baudRate: Number(event.target.value) }))} />
                              </label>
                              <label className="sp-pop-row"><span>{t('scriptPlayer.dataBits')}</span><Select disabled={settingsLocked} value={String(profile.dataBits)} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, dataBits: Number(value) as 5 | 6 | 7 | 8 }))} options={['8', '7', '6', '5'].map((value) => ({ value, label: value }))} /></label>
                              <label className="sp-pop-row"><span>{t('scriptPlayer.stopBits')}</span><Select disabled={settingsLocked} value={String(profile.stopBits)} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, stopBits: Number(value) as 1 | 1.5 | 2 }))} options={['1', '1.5', '2'].map((value) => ({ value, label: value }))} /></label>
                              <label className="sp-pop-row"><span>{t('scriptPlayer.parity')}</span><Select disabled={settingsLocked} value={profile.parity} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, parity: value }))} options={(['none', 'even', 'odd', 'mark', 'space'] as const).map((value) => ({ value, label: value }))} /></label>
                              <label className="sp-pop-row"><span>{t('scriptPlayer.flowControl')}</span><Select disabled={settingsLocked} value={profile.flowControl} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, flowControl: value }))} options={(['none', 'xonxoff', 'rtscts', 'rtscts-xonxoff'] as const).map((value) => ({ value, label: value }))} /></label>
                              <label className="sp-pop-row"><span>DTR</span><input disabled={settingsLocked} type="checkbox" checked={profile.dtr} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, dtr: event.target.checked }))} /></label>
                              <label className="sp-pop-row"><span>RTS</span><input disabled={settingsLocked} type="checkbox" checked={profile.rts} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, rts: event.target.checked }))} /></label>
                            </div>
                          )}
                        </ToolPopover>
                      )}
                    </span>
                    <span className="sp-connection-actions">
                      {connectButton(true)}
                      {autoConnectToggle}
                    </span>
                  </div>
                ) : (
                  <>
                    <div className="sp-connection-grid" data-tour="sp-connection">
                      <label>
                        <span>{t('scriptPlayer.transport')}</span>
                        {transportSelect}
                      </label>
                      {handy ? (
                        <label className="grow">
                          <span>{t('scriptPlayer.connectionKey')}</span>
                          {keyInput}
                        </label>
                      ) : <label className="grow">
                        <span>{serial ? t('scriptPlayer.serialPort') : profile.transport === 'websocket' ? 'URL' : t('scriptPlayer.host')}</span>
                        {endpointInput}
                      </label>}
                      {serial ? (
                        <label>
                          <span>{t('scriptPlayer.baudRate')}</span>
                          <input className="settings-input sp-number" disabled={settingsLocked} type="number" value={profile.baudRate} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, baudRate: Number(event.target.value) }))} />
                        </label>
                      ) : !handy && profile.transport !== 'websocket' ? (
                        <label>
                          <span>{t('scriptPlayer.port')}</span>
                          {portInput}
                        </label>
                      ) : null}
                      {!handy && <label>
                        <span>{t('scriptPlayer.interval')}</span>
                        <span className="row"><input className="settings-input sp-number" type="number" min={profile.transport === 'websocket' ? 16 : 3} max={200} value={profile.updateIntervalMs} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, updateIntervalMs: Number(event.target.value) }))} /><span className="settings-unit">ms</span></span>
                      </label>}
                      {!handy && <label>
                        <span>{t('scriptPlayer.protocol')}</span>
                        <Select value={profile.protocol} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, protocol: value }))} options={[{ value: 'v0.3', label: 'TCode v0.3' }, { value: 'v0.2', label: 'TCode v0.2' }]} />
                      </label>}
                      {!handy && <label>
                        <span>{t('scriptPlayer.updateMode')}</span>
                        <Select value={profile.updateMode} disabled={settingsLocked} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, updateMode: value }))} options={[{ value: 'fixed', label: t('scriptPlayer.fixedUpdate') }, { value: 'polled', label: t('scriptPlayer.polledUpdate') }]} />
                      </label>}
                      {handy && <label>
                        <span>{t('scriptPlayer.sourceAxis')}</span>
                        <Select value={profile.sourceAxis} disabled={settingsLocked} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, sourceAxis: value }))} options={SCRIPT_PLAYER_AXES.map((value) => ({ value, label: t(`scriptPlayer.axis.${value}`) }))} />
                      </label>}
                    </div>

                    {!handy && (
                      <div className="sp-update-options">
                        {profile.updateMode === 'fixed' && <label><input type="checkbox" checked={profile.sendDirtyValuesOnly} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, sendDirtyValuesOnly: event.target.checked }))} />{t('scriptPlayer.dirtyOnly')}</label>}
                        <label><input type="checkbox" checked={profile.offloadElapsedTime} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, offloadElapsedTime: event.target.checked }))} />{t('scriptPlayer.offloadTiming')}</label>
                      </div>
                    )}
                    {serial && (
                      <details className="sp-advanced">
                        <summary>{t('scriptPlayer.serialAdvanced')}</summary>
                        <div className="sp-advanced-grid">
                          <label><span>{t('scriptPlayer.dataBits')}</span><Select disabled={settingsLocked} value={String(profile.dataBits)} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, dataBits: Number(value) as 5 | 6 | 7 | 8 }))} options={['8', '7', '6', '5'].map((value) => ({ value, label: value }))} /></label>
                          <label><span>{t('scriptPlayer.stopBits')}</span><Select disabled={settingsLocked} value={String(profile.stopBits)} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, stopBits: Number(value) as 1 | 1.5 | 2 }))} options={['1', '1.5', '2'].map((value) => ({ value, label: value }))} /></label>
                          <label><span>{t('scriptPlayer.parity')}</span><Select disabled={settingsLocked} value={profile.parity} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, parity: value }))} options={(['none', 'even', 'odd', 'mark', 'space'] as const).map((value) => ({ value, label: value }))} /></label>
                          <label><span>{t('scriptPlayer.flowControl')}</span><Select disabled={settingsLocked} value={profile.flowControl} onChange={(value) => changeProfile(profile.id, (item) => ({ ...item, flowControl: value }))} options={(['none', 'xonxoff', 'rtscts', 'rtscts-xonxoff'] as const).map((value) => ({ value, label: value }))} /></label>
                          <label><input disabled={settingsLocked} type="checkbox" checked={profile.dtr} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, dtr: event.target.checked }))} />DTR</label>
                          <label><input disabled={settingsLocked} type="checkbox" checked={profile.rts} onChange={(event) => changeProfile(profile.id, (item) => ({ ...item, rts: event.target.checked }))} />RTS</label>
                        </div>
                      </details>
                    )}
                  </>
                )}

                {(connectionOpen || output?.error || connectionState === 'connected') && (
                <div className="sp-actions">
                  {output?.error && <span className="sp-output-error">{t(`scriptPlayer.error.${output.error}`)}</span>}
                  {connectionState === 'connected' && (
                    <span className={`sp-live-state${status?.phase === 'playing' ? ' live' : ''}`}>
                      <span className="sp-live-dot" />
                      {t(status?.phase === 'playing' ? 'scriptPlayer.outputLive' : 'scriptPlayer.outputReady')}
                    </span>
                  )}
                  {connectionState === 'connected' && output && (
                    <span className="sp-io-state">
                      <b>TX</b> {output.updateRate}/s · {output.sentMessages}
                      <b className={output.lastReceivedAt ? 'active' : ''}>RX</b> {output.receivedMessages}
                    </span>
                  )}
                  {connectionOpen && (
                    <>
                      <div className="grow" />
                      {connectButton(false)}
                      {autoConnectToggle}
                    </>
                  )}
                </div>
                )}
                {output?.lastResponse && <div className="sp-device-response" title={output.lastResponse}>{t('scriptPlayer.lastResponse')}: <code>{output.lastResponse}</code></div>}

                <div className="sp-range-title">{t('scriptPlayer.outputRange')}</div>
                <div className="sp-ranges">
                  {SCRIPT_PLAYER_AXES.map((axis) => (
                    <AxisRangeRow
                      key={axis}
                      axis={axis}
                      value={status?.axes[axis]}
                      range={profile.ranges[axis]}
                      onChange={(range) => changeRange(profile.id, axis, range)}
                    />
                  ))}
                </div>
              </div>
            </article>
          )
        })}
      </div>

      <footer className="sp-add" data-tour="sp-add">
        <button className="ghost" onClick={() => setAdding(true)}>
          <Plus size={15} />{t('scriptPlayer.addOutput')}
        </button>
      </footer>

      {adding && (
        <div
          className="sp-sheet"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setAdding(false)
          }}
        >
          <div className="sp-sheet-card" role="dialog" aria-modal="true" aria-label={t('scriptPlayer.chooseTransport')}>
            <h2>{t('scriptPlayer.chooseTransport')}</h2>
            <div className="sp-sheet-options">
              {TRANSPORTS.map((transport) => (
                <button key={transport} className="sp-sheet-option" onClick={() => addProfile(transport)}>
                  {transportName(transport)}
                </button>
              ))}
            </div>
            <button className="ghost sp-sheet-cancel" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {removing && (
        <div
          className="sp-sheet"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setRemoving(null)
          }}
        >
          <div className="sp-sheet-card" role="alertdialog" aria-modal="true" aria-label={t('scriptPlayer.removeConfirm')}>
            <h2>{t('scriptPlayer.removeConfirm')}</h2>
            <p className="sp-sheet-subject">{settings?.outputs.find(({ id }) => id === removing)?.name}</p>
            <div className="sp-sheet-actions">
              <button className="ghost" onClick={() => setRemoving(null)}>
                {t('common.cancel')}
              </button>
              <button className="danger" onClick={() => void removeProfile(removing)}>
                <Trash2 size={14} />{t('common.remove')}
              </button>
            </div>
          </div>
        </div>
      )}

      {settingsOpen && settings && (
        <ScriptPlayerSettingsSheet
          settings={settings}
          onChange={setGlobal}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </section>
  )
}

function ScriptPlayerSettingsSheet({
  settings,
  onChange,
  onClose
}: {
  settings: PlayerSettings
  onChange: (patch: Partial<PlayerSettings>) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      className="sp-settings-sheet"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="sp-settings-card"
        role="dialog"
        aria-modal="true"
        aria-label={t('scriptPlayer.settings')}
      >
        <header className="sp-settings-head">
          <h2>
            <Settings2 size={15} />
            {t('scriptPlayer.settings')}
          </h2>
          <button className="icon-btn" type="button" title={t('common.close')} onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="sp-settings-scroll">
          <section className="sp-settings-section">
            <label className="sp-settings-offset">
              <span className="settings-label">{t('scriptPlayer.syncOffset')}</span>
              <span className="row">
                <input
                  className="settings-input sp-number"
                  type="number"
                  min={-5000}
                  max={5000}
                  step={10}
                  value={settings.syncOffsetMs}
                  onChange={(event) => onChange({ syncOffsetMs: Number(event.target.value) })}
                />
                <span className="settings-unit">ms</span>
              </span>
            </label>
            <p className="settings-hint">{t('scriptPlayer.autoConnectPerOutput')}</p>
          </section>

          <section className="sp-settings-section">
            <h3>{t('scriptPlayer.motion')}</h3>
            <div className="settings-inline sp-motion-globals">
              <div className="settings-field">
                <span className="settings-label">{t('scriptPlayer.easeIn')}</span>
                <div className="row">
                  <input
                    className="settings-input speed"
                    type="number"
                    min={0}
                    max={20}
                    step={0.5}
                    value={settings.syncDurationMs / 1000}
                    onChange={(event) => onChange({
                      syncDurationMs: Math.round(Number(event.target.value) * 1000)
                    })}
                  />
                  <span className="settings-unit">s</span>
                </div>
                <span className="settings-hint">{t('scriptPlayer.easeInHint')}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function AxisRangeRow({
  axis,
  range,
  value,
  onChange
}: {
  axis: ScriptPlayerAxis
  range: TCodeOutputProfile['ranges'][ScriptPlayerAxis]
  value: number | undefined
  onChange: (range: TCodeOutputProfile['ranges'][ScriptPlayerAxis]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const min = Math.round(range.min * 100)
  const max = Math.round(range.max * 100)
  const name = t(`scriptPlayer.axis.${axis}`)
  // Where the device actually sits: the script value after this output's
  // mapping, on the same 0–100 scale the handles use.
  const marker = value === undefined ? undefined : range.min + value * (range.max - range.min)
  return (
    <div className={`sp-axis${range.enabled ? '' : ' disabled'}`}>
      <label className="sp-axis-name" title={name}>
        <input
          type="checkbox"
          checked={range.enabled}
          aria-label={name}
          onChange={(event) => onChange({ ...range, enabled: event.target.checked })}
        />
        {TCODE_CHANNEL_BY_AXIS[axis]}
      </label>
      <RangeSlider
        min={min}
        max={max}
        marker={marker}
        label={name}
        disabled={!range.enabled}
        onChange={(next) => onChange({ ...range, min: next.min / 100, max: next.max / 100 })}
      />
      <span className="sp-range-value">{min}–{max}</span>
    </div>
  )
}

