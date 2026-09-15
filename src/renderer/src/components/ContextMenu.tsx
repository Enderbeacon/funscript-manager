import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ChevronLeft, ChevronRight, Search } from 'lucide-react'

/**
 * A menu that opens where the pointer is.
 *
 * Rendered into `document.body` for the same reason the chip menus are: every
 * card in this app has a `backdrop-filter`, which makes it its own stacking
 * context, and a menu drawn inside one cannot be raised above the card that
 * comes after it whatever z-index it is given.
 *
 * Deeper levels replace the menu rather than flying out sideways. A fly-out has
 * to be chased with the pointer along a diagonal, and it is the one that runs
 * off the edge of the window; a page that swaps in place with a way back is
 * both easier to hit and always somewhere it fits.
 */

export interface MenuItem {
  key: string
  label: string
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  /** Small grey text at the right — a count, a shortcut. */
  hint?: string
  /** Opens a page of its own instead of doing something. */
  children?: MenuItem[]
  /** Give that page a filter box; for lists that can run long. */
  searchable?: boolean
  onPick?: () => void
}

/** Keeps the menu clear of the window edge. */
const MARGIN = 8

export default function ContextMenu({
  x,
  y,
  items,
  onClose,
  container
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /**
   * Where to draw it. The body is right for everything on a page, and wrong
   * for the one thing that is not on a page: a full-screen element is all the
   * browser paints, so a menu on the body would be nowhere to be seen.
   */
  container?: HTMLElement | null
}): React.JSX.Element {
  const { t } = useTranslation()
  const boxRef = useRef<HTMLDivElement | null>(null)
  const [at, setAt] = useState<{ left: number; top: number }>({ left: x, top: y })
  /** Where we are: the root, or a chain of items drilled into. */
  const [path, setPath] = useState<MenuItem[]>([])
  const [query, setQuery] = useState('')

  const page = path.at(-1)
  const shown = useMemo(() => {
    const list = page?.children ?? items
    const q = query.trim().toLowerCase()
    return q ? list.filter((item) => item.label.toLowerCase().includes(q)) : list
  }, [items, page, query])

  // Measured after mount, so a menu opened near the bottom or the right edge
  // comes back inside instead of being half off the screen.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    const { width, height } = box.getBoundingClientRect()
    setAt({
      left: Math.max(MARGIN, Math.min(x, window.innerWidth - width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN))
    })
  }, [x, y, path])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (path.length > 0) setPath((cur) => cur.slice(0, -1))
      else onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, path.length])

  const enter = (item: MenuItem): void => {
    setPath((cur) => [...cur, item])
    setQuery('')
  }

  return createPortal(
    <>
      <div className="chip-scrim" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        ref={boxRef}
        className="ctxmenu"
        style={{ left: at.left, top: at.top }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {page && (
          <button
            className="ctx-back"
            onClick={() => {
              setPath((cur) => cur.slice(0, -1))
              setQuery('')
            }}
          >
            <ChevronLeft size={13} />
            <span className="grow">{page.label}</span>
          </button>
        )}
        {(page?.searchable ?? false) && (
          <div className="ctx-find">
            <Search size={12} />
            <input
              className="bare"
              autoFocus
              value={query}
              placeholder={t('common.search')}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
        <div className="ctx-list">
          {shown.length === 0 && <div className="ctx-empty">{t('common.noResults')}</div>}
          {shown.map((item) => (
            <button
              key={item.key}
              className={`ctx-hit${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.children) {
                  enter(item)
                  return
                }
                item.onPick?.()
                onClose()
              }}
            >
              {item.icon && <span className="ctx-icon">{item.icon}</span>}
              <span className="grow">{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
              {item.children && <ChevronRight size={12} />}
            </button>
          ))}
        </div>
      </div>
    </>,
    container ?? document.body
  )
}
