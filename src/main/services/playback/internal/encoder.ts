import { spawn } from 'node:child_process'

/**
 * Which H.264 encoder converts video for the picture.
 *
 * A graphics card's encoder keeps up with a 4K source where the CPU would fall
 * behind, so those are tried first. Whether one works depends on the card and
 * its driver, not on the ffmpeg build — every build lists all three — so each
 * is tried with the exact options it would be run with, and the first that
 * encodes a few frames wins. libx264 always works.
 */

interface Candidate {
  name: string
  args: string[]
}

/**
 * No B-frames and a keyframe every couple of seconds: the stream is cut into
 * fragments at keyframes, and the picture can only start on one.
 */
const HARDWARE: Candidate[] = [
  {
    name: 'h264_nvenc',
    args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-bf', '0', '-g', '60']
  },
  {
    name: 'h264_qsv',
    args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '21', '-bf', '0', '-g', '60']
  },
  {
    name: 'h264_amf',
    args: ['-c:v', 'h264_amf', '-usage', 'lowlatency', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '21', '-qp_p', '21', '-bf', '0', '-g', '60']
  },
]

const SOFTWARE: Candidate = {
  name: 'libx264',
  args: ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '21', '-g', '60']
}

/**
 * Applied to whichever encoder is chosen.
 *
 * `passthrough` keeps every source frame at its own time instead of evening
 * them out to a fixed rate, and `demux` keeps the source's time base, so a
 * frame stored at 7.313s is not rounded to the nearest 1/30s — either would
 * move the picture against the script.
 */
const COMMON = ['-pix_fmt', 'yuv420p', '-fps_mode', 'passthrough', '-enc_time_base:v', 'demux']

const chosen = new Map<string, Promise<string[]>>()

/** Encoder options for this ffmpeg, found once per run. */
export function videoEncoderArgs(ffmpeg: string): Promise<string[]> {
  let found = chosen.get(ffmpeg)
  if (!found) {
    found = pick(ffmpeg)
    chosen.set(ffmpeg, found)
  }
  return found
}

async function pick(ffmpeg: string): Promise<string[]> {
  let candidate = SOFTWARE
  for (const card of HARDWARE) {
    if (await encodes(ffmpeg, card.args)) {
      candidate = card
      break
    }
  }
  console.log(`[player] converting video with ${candidate.name}`)
  return [...candidate.args, ...COMMON]
}

function encodes(ffmpeg: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(
        ffmpeg,
        [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
          '-frames:v', '5', ...args, ...COMMON, '-f', 'null', '-'
        ],
        { stdio: 'ignore', windowsHide: true }
      )
    } catch {
      resolve(false)
      return
    }
    // A driver that hangs on initialisation is a no, not a stuck player.
    const timer = setTimeout(() => proc.kill(), 10_000)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}
