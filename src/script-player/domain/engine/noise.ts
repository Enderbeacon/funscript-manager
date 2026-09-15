/**
 * 2D OpenSimplex noise, the source of the random motion provider.
 *
 * The permutation is shuffled with a 64-bit linear congruential generator whose
 * multiply wraps the way a signed 64-bit integer does, so it is done in BigInt;
 * everything after construction is plain doubles and 32-bit integer masks.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */

const PSIZE = 2048
const PMASK = PSIZE - 1
const SQUISH = 0.211324865405187
const STRETCH = 0.366025403784439

interface LatticePoint {
  xsv: number
  ysv: number
  dx: number
  dy: number
}

interface Gradient {
  dx: number
  dy: number
}

function latticePoint(xsv: number, ysv: number): LatticePoint {
  return {
    xsv,
    ysv,
    dx: -xsv + (xsv + ysv) * SQUISH,
    dy: -ysv + (xsv + ysv) * SQUISH
  }
}

const LATTICE_LOOKUP: LatticePoint[] = (() => {
  const lookup: LatticePoint[] = []
  for (let i = 0; i < 8; i++) {
    let i1: number, j1: number, i2: number, j2: number
    if ((i & 1) === 0) {
      j1 = i2 = 0
      i1 = (i & 2) === 0 ? -1 : 1
      j2 = (i & 4) === 0 ? -1 : 1
    } else {
      j1 = i2 = 1
      i1 = (i & 2) !== 0 ? 2 : 0
      j2 = (i & 4) !== 0 ? 2 : 0
    }
    lookup[i * 4 + 0] = latticePoint(0, 0)
    lookup[i * 4 + 1] = latticePoint(1, 1)
    lookup[i * 4 + 2] = latticePoint(i1, j1)
    lookup[i * 4 + 3] = latticePoint(i2, j2)
  }
  return lookup
})()

const GRAD_LOOKUP: Gradient[] = (() => {
  const n = 0.05481866495625118
  const grad: [number, number][] = [
    [0.130526192220052, 0.991444861373810],
    [0.382683432365090, 0.923879532511287],
    [0.608761429008721, 0.793353340291235],
    [0.793353340291235, 0.608761429008721],
    [0.923879532511287, 0.382683432365090],
    [0.991444861373810, 0.130526192220051],
    [0.991444861373810, -0.130526192220051],
    [0.923879532511287, -0.382683432365090],
    [0.793353340291235, -0.608761429008720],
    [0.608761429008721, -0.793353340291235],
    [0.382683432365090, -0.923879532511287],
    [0.130526192220052, -0.991444861373810],
    [-0.130526192220052, -0.991444861373810],
    [-0.382683432365090, -0.923879532511287],
    [-0.608761429008721, -0.793353340291235],
    [-0.793353340291235, -0.608761429008721],
    [-0.923879532511287, -0.382683432365090],
    [-0.991444861373810, -0.130526192220052],
    [-0.991444861373810, 0.130526192220051],
    [-0.923879532511287, 0.382683432365090],
    [-0.793353340291235, 0.608761429008721],
    [-0.608761429008721, 0.793353340291235],
    [-0.382683432365090, 0.923879532511287],
    [-0.130526192220052, 0.991444861373810]
  ]
  const lookup: Gradient[] = []
  for (let i = 0; i < PSIZE; i++) {
    const [dx, dy] = grad[i % grad.length]!
    lookup.push({ dx: dx / n, dy: dy / n })
  }
  return lookup
})()

/** A random non-negative 63-bit seed. */
export function randomNoiseSeed(): bigint {
  const high = BigInt(Math.floor(Math.random() * 0x80000000))
  const low = BigInt(Math.floor(Math.random() * 0x100000000))
  return (high << 32n) | low
}

export class OpenSimplex {
  private readonly perm = new Int16Array(PSIZE)
  private readonly grad: Gradient[] = new Array(PSIZE)

  constructor(seed: bigint = randomNoiseSeed()) {
    const source = new Int16Array(PSIZE)
    for (let i = 0; i < PSIZE; i++) source[i] = i

    let state = BigInt.asIntN(64, seed)
    for (let i = PSIZE - 1; i >= 0; i--) {
      state = BigInt.asIntN(64, state * 6364136223846793005n + 1442695040888963407n)
      // Remainder takes the sign of the dividend, as integer division does.
      let r = Number(BigInt.asIntN(64, state + 31n) % BigInt(i + 1))
      if (r < 0) r += i + 1
      this.perm[i] = source[r]!
      this.grad[i] = GRAD_LOOKUP[this.perm[i]!]!
      source[r] = source[i]!
    }
  }

  calculate2D(x: number, y: number): number {
    const s = STRETCH * (x + y)
    return this.calculate2DImpl(x + s, y + s)
  }

  /** Several octaves summed and normalised back into -1..1. */
  calculate2DOctaves(x: number, y: number, octaves: number, persistence: number, lacunarity: number): number {
    let frequency = 1
    let amplitude = 1
    let totalValue = 0
    let totalAmplitude = 0
    for (let i = 0; i < octaves; i++) {
      totalValue += this.calculate2D(x * frequency, y * frequency) * amplitude
      totalAmplitude += amplitude
      amplitude *= persistence
      frequency *= lacunarity
    }
    return totalValue / totalAmplitude
  }

  private calculate2DImpl(xs: number, ys: number): number {
    let value = 0
    const xsb = Math.floor(xs) | 0
    const ysb = Math.floor(ys) | 0
    const xsi = xs - xsb
    const ysi = ys - ysb

    const a = Math.trunc(xsi + ysi)
    const index =
      (a << 2) |
      (Math.trunc(xsi - ysi / 2 + 1 - a / 2) << 3) |
      (Math.trunc(ysi - xsi / 2 + 1 - a / 2) << 4)

    const ssi = (xsi + ysi) * -SQUISH
    const xi = xsi + ssi
    const yi = ysi + ssi

    for (let i = 0; i < 4; i++) {
      const c = LATTICE_LOOKUP[index + i]!
      const dx = xi + c.dx
      const dy = yi + c.dy
      let attn = 2 / 3 - dx * dx - dy * dy
      if (attn <= 0) continue

      const pxm = (xsb + c.xsv) & PMASK
      const pym = (ysb + c.ysv) & PMASK
      const grad = this.grad[this.perm[pxm]! ^ pym]!
      const extrapolation = grad.dx * dx + grad.dy * dy

      attn *= attn
      value += attn * attn * extrapolation
    }
    return value
  }
}
