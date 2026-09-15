import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { AppError } from '@shared/errors'
import { isIndexCorruption } from '../services/db/index-db'
import { recoverIndex } from '../services/library/library-manager'
import {
  ipcContract,
  ipcEvents,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcInput,
  type IpcOutput
} from '@shared/ipc/contract'

/**
 * Type-safe IPC wrappers (main side).
 * handle(): registers a handler; inputs and outputs are validated against
 *           the contract's zod schemas.
 * broadcast(): pushes an event to all windows; payload is schema-validated.
 *
 * AppError needs no special handling here: its message embeds the
 * serialized error code, which the renderer client parses back out.
 */

/**
 * Handlers get the window that called as a second argument. Almost none want
 * it; the built-in picture does, because "which window is drawing it" is the
 * thing it has to keep track of, and a window that goes away without saying so
 * has to be noticed.
 */
export function handle<C extends IpcChannel>(
  channel: C,
  handler: (input: ParsedInput<C>, sender: WebContents) => Promise<IpcOutput<C>> | IpcOutput<C>
): void {
  ipcMain.handle(channel, async (event, rawInput: unknown) => {
    const schema = ipcContract[channel]
    const input = schema.input.parse(rawInput) as ParsedInput<C>
    const result = await callWithIndexRecovery(handler, input, event.sender)
    // A schema mismatch is our bug, not the user's. Raw zod issues crossing
    // IPC render as an unreadable blob in the UI, so keep the detail in the
    // main log and hand the renderer something it can actually say.
    const validated = schema.output.safeParse(result)
    if (!validated.success) {
      console.error(`[ipc] ${channel} returned an unexpected shape:`, validated.error.issues)
      throw new AppError('internal_error', { detail: channel })
    }
    return validated.data
  })
}

/**
 * Run a handler, and if it dies because the library's index is damaged,
 * rebuild the index and answer once from the fresh one.
 *
 * Here rather than in each handler because corruption is not a property of any
 * one query: whichever call first touches a damaged page throws, and every
 * later one throws too, leaving the window stuck for the rest of the run.
 * Everything that reaches the index takes a libraryId, which is all this
 * needs to know which one to rebuild.
 */
async function callWithIndexRecovery<C extends IpcChannel>(
  handler: (input: ParsedInput<C>, sender: WebContents) => Promise<IpcOutput<C>> | IpcOutput<C>,
  input: ParsedInput<C>,
  sender: WebContents
): Promise<IpcOutput<C>> {
  try {
    return await handler(input, sender)
  } catch (e) {
    const libraryId =
      input && typeof input === 'object' ? (input as { libraryId?: unknown }).libraryId : undefined
    if (!isIndexCorruption(e) || typeof libraryId !== 'string' || !recoverIndex(libraryId)) throw e
    // The rebuilt index is empty until the rescan lands, so this answers with
    // whatever an empty library looks like; the sync's media-changed event is
    // what fills the page in.
    return await handler(input, sender)
  }
}

/** Handlers receive the parsed input type (defaults already applied). */
type ParsedInput<C extends IpcChannel> = import('zod').z.output<
  (typeof ipcContract)[C]['input']
>

export function broadcast<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>
): void {
  const validated = ipcEvents[channel].parse(payload)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, validated)
  }
}

export type { IpcChannel, IpcInput, IpcOutput }
