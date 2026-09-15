/**
 * Tidying up a URL the user pasted, before anything tries to route it.
 *
 * Browsers hide the scheme in the address bar, so a copied address very often
 * arrives as `discuss.eroscripts.com/t/…` with no `https://` in front. Without
 * this, such a paste is not recognised as a forum post *and* no downloader
 * claims it, so it fails with "no downloader handles this link" — which says
 * nothing about the actual problem.
 *
 * Dependency-free: this is imported from main and renderer alike.
 */

/** `example.com/path`, `sub.example.co.uk:8080` — a host, then optionally more. */
const BARE_HOST = /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/

export function normalizePastedUrl(input: string): string {
  // Chat clients and forums like to wrap a pasted link in <> or quotes.
  const trimmed = input.trim().replace(/^[<"'\s]+|[>"'\s]+$/g, '')
  if (!trimmed) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  // Only add a scheme to something that actually looks like a host, so a
  // stray word or a file path is left alone to fail as itself.
  return BARE_HOST.test(trimmed) ? `https://${trimmed}` : trimmed
}

/**
 * Whether the app can route everything through this proxy address.
 *
 * HTTP proxies only, and deliberately so: Chromium would take a SOCKS URL but
 * the download path runs on Node's fetch, which would not — a proxy that
 * covers half the app is worse than one that plainly refuses the address.
 * Empty means the system proxy, which is always fine.
 */
export function isSupportedProxy(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed) return true
  try {
    const { protocol, hostname } = new URL(trimmed)
    return (protocol === 'http:' || protocol === 'https:') && hostname.length > 0
  } catch {
    return false
  }
}
