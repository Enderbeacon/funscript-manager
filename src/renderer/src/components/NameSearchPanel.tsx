import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search } from 'lucide-react'
import type { NameField } from '@shared/schemas/media-meta'
import { KIND_COLOR, type Taxonomy } from './NameChips'
import { NAME_FIELDS_UI, type NamePick } from '../filters'

/**
 * Searching every kind of name at once (Ctrl K).
 *
 * The sidebar's little box narrows one list in place, which is the right tool
 * when you know roughly what you are after and where it lives. This is the
 * other half: you half-remember a name and do not know whether it is a tag, a
 * studio or somebody's handle, so it searches all of them, matches aliases, and
 * can exclude as well as include.
 *
 * Keyboard first, because that is what it is for — the mouse already has the
 * sidebar. ↑↓ moves, Enter includes, Alt+Enter excludes, Escape closes.
 */

interface Hit {
  field: NameField
  name: string
  count: number
  /** The alias that matched, when it was not the name itself. */
  via: string | null
}

const MAX_PER_KIND = 8

/**
 * Names picked here recently, newest first.
 *
 * Kept in localStorage rather than in the taxonomy: it is a fact about this
 * person's last few minutes, not about the library, and losing it costs
 * nothing. Held outside the component so opening the panel again shows the
 * pick you just made.
 */
const RECENT_KEY = 'fsm.nameSearch.recent'
const RECENT_MAX = 6

function readRecent(): { field: NameField; name: string }[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as { field: NameField; name: string }[]) : []
  } catch {
    return []
  }
}

function rememberRecent(field: NameField, name: string): void {
  const kept = readRecent().filter((r) => !(r.field === field && r.name === name))
  const next = [{ field, name }, ...kept].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Private mode, quota, whatever — a convenience that fails is not an error.
  }
}

export default function NameSearchPanel({
  taxonomy,
  initialQuery,
  picked,
  matchCount,
  onPick,
  onClose
}: {
  taxonomy: Taxonomy | null
  initialQuery: string
  /** Names already in the filter, so a hit can show it is picked. */
  picked: (field: NameField, name: string) => 'in' | 'ex' | null
  /** How many media the filter matches as it stands — the point of picking. */
  matchCount: number
  onPick: (field: NameField, name: string, pick: NamePick) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = useState(initialQuery)
  /** null = every kind; otherwise only this one. */
  const [only, setOnly] = useState<NameField | null>(null)
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q || !taxonomy) return []
    const out: Hit[] = []
    for (const field of NAME_FIELDS_UI) {
      if (only && field !== only) continue
      const found: Hit[] = []
      for (const entity of taxonomy.entities[field]) {
        const byName = entity.name.toLowerCase().includes(q)
        const alias = byName ? null : entity.aliases.find((a) => a.toLowerCase().includes(q))
        if (!byName && !alias) continue
        found.push({
          field,
          name: entity.name,
          count: entity.countWithDescendants,
          via: alias ?? null
        })
      }
      // Most-used first: with a two-letter query the useful answer is nearly
      // always the one the library actually has a lot of.
      found.sort((a, b) => b.count - a.count)
      out.push(...found.slice(0, MAX_PER_KIND))
    }
    return out
  }, [query, taxonomy, only])

  useEffect(() => setCursor(0), [query, only])

  const [recent, setRecent] = useState(readRecent)

  const take = (hit: Hit | undefined, pick: NamePick): void => {
    if (!hit) return
    rememberRecent(hit.field, hit.name)
    setRecent(readRecent())
    onPick(hit.field, hit.name, pick)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(hits.length - 1, c + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(0, c - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      take(hits[cursor], e.altKey ? 'exclude' : 'toggle')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  // Group headings, without regrouping the list: it is already in kind order.
  let lastField: NameField | null = null

  return (
    <div className="name-search-scrim" onMouseDown={onClose}>
      <div className="name-search" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div className="ns-head">
          <Search size={14} />
          <input
            ref={inputRef}
            className="bare"
            value={query}
            placeholder={t('media.filter.searchAllPlaceholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="ns-body">
          <div className="ns-side">
            <div className="ns-lbl">{t('media.filter.scope')}</div>
            <button className={only === null ? 'on' : ''} onClick={() => setOnly(null)}>
              {t('media.filter.allKinds')}
            </button>
            {NAME_FIELDS_UI.map((field) => (
              <button
                key={field}
                className={only === field ? 'on' : ''}
                onClick={() => setOnly(only === field ? null : field)}
              >
                <i style={{ background: KIND_COLOR[field] }} />
                {t(`media.filter.kindShort.${field}`)}
                <span className="n">{taxonomy?.entities[field].length ?? 0}</span>
              </button>
            ))}

            {recent.length > 0 && (
              <>
                <div className="ns-lbl">{t('media.filter.recent')}</div>
                {recent.map((r) => (
                  <button
                    key={`${r.field}/${r.name}`}
                    onClick={() => {
                      rememberRecent(r.field, r.name)
                      setRecent(readRecent())
                      onPick(r.field, r.name, 'toggle')
                    }}
                  >
                    <i style={{ background: KIND_COLOR[r.field] }} />
                    <span className="ns-recent">{r.name}</span>
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="ns-list">
            {query.trim() === '' && <div className="fempty">{t('media.filter.typeToSearch')}</div>}
            {query.trim() !== '' && hits.length === 0 && (
              <div className="fempty">{t('media.filter.noHits')}</div>
            )}
            {hits.map((hit, i) => {
              const heading = hit.field !== lastField ? hit.field : null
              lastField = hit.field
              const on = picked(hit.field, hit.name)
              return (
                <div key={`${hit.field}/${hit.name}`}>
                  {heading && (
                    <div className="ns-group">{t(`media.filter.kind.${heading}`)}</div>
                  )}
                  <button
                    className={`ns-hit${i === cursor ? ' cur' : ''}${on === 'in' ? ' sel' : on === 'ex' ? ' ex' : ''}`}
                    onMouseEnter={() => setCursor(i)}
                    onClick={(e) => take(hit, e.altKey ? 'exclude' : 'toggle')}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      take(hit, 'exclude')
                    }}
                  >
                    <i className="frow-dot" style={{ background: KIND_COLOR[hit.field] }} />
                    <span className="ns-name">
                      {hit.name}
                      {hit.via && <em> ← {hit.via}</em>}
                    </span>
                    <span className="frow-n">{hit.count}</span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        <div className="ns-foot">
          <kbd>↑↓</kbd> {t('media.filter.keyMove')}
          <kbd>↵</kbd> {t('media.filter.keyInclude')}
          <kbd>Alt ↵</kbd> {t('media.filter.keyExclude')}
          <kbd>Esc</kbd> {t('common.close')}
          <span className="grow" />
          {/* The whole reason for picking anything: what the filter is down to
              now. It updates as each pick lands, so the panel can stay open
              while the number is narrowed to something workable. */}
          <span className="ns-count">{t('media.filter.matchesNow', { count: matchCount })}</span>
        </div>
      </div>
    </div>
  )
}
