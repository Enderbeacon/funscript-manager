import { useRef, useState } from 'react'

/** How close the two ends of a range may get: one percent, and ten pixels. */
const RANGE_MIN_GAP = 1
const RANGE_MIN_GAP_PX = 10

type RangeHandle = 'min' | 'max'
type RangeDrag =
  | { target: RangeHandle; rail: DOMRect }
  | { target: 'range'; rail: DOMRect; startAt: number; startMin: number; startMax: number }

/**
 * Two handles on one track.
 *
 * Not two stacked `<input type="range">`, which is what this was: they clamp
 * against each other, and a clamped change leaves React's value prop unchanged,
 * so React restores the DOM and the handle jumps back out from under the
 * pointer on every move. Stacked inputs also hide the lower handle once the two
 * are within a thumb's width, after which it cannot be grabbed at all.
 *
 * One pointer capture owns the drag. A handle changes one end; the selected
 * segment moves both ends by the same amount and clamps as a unit at 0 or 100.
 * The two handles are kept apart by a minimum of one percent and, separately,
 * of ten pixels: the percentage keeps the range usable, and the pixels keep
 * the handles from stacking where neither can be picked up again.
 */
export default function RangeSlider({
  min,
  max,
  marker,
  label,
  disabled,
  onChange
}: {
  min: number
  max: number
  marker: number | undefined
  label: string
  disabled: boolean
  onChange: (next: { min: number; max: number }) => void
}): React.JSX.Element {
  const railRef = useRef<HTMLDivElement>(null)
  // The rail is measured once when the drag starts. Measuring per move would
  // read layout right after writing the handle's position, which forces a
  // reflow on every pointer event — the drag has to stay cheap to feel attached.
  const dragging = useRef<RangeDrag | null>(null)
  const [active, setActive] = useState<RangeHandle | 'range' | null>(null)

  const railRect = (): DOMRect | null => railRef.current?.getBoundingClientRect() ?? null

  const percentIn = (rail: DOMRect, clientX: number): number =>
    rail.width <= 0 ? 0 : Math.min(100, Math.max(0, Math.round(((clientX - rail.left) / rail.width) * 100)))

  const move = (handle: RangeHandle, to: number, railWidth: number): void => {
    const gap = railWidth > 0
      ? Math.min(50, Math.max(RANGE_MIN_GAP, Math.ceil((RANGE_MIN_GAP_PX / railWidth) * 100)))
      : RANGE_MIN_GAP
    const next = handle === 'min'
      ? { min: Math.max(0, Math.min(to, max - gap)), max }
      : { min, max: Math.min(100, Math.max(to, min + gap)) }
    if (next.min !== min || next.max !== max) onChange(next)
  }

  const moveRange = (
    drag: Extract<RangeDrag, { target: 'range' }>,
    to: number
  ): void => {
    const offset = Math.min(
      100 - drag.startMax,
      Math.max(-drag.startMin, to - drag.startAt)
    )
    const next = { min: drag.startMin + offset, max: drag.startMax + offset }
    if (next.min !== min || next.max !== max) onChange(next)
  }

  const pick = (at: number): RangeHandle => {
    const toMin = Math.abs(at - min)
    const toMax = Math.abs(at - max)
    // A tie means the handles are on the same spot; the side pressed decides,
    // so a collapsed range can always be opened back up.
    if (toMin === toMax) return at <= min ? 'min' : 'max'
    return toMin < toMax ? 'min' : 'max'
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || event.button !== 0) return
    const rail = railRect()
    if (!rail) return
    const at = percentIn(rail, event.clientX)
    event.currentTarget.setPointerCapture(event.pointerId)
    const pressedHandle = event.target instanceof HTMLElement
      && event.target.classList.contains('sp-range-handle')
    if (!pressedHandle && at > min && at < max) {
      dragging.current = { target: 'range', rail, startAt: at, startMin: min, startMax: max }
      setActive('range')
      return
    }
    const handle = pick(at)
    dragging.current = { target: handle, rail }
    setActive(handle)
    move(handle, at, rail.width)
  }

  const dragTo = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragging.current
    if (!drag) return
    const to = percentIn(drag.rail, event.clientX)
    if (drag.target === 'range') moveRange(drag, to)
    else move(drag.target, to, drag.rail.width)
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging.current) return
    dragging.current = null
    setActive(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const nudge = (event: React.KeyboardEvent, handle: RangeHandle): void => {
    const from = handle === 'min' ? min : max
    const step = event.shiftKey ? 10 : 1
    let to: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') to = from - step
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') to = from + step
    else if (event.key === 'Home') to = 0
    else if (event.key === 'End') to = 100
    if (to === null) return
    event.preventDefault()
    move(handle, Math.min(100, Math.max(0, to)), railRect()?.width ?? 0)
  }

  return (
    <div
      className={`sp-range${disabled ? ' disabled' : ''}${active === 'range' ? ' dragging-range' : ''}`}
      title={`${min}% – ${max}%${marker === undefined ? '' : ` · ${Math.round(marker * 100)}%`}`}
      onPointerDown={startDrag}
      onPointerMove={dragTo}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="sp-range-rail" ref={railRef}>
        <div className="sp-range-fill" style={{ left: `${min}%`, right: `${100 - max}%` }} />
        {marker !== undefined && (
          <div className="sp-range-marker" style={{ left: `${Math.min(100, Math.max(0, marker * 100))}%` }} />
        )}
        {(['min', 'max'] as const).map((handle) => (
          <div
            key={handle}
            className={`sp-range-handle${active === handle ? ' active' : ''}`}
            style={{ left: `${handle === 'min' ? min : max}%` }}
            role="slider"
            tabIndex={disabled ? -1 : 0}
            aria-label={`${label} ${handle}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={handle === 'min' ? min : max}
            aria-disabled={disabled}
            onKeyDown={(event) => nudge(event, handle)}
          />
        ))}
      </div>
    </div>
  )
}
