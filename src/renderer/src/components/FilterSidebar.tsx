import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Folder, Pin, ScanSearch, Search } from 'lucide-react'
import type { NameField } from '@shared/schemas/media-meta'
import { KIND_COLOR, type Taxonomy } from './NameChips'
import {
  NAME_FIELDS_UI,
  applyFolderPick,
  applyNamePick,
  attributeLabels,
  namePickFromEvent,
  parseDuration,
  type SidebarState
} from '../filters'
import type { FolderRow } from '../folders'

/**
 * The filter sidebar.
 *
 * What this replaces: five unbounded name lists stacked one after another, with
 * the duration and rating controls pinned above them and unable to fold. With a
 * few hundred authors in the library it was several screens of scrolling to
 * reach anything, and nothing in it could be searched.
 *
 * The length was never really the problem — the *stacking* was. So one list
 * shows at a time, chosen by the row of kinds above it, and it is fully
 * expanded because scrolling a continuous list is exactly what it is for. The
 * little box filters that list in place; the button beside it hands the same
 * query to the cross-kind panel, which is the one that can search everything at
 * once and exclude as well as include.
 *
 * Playlists are deliberately not here: a playlist is a place you go rather than
 * a property of the media, and it is ordered, which no row in this list is. It
 * lives in the panel on the right with the rest of the playing controls.
 *
 * Gestures on a name: left picks it, right excludes it, and either Alt+left or
 * a double click picks it and drops everything else.
 *
 * Folders are one more kind in that row, and behave like the rest: a tree with
 * counts, the same three gestures, the same box narrowing it. They come from
 * where the files actually sit rather than from the taxonomy, which is the
 * point — a series someone dropped in one folder is findable as that folder
 * without anyone having tagged it.
 */

/** The kinds the row of buttons offers; folders are not a name field. */
type ListKind = NameField | 'folder'

/** Script properties. The view-level ones (no script, awaiting file, favourite)
 *  are the top bar's business — those are which shelf you are looking at. */
const FLAGS = ['multiAxis', 'multiVersion'] as const

/**
 * Whether the attributes block was left pinned open. Kept across restarts
 * because it is a fact about how this person works — someone who filters by
 * length every session should not have to pin it every session.
 */
const PIN_KEY = 'fsm.filters.attrsPinned'

/** Just enough to survive a pointer skimming the edge — anything longer and
 *  the block reads as sticky rather than as following the pointer. */
const FOLD_DELAY_MS = 60

/**
 * One row of the list, whichever kind is showing. Names and folders differ in
 * where they come from and what a click means, not in how they are drawn.
 */
interface ListRow {
  /** Identifies the row: the name itself, or a folder ref. */
  key: string
  label: string
  depth: number
  /** What the box narrows against. */
  search: string
  count: number
  title?: string
  /** A library's own row, at the top of its folders. */
  root?: boolean
}

/**
 * Which rows to draw, given which parents are folded.
 *
 * The list arrives in tree order, so a parent's subtree is exactly the run of
 * rows after it that are deeper — folding is skipping that run, and having
 * children is "the next row is deeper". No tree is built to answer either.
 *
 * Everything starts open, unlike the old sidebar where everything started
 * folded. A list you scroll to find things in cannot begin with the things
 * hidden.
 */
function visibleRows(
  rows: ListRow[],
  folded: Record<string, boolean>
): { row: ListRow; hasChildren: boolean; open: boolean }[] {
  const out: { row: ListRow; hasChildren: boolean; open: boolean }[] = []
  let skipBelow: number | null = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (skipBelow !== null) {
      if (row.depth > skipBelow) continue
      skipBelow = null
    }
    const hasChildren = (rows[i + 1]?.depth ?? -1) > row.depth
    const open = folded[row.key] !== true
    out.push({ row, hasChildren, open })
    if (hasChildren && !open) skipBelow = row.depth
  }
  return out
}

/**
 * The list narrowed to a query, flat.
 *
 * A hit keeps its ancestors so the row still sits where it did a keystroke ago
 * — losing the indentation as you type makes the list jump around under the
 * eye. What counts as a hit is each row's own search text: a name plus its
 * aliases, because a name the user knows by another spelling is still the one
 * they are looking for, and a folder's whole path, so a query can name the
 * folder above the one being looked for.
 */
function matchingRows(rows: ListRow[], query: string): ListRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  const hit = new Set<number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (!row.search.toLowerCase().includes(q)) continue
    hit.add(i)
    // Walk back up to depth 0, adding each ancestor once.
    let depth = row.depth
    for (let j = i - 1; j >= 0 && depth > 0; j--) {
      if (rows[j]!.depth < depth) {
        hit.add(j)
        depth = rows[j]!.depth
      }
    }
  }
  return rows.filter((_, i) => hit.has(i))
}

export default function FilterSidebar({
  state,
  onChange,
  taxonomy,
  folders,
  kind,
  onKindChange,
  onOpenBuilder,
  onSaveFilter,
  onOpenNameSearch
}: {
  state: SidebarState
  onChange: (next: SidebarState) => void
  taxonomy: Taxonomy | null
  /** The folder trees of the libraries on screen, already in tree order. */
  folders: FolderRow[]
  /** Which list is showing. The page owns it so it can switch to folders. */
  kind: ListKind
  onKindChange: (next: ListKind) => void
  onOpenBuilder: () => void
  onSaveFilter: () => void
  /** Hand the box's text to the panel that can search every kind at once. */
  onOpenNameSearch: (query: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  /**
   * The attributes block opens under the pointer and folds again when it
   * leaves, so the four controls nobody uses on most visits stop taking a
   * third of the sidebar. Pinning it turns that off — folding under someone
   * who is still typing in it is the one thing this must never do, hence the
   * delay and the focus check below.
   */
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(PIN_KEY) === '1'
    } catch {
      return false
    }
  })
  const [hovering, setHovering] = useState(false)
  const attrsRef = useRef<HTMLDivElement>(null)
  const foldTimer = useRef<number | null>(null)
  const [query, setQuery] = useState('')
  /** Parents the user folded, by row key. Absent = open, which is the default. */
  const [folded, setFolded] = useState<Record<string, boolean>>({})

  const rows = useMemo<ListRow[]>(() => {
    if (kind === 'folder') {
      return folders.map((row) => ({
        key: row.ref,
        label: row.label,
        depth: row.depth,
        search: row.fullPath,
        count: row.count,
        title: row.fullPath,
        root: row.isRoot
      }))
    }
    return (taxonomy?.entities[kind] ?? []).map((row) => ({
      key: row.name,
      label: row.name,
      depth: row.depth,
      // Separated, so a query cannot match across the join and hit a name that
      // reads nothing like it.
      search: [row.name, ...row.aliases].join('\u0000'),
      count: row.countWithDescendants,
      title: row.aliases.length > 0 ? row.aliases.join(' · ') : undefined
    }))
  }, [taxonomy, kind, folders])
  const shown = useMemo(() => matchingRows(rows, query), [rows, query])
  const picked = kind === 'folder' ? state.folders : state.names[kind]

  /**
   * What the block is narrowing, so the header can say so while it is shut.
   * A folded control that is silently filtering is the reason people think
   * the app is broken.
   */
  const activeAttrs = useMemo(
    () => attributeLabels(state, (key, params) => t(key, params ?? {})),
    [state, t]
  )

  const attrsOpen = pinned || hovering

  const cancelFold = (): void => {
    if (foldTimer.current !== null) window.clearTimeout(foldTimer.current)
    foldTimer.current = null
  }

  /** Folds once the pointer is gone for good — and never out from under a
   *  half-typed box, whose focus counts as still being in here. */
  const foldSoon = (): void => {
    cancelFold()
    foldTimer.current = window.setTimeout(() => {
      const box = attrsRef.current
      if (box && (box.matches(':hover') || box.contains(document.activeElement))) return
      setHovering(false)
    }, FOLD_DELAY_MS)
  }

  useEffect(() => cancelFold, [])

  const togglePin = (): void => {
    const next = !pinned
    setPinned(next)
    try {
      localStorage.setItem(PIN_KEY, next ? '1' : '0')
    } catch {
      // Private mode, quota, whatever — a convenience that fails is not an error.
    }
  }

  const isOn = (key: string): 'in' | 'ex' | null =>
    picked.include.some((n) => n.toLowerCase() === key.toLowerCase())
      ? 'in'
      : picked.exclude.some((n) => n.toLowerCase() === key.toLowerCase())
        ? 'ex'
        : null

  const pick = (key: string, how: 'toggle' | 'exclude' | 'solo'): void =>
    onChange(
      kind === 'folder' ? applyFolderPick(state, key, how) : applyNamePick(state, kind, key, how)
    )

  /** Typed but unreadable — the box says so rather than filtering by nothing. */
  const badDuration = (text: string): boolean =>
    text.trim() !== '' && parseDuration(text) === null

  return (
    <aside className="filters" data-tour="media-sidebar">
      {/* ---- attributes: open under the pointer, or pinned open ---- */}
      <div
        className={`fattrs${attrsOpen ? ' open' : ''}`}
        ref={attrsRef}
        onMouseEnter={() => {
          cancelFold()
          setHovering(true)
        }}
        onMouseLeave={foldSoon}
        onFocus={() => {
          cancelFold()
          setHovering(true)
        }}
        onBlur={foldSoon}
      >
        <button
          className="fattrs-head"
          aria-pressed={pinned}
          title={t(pinned ? 'media.filter.unpinAttrs' : 'media.filter.pinAttrs')}
          onClick={togglePin}
        >
          <ChevronRight size={12} className="fattrs-caret" />
          <span className="grow">{t('media.filter.attributes')}</span>
          {activeAttrs.length > 0 && <span className="fattrs-n">{activeAttrs.length}</span>}
          <Pin size={11} className={`fattrs-pin${pinned ? ' on' : ''}`} />
        </button>
        {/* Folded, this line is the only thing saying the list is being cut.
            It rides the same movement as the controls — one folds away as the
            other opens, so the block never gains a line mid-slide. */}
        {activeAttrs.length > 0 && (
          <div className="ffold sum">
            <div className="fattrs-sum" title={activeAttrs.join('\n')}>
              {activeAttrs.join(' · ')}
            </div>
          </div>
        )}
        <div className="ffold">
          {/* Labels in one column, controls in the other: the two rows line up
              and a long word in any language takes room from the boxes rather
              than running across them. */}
          <div className="fattrs-body">
            <span className="flabel" title={t('media.filter.durationHint')}>
              {t('media.filter.duration')}
            </span>
            <div className="frange" title={t('media.filter.durationHint')}>
              <input
                className={`fnum${badDuration(state.duration.min) ? ' bad' : ''}`}
                type="text"
                inputMode="text"
                spellCheck={false}
                value={state.duration.min}
                placeholder={t('media.filter.any')}
                onChange={(e) =>
                  onChange({ ...state, duration: { ...state.duration, min: e.target.value } })
                }
              />
              <span className="fdash">–</span>
              <input
                className={`fnum${badDuration(state.duration.max) ? ' bad' : ''}`}
                type="text"
                inputMode="text"
                spellCheck={false}
                value={state.duration.max}
                placeholder={t('media.filter.any')}
                onChange={(e) =>
                  onChange({ ...state, duration: { ...state.duration, max: e.target.value } })
                }
              />
            </div>

            <span className="flabel">{t('media.filter.rating')}</span>
            <div className="fstars">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`fstar${(state.rating ?? 0) >= n ? ' on' : ''}`}
                  onClick={() => onChange({ ...state, rating: state.rating === n ? null : n })}
                  aria-label={t('media.filter.ratingAtLeast', { n })}
                >
                  ★
                </button>
              ))}
              <span className="funit">{t('media.filter.andUp')}</span>
            </div>

            <div className="fchecks">
              {FLAGS.map((flag) => (
                <label key={flag}>
                  <input
                    type="checkbox"
                    checked={state.flags[flag]}
                    onChange={(e) =>
                      onChange({ ...state, flags: { ...state.flags, [flag]: e.target.checked } })
                    }
                  />
                  {t(`media.filter.flag.${flag}`)}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---- the box that narrows the list below, and the door to the panel ---- */}
      <div className="fhead">
        <div className="fsearch-wrap">
          <Search size={12} />
          <input
            className="bare"
            value={query}
            placeholder={t('media.filter.filterList')}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              // Enter is "I meant everything, not just this kind".
              if (e.key === 'Enter') onOpenNameSearch(query)
            }}
          />
        </div>
        <button
          className="icon-btn"
          title={t('media.filter.searchAllKinds')}
          onClick={() => onOpenNameSearch(query)}
        >
          <ScanSearch size={14} />
        </button>
      </div>

      {/* ---- one kind at a time. The old sidebar stacked five of these. ---- */}
      <div className="fkinds" role="group">
        {NAME_FIELDS_UI.map((field) => (
          <button
            key={field}
            className={kind === field ? 'on' : ''}
            aria-pressed={kind === field}
            title={t(`media.filter.kind.${field}`)}
            onClick={() => onKindChange(field)}
          >
            <i style={{ background: KIND_COLOR[field] }} />
            {t(`media.filter.kindShort.${field}`)}
          </button>
        ))}
        <button
          className={kind === 'folder' ? 'on' : ''}
          aria-pressed={kind === 'folder'}
          title={t('media.filter.kind.folder')}
          onClick={() => onKindChange('folder')}
        >
          <Folder size={10} />
          {t('media.filter.kindShort.folder')}
        </button>
      </div>

      <div className="flist-head">
        <span className="grow">
          {query.trim()
            ? t('media.filter.hitCount', { count: shown.length })
            : t('media.filter.totalCount', { count: rows.length })}
        </span>
        {/* Folders have no such choice: a media sits in exactly one, so asking
            for all of them at once would always come back empty. */}
        {kind !== 'folder' && state.names[kind].include.length > 1 && (
          <div className="flogic" role="group">
            {(['all', 'any'] as const).map((match) => (
              <button
                key={match}
                className={state.names[kind].match === match ? 'on' : ''}
                aria-pressed={state.names[kind].match === match}
                title={t(match === 'all' ? 'media.filter.matchAll' : 'media.filter.matchAny')}
                onClick={() =>
                  onChange({
                    ...state,
                    names: { ...state.names, [kind]: { ...state.names[kind], match } }
                  })
                }
              >
                {t(match === 'all' ? 'media.filter.matchAllShort' : 'media.filter.matchAnyShort')}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="filters-body">
        {rows.length === 0 && (
          <div className="fempty">
            {t(kind === 'folder' ? 'media.filter.noFolders' : 'media.filter.none')}
          </div>
        )}
        {rows.length > 0 && shown.length === 0 && (
          <div className="fempty">{t('media.filter.noHits')}</div>
        )}
        {visibleRows(shown, folded).map(({ row, hasChildren, open }) => {
          const on = isOn(row.key)
          return (
            <button
              key={row.key}
              className={`frow${on === 'in' ? ' sel' : on === 'ex' ? ' ex' : ''}${row.root ? ' froot' : ''}`}
              style={{ paddingLeft: `${0.5 + row.depth * 0.85}rem` }}
              onClick={(e) => pick(row.key, namePickFromEvent(e))}
              onContextMenu={(e) => {
                e.preventDefault()
                pick(row.key, 'exclude')
              }}
              title={row.title}
            >
              <span
                className="frow-caret"
                onClick={
                  hasChildren
                    ? (e) => {
                        e.stopPropagation()
                        setFolded((cur) => ({ ...cur, [row.key]: !cur[row.key] }))
                      }
                    : undefined
                }
              >
                {hasChildren && (open ? <ChevronDown size={11} /> : <ChevronRight size={11} />)}
              </span>
              {kind === 'folder' ? (
                <Folder size={11} className="frow-folder" />
              ) : (
                <i className="frow-dot" style={{ background: KIND_COLOR[kind] }} />
              )}
              <span className="frow-name">{row.label}</span>
              <span className="frow-n">{row.count}</span>
            </button>
          )
        })}
        {/* The cross-kind panel searches the vocabulary, which folders are no
            part of; on the folder list the box is all there is. */}
        {query.trim() && kind !== 'folder' && (
          <button className="fmore" onClick={() => onOpenNameSearch(query)}>
            {t('media.filter.searchAllFor', { query: query.trim() })}
          </button>
        )}
      </div>

      <div className="filters-foot">
        <button className="ghost grow" onClick={onOpenBuilder}>
          {t('media.filter.advanced')}
        </button>
        <button className="ghost" onClick={onSaveFilter}>
          {t('media.filter.save')}
        </button>
      </div>
    </aside>
  )
}
