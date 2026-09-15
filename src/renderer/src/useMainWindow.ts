import { useEffect, useState } from 'react'
import { ipcInvoke, ipcOn } from './ipc'

/**
 * Is the main window still open?
 *
 * Only the detached players ask. Closing the main window and keeping them
 * running is a state the user can choose, and in it these windows are the only
 * way back into the app — so they put up a button that brings it back, and
 * only while there is nothing to bring forward.
 *
 * Starts as open: assuming otherwise would flash a button for the moment
 * before the answer arrives, on every window, in the ordinary case.
 */
export function useMainWindowOpen(): boolean {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    ipcInvoke('app:mainWindowOpen')
      .then((result) => setOpen(result.open))
      .catch(() => {})
    return ipcOn('event:main-window', (payload) => setOpen(payload.open))
  }, [])
  return open
}
