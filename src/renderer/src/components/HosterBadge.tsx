import { siDropbox, siGoogledrive, siMediafire, siMega, siPatreon, siPayhip } from 'simple-icons'
import type { ScrapedLink } from '@shared/schemas/scraped-post'

/**
 * Which download source a link or job belongs to, as a badge.
 *
 * Where simple-icons carries the brand we draw its real mark in its official
 * colour; the rest get a monogram in a colour taken from the site's own logo
 * or favicon. A bare colour swatch was tried first and failed the only test
 * that matters: "quota used up" says nothing until you can see whose quota.
 */

type Hoster = ScrapedLink['hoster']

interface Brand {
  hex: string
  /** simple-icons path data, when the set has the brand. */
  path?: string
  /** Fallback mark for brands no icon set carries. */
  mono?: string
  name: string
}

const BRANDS: Record<Hoster, Brand> = {
  mega: { hex: `#${siMega.hex}`, path: siMega.path, name: 'MEGA' },
  gdrive: { hex: `#${siGoogledrive.hex}`, path: siGoogledrive.path, name: 'Google Drive' },
  dropbox: { hex: `#${siDropbox.hex}`, path: siDropbox.path, name: 'Dropbox' },
  mediafire: { hex: `#${siMediafire.hex}`, path: siMediafire.path, name: 'MediaFire' },
  // Patreon's own mark is black, which disappears on a dark card; their coral
  // is what people recognise the site by.
  patreon: { hex: '#FF424D', path: siPatreon.path, name: 'Patreon' },
  payhip: { hex: `#${siPayhip.hex}`, path: siPayhip.path, name: 'Payhip' },
  gofile: { hex: '#E7AF1E', mono: 'GF', name: 'gofile' },
  pixeldrain: { hex: '#3B1257', mono: 'PD', name: 'pixeldrain' },
  pornhub: { hex: '#F8971D', mono: 'PH', name: 'Pornhub' },
  eporner: { hex: '#AE0000', mono: 'EP', name: 'EPorner' },
  rule34video: { hex: '#C73843', mono: 'R34', name: 'Rule34Video' },
  spankbang: { hex: '#E43F5A', mono: 'SB', name: 'SpankBang' },
  hanime1: { hex: '#DC1A28', mono: 'H1', name: 'hanime1' },
  hanimetv: { hex: '#F04E5E', mono: 'HT', name: 'hanime.tv' },
  attachment: { hex: '#4A6B8A', mono: 'ER', name: 'EroScripts' },
  unknown: { hex: '', mono: '', name: '' }
}

/**
 * Jobs carry the plugin id as a plain string, so this takes one too: a source
 * we have no brand for must still render, not crash the queue.
 */
function brandOf(hoster: string): Brand {
  return BRANDS[hoster as Hoster] ?? { hex: '', mono: '', name: hoster }
}

export function hosterName(hoster: string): string {
  return brandOf(hoster).name || hoster
}

/**
 * @param label host text to show beside the mark; omit for the mark alone
 *              (the rail is too narrow for names, so it hovers instead).
 */
export default function HosterBadge({
  hoster,
  label,
  markOnly = false
}: {
  hoster: string
  label?: string
  markOnly?: boolean
}): React.JSX.Element {
  const brand = brandOf(hoster)
  const text = label ?? brand.name ?? hoster

  // An unrecognised host has no brand to show; the domain is the useful part.
  if (!brand.hex) {
    return (
      <span className="hoster plain" title={text}>
        {text}
      </span>
    )
  }

  const mark = brand.path ? (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={brand.path} />
    </svg>
  ) : (
    <span className="hoster-mono">{brand.mono}</span>
  )

  return (
    <span
      className={`hoster${markOnly ? ' mark-only' : ''}`}
      style={{ background: brand.hex }}
      title={brand.name}
    >
      {mark}
      {!markOnly && text}
    </span>
  )
}
