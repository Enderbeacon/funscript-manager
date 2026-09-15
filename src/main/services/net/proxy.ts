import { session } from 'electron'
import { ProxyAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici'
import { isSupportedProxy } from '@shared/url'
import { getSettings } from '../config/config-service'

/**
 * One proxy setting for the whole app.
 *
 * There are three network stacks in here and each needs telling separately:
 *
 * - **Chromium** — `net.fetch` (the forum, post pages, site logins) and every
 *   BrowserWindow. Set on the default session.
 * - **Node's fetch** — the download path (`http.ts`) and megajs, which both use
 *   the global `fetch`. undici keeps its dispatcher on a well-known global, so
 *   replacing it reaches Node's built-in fetch as well as our own calls.
 * - **yt-dlp** — its own process; it gets `--proxy` on the command line.
 *
 * HTTP proxies only. Chromium would accept a SOCKS URL but undici would not,
 * which would leave downloads quietly going direct — a proxy that covers half
 * the app is worse than one that plainly refuses the address.
 */

let applied: string | null = null
let systemDispatcher: Dispatcher | null = null
let proxyDispatcher: ProxyAgent | null = null

/** The proxy in force, for the processes we hand a command line to. */
export function currentProxy(): string {
  return applied ?? ''
}

/**
 * Put the configured proxy into force. Safe to call on every settings change:
 * an unchanged address is a no-op, so nothing tears down live connections.
 */
export async function applyProxySettings(): Promise<void> {
  const { download } = await getSettings()
  const raw = download.proxyUrl.trim()
  const url = isSupportedProxy(raw) ? raw : ''
  if (raw && !url) console.warn(`[proxy] ignoring unsupported proxy address: ${raw}`)
  if (applied === url) return

  systemDispatcher ??= getGlobalDispatcher()

  try {
    await session.defaultSession.setProxy(url ? { proxyRules: url } : { mode: 'system' })
  } catch (e) {
    console.error('[proxy] Chromium refused the proxy:', e)
  }

  const previous = proxyDispatcher
  if (url) {
    proxyDispatcher = new ProxyAgent(url)
    setGlobalDispatcher(proxyDispatcher)
  } else {
    proxyDispatcher = null
    if (systemDispatcher) setGlobalDispatcher(systemDispatcher)
  }
  // `close`, not `destroy`: a download already running through the old address
  // finishes on it instead of dying the moment the setting changes.
  void previous?.close().catch(() => {})

  applied = url
  console.log(`[proxy] ${url || 'system proxy'}`)
}
