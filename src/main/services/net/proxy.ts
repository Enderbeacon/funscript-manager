import { isIP } from 'node:net'
import { session } from 'electron'
import { Dispatcher, ProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { isSupportedProxy } from '@shared/url'
import { getSettings } from '../config/config-service'

/**
 * One proxy setting for the whole app.
 *
 * There are three network stacks in here and each needs telling separately:
 *
 * - **Chromium** — `net.fetch` (the forum, post pages, site logins) and every
 *   BrowserWindow. Set on the default session.
 * - **Node's fetch** — the download path (`http.ts`), the host APIs (gofile,
 *   pixeldrain, mega) and megajs, which all use the global `fetch`. undici keeps
 *   its dispatcher on a well-known global, so replacing it reaches Node's
 *   built-in fetch as well as our own calls.
 * - **yt-dlp** — its own process; it gets `--proxy` on the command line.
 *
 * With no address set, both in-process stacks follow the system proxy.
 * Chromium does that by itself; Node does not, and used to go direct instead —
 * so on a machine that only reaches a host through the system proxy, a post
 * page opened fine while every download from it and every link check failed.
 * The system answer is read from Chromium, which already knows it, and read
 * again as it changes: a proxy client that is switched off mid-session must
 * not leave downloads pointed at a port nobody listens on.
 *
 * Addresses on this machine or the local network never go through a proxy.
 * Players are driven over HTTP on 127.0.0.1 or a LAN address, and a proxy
 * would either refuse those or answer for a different machine.
 *
 * HTTP proxies only. Chromium would accept a SOCKS URL but undici would not,
 * which would leave downloads quietly going direct — a proxy that covers half
 * the app is worse than one that plainly refuses the address.
 */

/** The address from settings; empty means the system proxy. */
let configured: string | null = null
/** What the system proxy resolves to for an ordinary site; empty means direct. */
let system = ''
let direct: Dispatcher | null = null
const agents = new Map<string, ProxyAgent>()
let refreshTimer: NodeJS.Timeout | null = null
let warnedUnsupported = ''

/** How often the system answer is read again when nothing asked for it. */
const REFRESH_MS = 30_000
/** Asked instead of every host: a system proxy applies to sites at large. */
const PROBE_URL = 'https://example.com/'

/** The proxy in force for Node's fetch, or empty for a direct connection. */
function effective(): string {
  return configured || system
}

/** The configured proxy, for the processes we hand a command line to. */
export function currentProxy(): string {
  return configured ?? ''
}

/**
 * A Chromium proxy rule as a URL undici can use: `PROXY host:port` and
 * `HTTPS host:port` map across; `DIRECT` and SOCKS become empty.
 */
export function proxyFromRule(rule: string): string {
  const first = rule.split(';')[0]?.trim() ?? ''
  const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first)
  if (!m) return ''
  return `${m[1]!.toUpperCase() === 'HTTPS' ? 'https' : 'http'}://${m[2]}`
}

/** The proxy a request to `url` should use: the configured one, or the system's. */
export async function proxyForUrl(url: string): Promise<string> {
  if (configured) return configured
  try {
    return proxyFromRule(await session.defaultSession.resolveProxy(url))
  } catch {
    return ''
  }
}

/** This machine, or a private network: never sent through a proxy. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const family = isIP(host)
  if (family === 4) {
    const [a = 0, b = 0] = host.split('.').map(Number)
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (family === 6) return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
  // A name without a dot is a machine on the local network, as Windows reads it.
  return host === 'localhost' || host.endsWith('.localhost') || !host.includes('.')
}

function isLocalOrigin(origin: string | URL | undefined): boolean {
  if (!origin) return false
  try {
    return isLocalHost(new URL(String(origin)).hostname)
  } catch {
    return false
  }
}

function agentFor(url: string): ProxyAgent {
  let agent = agents.get(url)
  if (!agent) {
    agent = new ProxyAgent(url)
    agents.set(url, agent)
  }
  return agent
}

/**
 * Close proxy agents nothing routes to any more. `close`, not `destroy`: a
 * download already running through the old address finishes on it instead of
 * dying the moment the proxy changes.
 */
function dropUnused(): void {
  for (const [url, agent] of agents) {
    if (url === effective()) continue
    agents.delete(url)
    void agent.close().catch(() => {})
  }
}

/** Picks, per request, between a direct connection and the proxy in force. */
class RoutingDispatcher extends Dispatcher {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const proxy = isLocalOrigin(options.origin) ? '' : effective()
    return (proxy ? agentFor(proxy) : direct!).dispatch(options, handler)
  }
}

/**
 * Read the system proxy again. Cheap — Chromium answers from what it already
 * knows — so the queue asks before each download attempt and each link check,
 * and a timer covers everything else.
 */
export async function refreshSystemProxy(): Promise<void> {
  if (configured === null || configured) return
  let rule = ''
  try {
    rule = await session.defaultSession.resolveProxy(PROBE_URL)
  } catch (e) {
    console.warn('[proxy] could not read the system proxy:', e)
    return
  }
  const next = proxyFromRule(rule)
  if (!next && /^SOCKS/i.test(rule.trim()) && warnedUnsupported !== rule) {
    warnedUnsupported = rule
    console.warn(`[proxy] the system proxy is SOCKS, which downloads cannot use: ${rule}`)
  }
  if (next === system) return
  system = next
  dropUnused()
  console.log(`[proxy] system proxy: ${system || 'direct'}`)
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

  if (!direct) {
    direct = getGlobalDispatcher()
    setGlobalDispatcher(new RoutingDispatcher())
    refreshTimer = setInterval(() => void refreshSystemProxy(), REFRESH_MS)
    refreshTimer.unref()
  }

  if (configured !== url) {
    try {
      await session.defaultSession.setProxy(url ? { proxyRules: url } : { mode: 'system' })
    } catch (e) {
      console.error('[proxy] Chromium refused the proxy:', e)
    }
    configured = url
    console.log(`[proxy] ${url || 'system proxy'}`)
  }

  await refreshSystemProxy()
  dropUnused()
}
