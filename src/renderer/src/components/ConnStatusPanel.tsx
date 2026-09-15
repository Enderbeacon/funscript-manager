import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioWaveform, MonitorPlay } from 'lucide-react'
import type { IpcOutput } from '@shared/ipc/contract'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import { playerLabel } from '../playerLabel'

/**
 * Sidebar-resident connection panel.
 *
 * Three groups, in the order the data actually flows: which player has the
 * video, who is driving the script, and the devices being driven. The first
 * two open the panel that owns them; the device rows connect and disconnect on
 * a click.
 *
 * The rail is collapsed most of the time, so the first two rows carry an icon
 * rather than a dot — a column of identical dots said nothing about which one
 * was the player and which the device.
 */

type ConnStatus = IpcOutput<'playback:connStatus'>
type PlayerStatus = IpcOutput<'script-player:status'>
type OutputStatus = PlayerStatus['outputs'][number]
type SourceStatus = IpcOutput<'playback:sources'>[number]

/** Rows are only ever these four colours; the label carries the detail. */
function dotClass(state: OutputStatus['state']): 'ok' | 'warn' | 'err' | 'off' {
  if (state === 'connected') return 'ok'
  if (state === 'connecting' || state === 'disconnecting') return 'warn'
  return state === 'error' ? 'err' : 'off'
}

function sourceClass(source: SourceStatus | undefined): 'ok' | 'warn' | 'err' | 'off' {
  if (!source) return 'off'
  if (source.state === 'connected') return 'ok'
  if (source.state === 'connecting' || source.state === 'disconnecting') return 'warn'
  return source.state === 'error' ? 'err' : 'off'
}

export default function ConnStatusPanel({
  onOpenScriptPlayer,
  onOpenSources
}: {
  onOpenScriptPlayer: () => void
  onOpenSources: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [status, setStatus] = useState<ConnStatus | null>(null)
  const [sources, setSources] = useState<SourceStatus[]>([])
  const [player, setPlayer] = useState<PlayerStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    ipcInvoke('playback:connStatus').then(setStatus).catch(console.error)
    ipcInvoke('playback:sources').then(setSources).catch(console.error)
    ipcInvoke('script-player:status').then(setPlayer).catch(console.error)
    const offConn = ipcOn('event:conn-status', setStatus)
    const offSources = ipcOn('event:playback-sources', setSources)
    // The player's own broadcast is already coalesced to 100ms, and it carries
    // each output's name, so these rows need nothing from the settings file.
    const offPlayer = ipcOn('event:script-player-changed', setPlayer)
    return () => {
      offConn()
      offSources()
      offPlayer()
      if (errorTimer.current) clearTimeout(errorTimer.current)
    }
  }, [])

  const showError = (msg: string): void => {
    setError(msg)
    if (errorTimer.current) clearTimeout(errorTimer.current)
    errorTimer.current = setTimeout(() => setError(null), 8000)
  }

  const toggleOutput = async (output: OutputStatus): Promise<void> => {
    const disconnecting = output.state === 'connected' || output.state === 'connecting'
    setBusy(output.id)
    setError(null)
    try {
      setPlayer(
        await ipcInvoke(disconnecting ? 'script-player:disconnect' : 'script-player:connect', {
          id: output.id
        })
      )
    } catch (e) {
      showError(toMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const onMfpRoute = (status?.mfp ?? null) !== null
  const outputs = player?.outputs ?? []
  const current = sources.find((source) => source.current)

  return (
    <div className="conn-panel">
      <button
        className="conn-row lead"
        title={`${t('conn.video')} · ${playerLabel(current, t)}`}
        onClick={onOpenSources}
      >
        <MonitorPlay size={14} className="conn-ic" />
        <span className="conn-key">{t('conn.video')}</span>
        <span className={`conn-dot ${sourceClass(current)}`} />
        <span className="conn-name">{playerLabel(current, t)}</span>
      </button>

      <button
        className="conn-row lead"
        title={`${t('conn.script')} · ${onMfpRoute ? 'MultiFunPlayer' : t('conn.builtIn')}`}
        onClick={onOpenScriptPlayer}
      >
        <AudioWaveform size={14} className="conn-ic" />
        <span className="conn-key">{t('conn.script')}</span>
        <span
          className={`conn-dot ${
            onMfpRoute ? (status?.mfp === 'running' ? 'ok' : 'off') : 'ok'
          }`}
        />
        <span className="conn-name">
          {onMfpRoute ? 'MultiFunPlayer' : t('conn.builtIn')}
        </span>
      </button>

      {!onMfpRoute && (
        <>
          <div className="conn-group">{t('conn.devices')}</div>
          {outputs.length === 0 ? (
            <button
              className="conn-row named"
              title={t('conn.addDeviceHint')}
              onClick={onOpenScriptPlayer}
            >
              <span className="conn-dot off" />
              <span className="conn-name">{t('conn.addDevice')}</span>
            </button>
          ) : (
            outputs.map((output) => (
              <button
                key={output.id}
                className="conn-row named"
                title={`${output.name} · ${
                  output.error
                    ? t(`scriptPlayer.error.${output.error}`)
                    : t(`scriptPlayer.connection.${output.state}`)
                }`}
                disabled={busy === output.id}
                onClick={() => void toggleOutput(output)}
              >
                <span className={`conn-dot ${dotClass(output.state)}`} />
                <span className="conn-name">{output.name}</span>
                <span className="conn-label">
                  {busy === output.id ? '…' : t(`scriptPlayer.connection.${output.state}`)}
                </span>
              </button>
            ))
          )}
        </>
      )}

      {error && <div className="conn-error">{error}</div>}
    </div>
  )
}
