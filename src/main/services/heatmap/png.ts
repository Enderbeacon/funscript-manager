import { deflateSync } from 'node:zlib'

/**
 * Minimal PNG encoder: 8-bit RGBA, filter 0, single IDAT. Hand-rolled to
 * avoid pulling in a canvas/image dependency for a fixed, trivial use case
 * (heatmap strips). PNG spec: signature + IHDR + IDAT (zlib) + IEND, each
 * chunk CRC32-tagged.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(...buffers: Buffer[]): number {
  let crc = 0xffffffff
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(typeBuf, data))
  return Buffer.concat([head, typeBuf, data, tail])
}

/** Encode a width*height*4 RGBA buffer as a PNG file. */
export function encodePngRgba(pixels: Uint8Array, width: number, height: number): Buffer {
  if (pixels.length !== width * height * 4) {
    throw new Error(`pixel buffer length ${pixels.length} != ${width}x${height}x4`)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  // compression / filter / interlace all 0

  // Raw scanlines: each row prefixed with filter byte 0 (None).
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
