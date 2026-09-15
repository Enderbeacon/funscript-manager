import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import type { NameField } from '@shared/schemas/media-meta'
import type { IpcOutput } from '@shared/ipc/contract'
import { namePickFromEvent, type NameFilter, type NamePick } from '../filters'
import { usePopover } from '../usePopover'

/**
 * One row of the info block: a kind of name, the ones this media carries, and
 * a ＋ that searches the existing vocabulary before creating anything new.
 *
 * Offering what already exists is the whole point. Typing a name freehand is
 * how a library ends up with `POV`, `pov` and `P.O.V.` meaning one thing.
 */

export type Taxonomy = IpcOutput<'taxonomy:get'>

/** Colour per kind; matches the dots in the filter sidebar. */
export const KIND_COLOR: Record<NameField, string> = {
  tags: 'var(--grad-a)',
  scriptAuthors: 'var(--warn)',
  videoAuthors: 'var(--blob-2)',
  studios: 'var(--blob-3)',
  playlists: 'var(--success)'
}

/** Names are matched the way the filter matches them: case-insensitively. */
function pickState(picked: NameFilter | undefined, name: string): string {
  if (!picked) return ''
  const hit = (list: string[]): boolean => list.some((n) => n.toLowerCase() === name.toLowerCase())
  return hit(picked.include) ? ' on' : hit(picked.exclude) ? ' off' : ''
}

export default function NameChips({
  field,
  names,
  taxonomy,
  onChange,
  compact = false,
  /** Chips that only some of the selected media carry (batch editing). */
  partial = [],
  /** What the media list is filtered by, so a chip can show it is picked. */
  picked,
  /** Given: the chips become the same control as the sidebar's rows. */
  onPick,
  /** Removing takes a confirmation — set where the × writes to the media. */
  confirmRemove = false
}: {
  field: NameField
  names: string[]
  taxonomy: Taxonomy | null
  onChange: (names: string[]) => void
  compact?: boolean
  partial?: string[]
  picked?: NameFilter
  onPick?: (name: string, pick: NamePick) => void
  confirmRemove?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const addRef = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const placement = usePopover(addRef, open, close, { maxHeight: 260 })

  /** The chip whose × was clicked, and the button it hangs off. */
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef<HTMLButtonElement>(null)
  const closePending = useCallback(() => setPending(null), [])
  const pendingPlacement = usePopover(pendingRef, pending !== null, closePending, { minRoom: 120 })

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const options = useMemo(() => {
    const all = taxonomy?.entities[field] ?? []
    const taken = new Set(names.map((n) => n.toLowerCase()))
    const q = query.trim().toLowerCase()
    return all
      .filter((e) => !taken.has(e.name.toLowerCase()))
      .filter((e) => !q || e.name.toLowerCase().includes(q) || e.aliases.some((a) => a.toLowerCase().includes(q)))
      .slice(0, 12)
  }, [taxonomy, field, names, query])

  const exactExists = (taxonomy?.entities[field] ?? []).some(
    (e) => e.name.toLowerCase() === query.trim().toLowerCase()
  )

  const add = (name: string): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (!names.some((n) => n.toLowerCase() === trimmed.toLowerCase())) onChange([...names, trimmed])
    setQuery('')
    setOpen(false)
  }

  const remove = (name: string): void => {
    setPending(null)
    onChange(names.filter((n) => n !== name))
  }

  /**
   * The × is a small target sitting inside another one, and what it takes away
   * was typed by hand — so it asks first. Shift skips the question for anyone
   * clearing out several at once, and the question itself says so.
   */
  const clickRemove = (name: string, e: React.MouseEvent<HTMLButtonElement>): void => {
    if (!confirmRemove || e.shiftKey) return remove(name)
    pendingRef.current = e.currentTarget
    setPending(name)
  }

  return (
    <div className={`chips${compact ? ' compact' : ''}`}>
      {names.map((name) => (
        <span
          key={name}
          className={`chip${partial.includes(name) ? ' partial' : ''}${pickState(picked, name)}`}
        >
          <i className="chip-dot" style={{ background: KIND_COLOR[field] }} />
          {onPick ? (
            <button
              className="chip-name"
              onClick={(e) => onPick(name, namePickFromEvent(e))}
              onContextMenu={(e) => {
                e.preventDefault()
                onPick(name, 'exclude')
              }}
            >
              {name}
            </button>
          ) : (
            name
          )}
          <button
            className={`chip-x${pending === name ? ' asking' : ''}`}
            onClick={(e) => clickRemove(name, e)}
            aria-label={t('common.remove')}
          >
            <X size={11} />
          </button>
        </span>
      ))}

      {pending !== null &&
        pendingPlacement &&
        createPortal(
          <>
            <div className="chip-scrim" onClick={closePending} />
            <div className="chip-menu chip-ask" style={pendingPlacement}>
              <div className="chip-ask-q">{t('media.info.removeConfirm', { name: pending })}</div>
              <div className="chip-ask-hint">{t('media.info.removeShortcut')}</div>
              <div className="chip-ask-row">
                <button className="ghost" onClick={closePending}>
                  {t('common.cancel')}
                </button>
                <button className="danger" onClick={() => remove(pending)}>
                  {t('common.remove')}
                </button>
              </div>
            </div>
          </>,
          document.body
        )}

      <span className="chip-add-wrap">
        <button
          ref={addRef}
          className="chip-add"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('common.add')}
        >
          <Plus size={12} />
        </button>
        {open &&
          placement &&
          createPortal(
            <>
              {/* A click outside dismisses an untouched menu, but never one
                  with something typed in it — Escape or ＋ closes that. */}
              <div className="chip-scrim" onClick={() => !query.trim() && close()} />
              <div className="chip-menu" style={placement}>
                <input
                  ref={inputRef}
                  className="chip-input"
                  value={query}
                  placeholder={t('media.info.addPlaceholder')}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') add(query)
                    if (e.key === 'Escape') close()
                  }}
                />
                {options.map((option) => (
                  <button key={option.name} className="chip-hit" onClick={() => add(option.name)}>
                    <span className="chip-hit-name">{option.name}</span>
                    <span className="chip-hit-n">{option.countWithDescendants}</span>
                  </button>
                ))}
                {query.trim() && !exactExists && (
                  <button className="chip-hit new" onClick={() => add(query)}>
                    {t('media.info.createNamed', { name: query.trim() })}
                  </button>
                )}
                {options.length === 0 && !query.trim() && (
                  <div className="chip-empty">{t('media.info.noneYet')}</div>
                )}
              </div>
            </>,
            document.body
          )}
      </span>
    </div>
  )
}
