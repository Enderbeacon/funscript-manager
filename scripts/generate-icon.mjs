import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Rasterize the geometry in assets/brand/mark.svg without adding an image
 * dependency to the application. ICO stores PNG frames, one for every size
 * Windows commonly asks for in Explorer, shortcuts and the taskbar.
 */

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'build')
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const scale = 4

const f = [
  [28, 28], [88, 28], [78, 43], [44, 43], [44, 58], [65, 58],
  [55, 73], [44, 73], [44, 100], [28, 100]
]
const curve = [[60, 97], [74, 76], [87, 89], [102, 62]]

function clamp(value, min, max) {
  return Math.max(min, Math.min(value, max))
}

function inRoundedSquare(x, y) {
  if (x < 0 || y < 0 || x > 128 || y > 128) return false
  const nearestX = clamp(x, 28, 100)
  const nearestY = clamp(y, 28, 100)
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 <= 28 ** 2
}

function inPolygon(x, y, points) {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i]
    const [xj, yj] = points[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax
  const dy = by - ay
  const amount = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy), 0, 1)
  return Math.hypot(x - (ax + amount * dx), y - (ay + amount * dy))
}

function isWhite(x, y) {
  if (inPolygon(x, y, f)) return true
  for (let i = 1; i < curve.length; i++) {
    if (distanceToSegment(x, y, curve[i - 1], curve[i]) <= 3.5) return true
  }
  return Math.hypot(x - 102, y - 62) <= 5
}

function colorAt(x, y) {
  if (isWhite(x, y)) return [255, 255, 255]
  const amount = clamp(((x - 12) * 104 + (y - 8) * 112) / (104 ** 2 + 112 ** 2), 0, 1)
  return [
    Math.round(76 + (147 - 76) * amount),
    Math.round(111 + (51 - 111) * amount),
    Math.round(255 + (234 - 255) * amount)
  ]
}

function raster(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const samples = scale * scale
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let red = 0
      let green = 0
      let blue = 0
      let covered = 0
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const x = ((px + (sx + 0.5) / scale) * 128) / size
          const y = ((py + (sy + 0.5) / scale) * 128) / size
          if (!inRoundedSquare(x, y)) continue
          const color = colorAt(x, y)
          red += color[0]
          green += color[1]
          blue += color[2]
          covered++
        }
      }
      const offset = (py * size + px) * 4
      if (covered > 0) {
        rgba[offset] = Math.round(red / covered)
        rgba[offset + 1] = Math.round(green / covered)
        rgba[offset + 2] = Math.round(blue / covered)
      }
      rgba[offset + 3] = Math.round((covered / samples) * 255)
    }
  }
  return rgba
}

const crcTable = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  return crc >>> 0
})

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(name, data) {
  const type = Buffer.from(name, 'ascii')
  const result = Buffer.alloc(12 + data.length)
  result.writeUInt32BE(data.length, 0)
  type.copy(result, 4)
  data.copy(result, 8)
  result.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)
  return result
}

function png(size) {
  const rgba = raster(size)
  const rows = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1)
    rows[row] = 0
    rgba.copy(rows, row + 1, y * size * 4, (y + 1) * size * 4)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function ico(frames) {
  const directory = Buffer.alloc(6 + frames.length * 16)
  directory.writeUInt16LE(0, 0)
  directory.writeUInt16LE(1, 2)
  directory.writeUInt16LE(frames.length, 4)
  let offset = directory.length
  frames.forEach(({ size, image }, index) => {
    const entry = 6 + index * 16
    directory[entry] = size === 256 ? 0 : size
    directory[entry + 1] = size === 256 ? 0 : size
    directory.writeUInt16LE(1, entry + 4)
    directory.writeUInt16LE(32, entry + 6)
    directory.writeUInt32LE(image.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.length
  })
  return Buffer.concat([directory, ...frames.map(({ image }) => image)])
}

mkdirSync(output, { recursive: true })
const frames = sizes.map((size) => ({ size, image: png(size) }))
writeFileSync(join(output, 'icon.ico'), ico(frames))
writeFileSync(join(output, 'icon.png'), frames.at(-1).image)
console.log(`Generated build/icon.ico and build/icon.png (${sizes.join(', ')} px)`)
