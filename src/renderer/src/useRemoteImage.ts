import { useEffect, useState } from 'react'
import { ipcInvoke } from './ipc'

/**
 * A forum image, fetched through main and handed back as a data URL.
 *
 * The renderer cannot load remote images itself: its CSP allows `self`,
 * `data:` and the media scheme only. That is on purpose — a parsed post must
 * not be able to make the app fetch a host of its choosing — so pictures come
 * back through IPC, where main caches them.
 */
export function useRemoteImage(url: string): string {
  const [dataUrl, setDataUrl] = useState('')

  useEffect(() => {
    if (!url) {
      setDataUrl('')
      return
    }
    let live = true
    ipcInvoke('scrape:remoteImage', { url })
      .then((r) => {
        if (live) setDataUrl(r.dataUrl)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [url])

  return dataUrl
}
