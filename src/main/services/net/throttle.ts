import { Transform } from 'node:stream'
import { getSettings } from '../config/config-service'

/**
 * Transfer limiting.
 *
 * Two modes, because they answer different questions. `perTask` is "no single
 * download may take more than this"; `total` is "the app may not take more
 * than this". The app's own transfers (every direct-link plugin, mega) share
 * one bucket in `total` mode, so that ceiling is exact.
 *
 * yt-dlp is a separate process holding its own socket: it can only limit
 * itself. In `total` mode it is given an equal share of the ceiling based on
 * how many downloads are running when it starts — an approximation, and the
 * one place where the total can be exceeded (a job finishing frees a share the
 * running ones will not pick up until they restart).
 */

/** How fast a bucket may run dry before refusing, i.e. the burst allowance. */
const BURST_SECONDS = 1

class TokenBucket {
  private tokens: number
  private last = Date.now()

  constructor(readonly bytesPerSec: number) {
    this.tokens = bytesPerSec * BURST_SECONDS
  }

  /** Resolves once `count` bytes may pass. Waiters are served as tokens accrue. */
  async take(count: number): Promise<void> {
    for (;;) {
      const now = Date.now()
      this.tokens = Math.min(
        this.bytesPerSec * BURST_SECONDS,
        this.tokens + ((now - this.last) / 1000) * this.bytesPerSec
      )
      this.last = now
      if (this.tokens >= count) {
        this.tokens -= count
        return
      }
      // A chunk larger than the whole burst allowance would never fit; waiting
      // for the burst is the closest thing to "one chunk per refill".
      const needed = Math.min(count, this.bytesPerSec * BURST_SECONDS) - this.tokens
      await new Promise((r) => setTimeout(r, Math.ceil((needed / this.bytesPerSec) * 1000)))
    }
  }
}

/** The shared bucket for `total` mode; rebuilt when the ceiling changes. */
let totalBucket: TokenBucket | null = null

/** Running downloads, published by the queue so yt-dlp can be given a share. */
let activeDownloads = 0

export function setActiveDownloads(count: number): void {
  activeDownloads = count
}

async function limitSettings(): Promise<{ mode: 'off' | 'perTask' | 'total'; bytesPerSec: number }> {
  const { download } = await getSettings()
  const { mode, bytesPerSec } = download.rateLimit
  return bytesPerSec > 0 ? { mode, bytesPerSec } : { mode: 'off', bytesPerSec: 0 }
}

/**
 * The bucket a transfer about to start should pass its bytes through, or null
 * when nothing is capped. Call once per download attempt: in `perTask` mode
 * each attempt gets its own allowance, in `total` mode they all get the one.
 */
async function acquireBucket(): Promise<TokenBucket | null> {
  const { mode, bytesPerSec } = await limitSettings()
  if (mode === 'off') return null
  if (mode === 'perTask') return new TokenBucket(bytesPerSec)
  if (!totalBucket || totalBucket.bytesPerSec !== bytesPerSec) {
    totalBucket = new TokenBucket(bytesPerSec)
  }
  return totalBucket
}

/**
 * A stream stage that paces the bytes flowing through it, or null when there
 * is no limit — callers pipe through it only when they get one, so an unlimited
 * download keeps the exact stream shape it had before.
 */
export async function throttleStage(): Promise<Transform | null> {
  const bucket = await acquireBucket()
  if (!bucket) return null
  return new Transform({
    async transform(chunk: Buffer, _enc, done) {
      try {
        await bucket.take(chunk.length)
        done(null, chunk)
      } catch (e) {
        done(e as Error)
      }
    }
  })
}

/** yt-dlp's `--limit-rate` value in bytes per second, or null for no limit. */
export async function processRateLimit(): Promise<number | null> {
  const { mode, bytesPerSec } = await limitSettings()
  if (mode === 'off') return null
  if (mode === 'perTask') return bytesPerSec
  return Math.max(1, Math.floor(bytesPerSec / Math.max(1, activeDownloads)))
}
