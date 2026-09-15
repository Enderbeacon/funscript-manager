import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CurvePoint, InterpolationType } from '../../shared/config'
import { advanceIndex } from '../../domain/engine/evaluate'
import { interpolateAt } from '../../domain/engine/interpolate'
import { curveKeyframes } from '../../domain/engine/motion-providers'

/** Samples across the width when the curve is not drawn straight point to point. */
const LINE_SAMPLES = 100
const POINT_RADIUS = 5

/**
 * A curve of draggable points.
 *
 * Drag a point to move it, double-click empty space to add one, double-click a
 * point to remove it (the last one stays). Points are kept sorted by `x`, and
 * the line between them is drawn with the same keyframes and interpolation the
 * player uses, so what is on screen is what the axis does.
 *
 * `width`/`height` are the curve's own units: seconds and 0..1 for a motion
 * curve, percent and percent for the smart limit.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */
export default function CurveEditor({
  points,
  width,
  height,
  interpolation = 'linear',
  loop = false,
  scrubber = null,
  pixelHeight,
  format,
  title,
  onChange
}: {
  points: readonly CurvePoint[]
  width: number
  height: number
  interpolation?: InterpolationType
  loop?: boolean
  /** Where to mark the curve, in `x` units; null hides the marker. */
  scrubber?: number | null
  pixelHeight: number
  format: (point: CurvePoint) => string
  title?: string
  onChange: (points: CurvePoint[]) => void
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const [pixelWidth, setPixelWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  const drag = useRef<{ point: CurvePoint; offsetX: number; offsetY: number; rect: DOMRect } | null>(null)
  const [dragging, setDragging] = useState<CurvePoint | null>(null)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box) return
    setPixelWidth(box.clientWidth)
    const observer = new ResizeObserver(() => setPixelWidth(box.clientWidth))
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!dragging) setHover((current) => current !== null && current >= points.length ? null : current)
  }, [points, dragging])

  const toX = (x: number): number => (x / width) * pixelWidth
  const toY = (y: number): number => (1 - y / height) * pixelHeight
  const fromX = (px: number): number => (px / pixelWidth) * width
  const fromY = (py: number): number => (1 - py / pixelHeight) * height

  const frames = useMemo(
    () => curveKeyframes(points, width, loop, interpolation),
    [points, width, loop, interpolation]
  )

  const line = useMemo(() => {
    if (frames.length === 0 || pixelWidth === 0) return ''
    const plotted: [number, number][] = []
    if (interpolation === 'linear') {
      for (const frame of frames) plotted.push([frame.x, frame.y])
    } else {
      let index = 0
      for (let i = 0; i < LINE_SAMPLES; i++) {
        const x = (i / (LINE_SAMPLES - 1)) * width
        index = advanceIndex(frames, index, x)
        if (index + 1 >= frames.length) break
        plotted.push([x, interpolateAt(frames, index, x, interpolation)])
      }
    }
    return plotted
      .map(([x, y]) => `${toX(x).toFixed(1)},${Math.min(pixelHeight, Math.max(0, toY(y))).toFixed(1)}`)
      .join(' ')
    // toX/toY only close over the values listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, interpolation, width, height, pixelWidth, pixelHeight])

  const marker = useMemo(() => {
    if (scrubber === null || !Number.isFinite(scrubber) || frames.length < 2) return null
    const index = advanceIndex(frames, -1, scrubber)
    if (index < 0 || index + 1 >= frames.length) return null
    return { x: scrubber, y: interpolateAt(frames, index, scrubber, interpolation) }
  }, [scrubber, frames, interpolation])

  // Pointer moves can outrun re-renders; a drag builds on what it last sent,
  // not on props that may not have caught up yet.
  const latest = useRef(points)
  if (!drag.current) latest.current = points

  const emit = (next: CurvePoint[]): void => {
    const sorted = [...next].sort((a, b) => a.x - b.x)
    latest.current = sorted
    onChange(sorted)
  }

  const clampedAt = (clientX: number, clientY: number, rect: DOMRect): CurvePoint => ({
    x: Math.round(fromX(Math.min(pixelWidth, Math.max(0, clientX - rect.left))) * 1000) / 1000,
    y: Math.round(fromY(Math.min(pixelHeight, Math.max(0, clientY - rect.top))) * 1000) / 1000
  })

  const startDrag = (event: React.PointerEvent<SVGCircleElement>, point: CurvePoint): void => {
    if (event.button !== 0 || !boxRef.current) return
    event.stopPropagation()
    const rect = boxRef.current.getBoundingClientRect()
    drag.current = {
      point,
      offsetX: event.clientX - rect.left - toX(point.x),
      offsetY: event.clientY - rect.top - toY(point.y),
      rect
    }
    setDragging(point)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveDrag = (event: React.PointerEvent<SVGCircleElement>): void => {
    const current = drag.current
    if (!current) return
    const moved = clampedAt(event.clientX - current.offsetX, event.clientY - current.offsetY, current.rect)
    const next = latest.current.map((point) => point === current.point ? moved : point)
    current.point = moved
    setDragging(moved)
    emit(next)
  }

  const endDrag = (event: React.PointerEvent<SVGCircleElement>): void => {
    if (!drag.current) return
    drag.current = null
    setDragging(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const addAt = (event: React.MouseEvent<SVGSVGElement>): void => {
    if (event.target !== event.currentTarget || !boxRef.current) return
    emit([...points, clampedAt(event.clientX, event.clientY, boxRef.current.getBoundingClientRect())])
  }

  const remove = (event: React.MouseEvent, point: CurvePoint): void => {
    event.stopPropagation()
    if (points.length <= 1) return
    emit(points.filter((candidate) => candidate !== point))
  }

  const labelled = dragging ?? (hover !== null ? points[hover] ?? null : null)

  return (
    <div className="sp-curve" ref={boxRef} style={{ height: pixelHeight }} title={title}>
      {pixelWidth > 0 && (
        <svg width={pixelWidth} height={pixelHeight} onDoubleClick={addAt}>
          <polyline className="sp-curve-line" points={line} />
          {marker && (
            <circle className="sp-curve-scrubber" cx={toX(marker.x)} cy={Math.min(pixelHeight, Math.max(0, toY(marker.y)))} r={4} />
          )}
          {points.map((point, index) => (
            <circle
              key={index}
              className={`sp-curve-point${point === dragging ? ' active' : ''}`}
              cx={toX(point.x)}
              cy={toY(point.y)}
              r={POINT_RADIUS}
              onPointerDown={(event) => startDrag(event, point)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerEnter={() => setHover(index)}
              onPointerLeave={() => setHover((current) => current === index ? null : current)}
              onDoubleClick={(event) => remove(event, point)}
            />
          ))}
        </svg>
      )}
      {labelled && (
        <span
          className="sp-curve-label"
          style={{
            left: Math.min(Math.max(0, toX(labelled.x) - 10), Math.max(0, pixelWidth - 60)),
            top: Math.max(0, toY(labelled.y) - 26)
          }}
        >
          {format(labelled)}
        </span>
      )}
    </div>
  )
}
