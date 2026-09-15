import { AppIpcError, parseAppError } from '@shared/errors'
import type {
  IpcChannel,
  IpcEventChannel,
  IpcEventPayload,
  IpcInput,
  IpcOutput
} from '@shared/ipc/contract'

/**
 * Type-safe IPC client (renderer side).
 *   const libs = await ipcInvoke('library:list')
 *   const off = ipcOn('event:libraries-changed', (p) => ...)
 *
 * AppError thrown in main is rethrown here as AppIpcError carrying a code,
 * which the UI translates via the i18n `errors.<code>` bundle.
 */

export async function ipcInvoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcInput<C> extends void ? [] : [input: IpcInput<C>]
): Promise<IpcOutput<C>> {
  try {
    return (await window.fsmgr.invoke(channel, args[0])) as IpcOutput<C>
  } catch (e) {
    const appError = e instanceof Error ? parseAppError(e.message) : null
    if (appError) throw new AppIpcError(appError.code, appError.params)
    throw e
  }
}

export function ipcOn<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void
): () => void {
  return window.fsmgr.on(channel, listener as (payload: unknown) => void)
}
