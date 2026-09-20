import { dialog, shell } from 'electron'
import { AppError } from '@shared/errors'
import { broadcast, handle } from '../../../main/ipc/register'
import * as config from '../../../main/services/config/config-service'
import * as playback from '../../../main/services/playback/playback-service'
import { scriptPlayerSession, configureScriptPlayer } from '../../composition/session'
import { SerialTCodeTransport } from '../../infrastructure/outputs/serial'
import { protectString } from '../../infrastructure/credentials/protected-string'
import { loadScriptFile } from '../../infrastructure/scripts/load-scripts'
import {
  attachScriptPlayerWindow,
  detachScriptPlayerWindow,
  isScriptPlayerDetached,
  onScriptPlayerSurfaceChanged
} from '../../infrastructure/window/script-player-window'
import type { ScriptPlayerSettings } from '../../shared/config'

let registered = false

async function saveSettings(settings: ScriptPlayerSettings): Promise<ScriptPlayerSettings> {
  const protectedSettings = {
    ...settings,
    outputs: settings.outputs.map((profile) => profile.transport === 'handy'
      ? { ...profile, connectionKey: protectString(profile.connectionKey), updateMode: 'polled' as const }
      : profile)
  }
  const saved = await config.updateSettings({ scriptPlayer: protectedSettings })
  configureScriptPlayer(saved.scriptPlayer, saved.playback.scriptRoute === 'internal')
  return saved.scriptPlayer
}

export function registerScriptPlayerHandlers(): void {
  if (registered) return
  registered = true

  scriptPlayerSession.setClock({ sample: () => playback.status() })
  scriptPlayerSession.on('changed', (status) => broadcast('event:script-player-changed', status))
  onScriptPlayerSurfaceChanged((detached) =>
    broadcast('event:script-player-surface', { detached })
  )

  void config.getSettings().then(({ scriptPlayer, playback }) => {
    configureScriptPlayer(scriptPlayer, playback.scriptRoute === 'internal')
  }).catch((error) => console.error('[script-player] setup failed:', error))

  handle('script-player:status', () => scriptPlayerSession.status())
  handle('script-player:settings', async () => (await config.getSettings()).scriptPlayer)
  handle('script-player:updateSettings', (settings) => saveSettings(settings))
  handle('script-player:saveOutput', async (profile) => {
    const current = (await config.getSettings()).scriptPlayer
    const storedProfile = profile.transport === 'handy'
      ? { ...profile, connectionKey: protectString(profile.connectionKey), updateMode: 'polled' as const }
      : profile
    const outputs = current.outputs.some(({ id }) => id === storedProfile.id)
      ? current.outputs.map((item) => item.id === storedProfile.id ? storedProfile : item)
      : [...current.outputs, storedProfile]
    return saveSettings({ ...current, outputs })
  })
  handle('script-player:previewRanges', ({ id, ranges }) => {
    scriptPlayerSession.previewRanges(id, ranges)
  })
  handle('script-player:removeOutput', async ({ id }) => {
    await scriptPlayerSession.disconnect(id)
    const current = (await config.getSettings()).scriptPlayer
    return saveSettings({ ...current, outputs: current.outputs.filter((item) => item.id !== id) })
  })
  handle('script-player:connect', async ({ id }) => {
    await scriptPlayerSession.connect(id)
    return scriptPlayerSession.status()
  })
  handle('script-player:disconnect', async ({ id }) => {
    await scriptPlayerSession.disconnect(id)
    return scriptPlayerSession.status()
  })
  handle('script-player:pickScript', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Funscript', extensions: ['funscript'] }]
    })
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
  })
  handle('script-player:axisLoad', async ({ axis, path }) => {
    const file = await loadScriptFile(path)
    if (!file) throw new AppError('script_unreadable')
    scriptPlayerSession.loadAxisScript(axis, file)
    return scriptPlayerSession.status()
  })
  handle('script-player:axisClear', ({ axis }) => {
    scriptPlayerSession.clearAxisScript(axis)
    return scriptPlayerSession.status()
  })
  handle('script-player:axisReload', ({ axis }) => {
    scriptPlayerSession.reloadAxisScript(axis)
    return scriptPlayerSession.status()
  })
  handle('script-player:axisLock', ({ axis, locked }) => {
    scriptPlayerSession.setAxisLocked(axis, locked)
    return scriptPlayerSession.status()
  })
  handle('script-player:axisReveal', ({ axis }) => {
    const path = scriptPlayerSession.axisScriptPath(axis)
    if (path) shell.showItemInFolder(path)
  })
  handle('script-player:resetCurve', ({ axis }) => {
    scriptPlayerSession.resetCurve(axis)
  })
  handle('script-player:listSerialPorts', async () => {
    try {
      const ports = await SerialTCodeTransport.list()
      return {
        // Windows has no maker to name for a port built into the machine, and
        // fills the field with a parenthesised stand-in translated into the
        // system language. Dropping it leaves the path on its own.
        ports: ports.map(({ path, manufacturer }) => ({
          path,
          label: manufacturer && !manufacturer.trimStart().startsWith('(')
            ? `${path} — ${manufacturer}`
            : path
        }))
      }
    } catch (error) {
      console.error('[script-player] serial port enumeration failed:', error)
      return { ports: [] }
    }
  })
  handle('script-player:detach', () => ({ detached: detachScriptPlayerWindow() }))
  handle('script-player:attach', () => ({ detached: attachScriptPlayerWindow() }))
  handle('script-player:surface', () => ({ detached: isScriptPlayerDetached() }))
}
