import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNEL_PREFIXES, IPC_EVENT_PREFIX } from '@shared/ipc/channels'

/**
 * Preload: channel-allowlist forwarding only, no business logic.
 * Types are enforced in the renderer; runtime validation happens in main.
 * Runs sandboxed — must not import anything beyond electron and
 * dependency-free shared modules.
 */

function assertInvokeChannel(channel: string): void {
  if (!IPC_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))) {
    throw new Error(`IPC channel not allowed: ${channel}`)
  }
}

const api = {
  invoke(channel: string, payload?: unknown): Promise<unknown> {
    assertInvokeChannel(channel)
    return ipcRenderer.invoke(channel, payload)
  },

  /**
   * Real path of a dropped file. Electron 32 removed `File.path`, and the
   * replacement only exists in preload — the renderer cannot reach it.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!channel.startsWith(IPC_EVENT_PREFIX)) {
      throw new Error(`IPC event channel not allowed: ${channel}`)
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

export type PreloadApi = typeof api

contextBridge.exposeInMainWorld('fsmgr', api)
