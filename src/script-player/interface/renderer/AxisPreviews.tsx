import { useEffect, useMemo, useState } from 'react'
import type { InterpolationType } from '../../shared/config'
import { interpolateAt, type Point } from '../../domain/engine/interpolate'
import { OpenSimplex } from '../../domain/engine/noise'

// Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.

/** A short made-up script: a few held positions on a fifths grid, starting and ending at centre. */
function sampleKeyframes(count: number): Point[] {
  const frames: Point[] = [{ x: 0, y: 0.5 }]
  while (frames.length < count - 1) {
    const y = Math.min(1, Math.max(0, Math.round(Math.random() * 5) / 5))
    if (y === frames[frames.length - 1]!.y) continue
    const repeat = 1 + Math.floor(Math.random() * 3)
    for (let i = 0; frames.length !== count - 1 && i < repeat; i++) {
      frames.push({ x: frames.length / (count - 1), y })
    }
  }
  frames.push({ x: 1, y: 0.5 })
  return frames
}

/** What the chosen interpolation does to a script. Click for a different script. */
export function InterpolationPreview({
  type,
  width = 160,
  height = 80
}: {
  type: InterpolationType
  width?: number
  height?: number
}): React.JSX.Element {
  const [frames, setFrames] = useState(() => sampleKeyframes(8))
  const line = useMemo(() => {
    const plotted: string[] = []
    const step = 1 / 100
    for (let i = 0; i < frames.length - 1; i++) {
      for (let x = frames[i]!.x; x < frames[i + 1]!.x; x += step) {
        const y = Math.min(1, Math.max(0, interpolateAt(frames, i, x, type)))
        plotted.push(`${(x * width).toFixed(1)},${((1 - y) * height).toFixed(1)}`)
      }
    }
    return plotted.join(' ')
  }, [frames, type, width, height])

  return (
    <svg className="sp-preview" width={width} height={height} onPointerDown={() => setFrames(sampleKeyframes(8))}>
      <polyline className="sp-preview-line" points={line} />
      {frames.map((frame, index) => (
        <circle key={index} className="sp-preview-dot" cx={frame.x * width} cy={(1 - frame.y) * height} r={2.5} />
      ))}
    </svg>
  )
}

/** Five seconds of the random provider's noise at these settings. Click for another stretch. */
export function NoisePreview({
  octaves,
  persistence,
  lacunarity,
  height = 32
}: {
  octaves: number
  persistence: number
  lacunarity: number
  height?: number
}): React.JSX.Element {
  const noise = useMemo(() => new OpenSimplex(), [])
  const [seed, setSeed] = useState(0)
  const width = 220
  const length = 5
  const count = 300
  const line = useMemo(() => {
    const plotted: string[] = []
    const step = length / count
    for (let x = 0; x < length; x += step) {
      const y = noise.calculate2DOctaves(x, seed, octaves, persistence, lacunarity)
      plotted.push(`${((x / length) * width).toFixed(1)},${(((y + 1) / 2) * height).toFixed(1)}`)
    }
    return plotted.join(' ')
  }, [noise, seed, octaves, persistence, lacunarity, height])

  return (
    <svg
      className="sp-preview wide"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      height={height}
      onPointerDown={() => setSeed(Math.floor(Math.random() * 65536) - 32768)}
    >
      <polyline className="sp-preview-line" points={line} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/**
 * The smart limit's input, swept up and down on a loop so the curve can be
 * seen working: half a second at 0%, three seconds up, half a second at 100%,
 * three seconds down.
 */
export function useSweep(active: boolean): number {
  const [input, setInput] = useState(0)
  useEffect(() => {
    if (!active) return
    const started = performance.now()
    let frame = 0
    const tick = (now: number): void => {
      const t = ((now - started) / 1000) % 7
      setInput(t < 0.5 ? 0 : t < 3.5 ? ((t - 0.5) / 3) * 100 : t < 4 ? 100 : 100 - ((t - 4) / 3) * 100)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active])
  return input
}
