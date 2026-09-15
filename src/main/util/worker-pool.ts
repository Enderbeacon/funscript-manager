import { parentPort, Worker } from 'node:worker_threads'

/**
 * Generic worker_threads pool: fixed-size,
 * spawn-on-demand, crashed workers fail their inflight tasks and are
 * replaced lazily by the next pump. Used by fingerprint and heatmap.
 *
 * Wire protocol: `{ id, payload }` in → `{ id, ok: true, value } |
 * { id, ok: false, error }` out. Workers implement their half with
 * `servePool()` below.
 */

export interface PoolRequest<TReq> {
  id: number
  payload: TReq
}

export type PoolResponse<TRes> =
  | { id: number; ok: true; value: TRes }
  | { id: number; ok: false; error: string }

interface PendingTask<TReq, TRes> {
  payload: TReq
  resolve: (value: TRes) => void
  reject: (err: Error) => void
}

export class WorkerPool<TReq, TRes> {
  private workers: Worker[] = []
  private idle: Worker[] = []
  private queue: PendingTask<TReq, TRes>[] = []
  private inflight = new Map<number, PendingTask<TReq, TRes>>()
  private byWorker = new Map<Worker, number[]>()
  private nextId = 1
  private disposed = false

  constructor(
    private readonly modulePath: string,
    private readonly size: number,
    private readonly label: string
  ) {}

  run(payload: TReq): Promise<TRes> {
    if (this.disposed) return Promise.reject(new Error(`${this.label} pool disposed`))
    return new Promise<TRes>((resolve, reject) => {
      this.queue.push({ payload, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const worker = this.idle.pop() ?? this.spawnIfBelowCap()
      if (!worker) return
      const task = this.queue.shift()!
      const id = this.nextId++
      this.inflight.set(id, task)
      this.byWorker.get(worker)!.push(id)
      worker.postMessage({ id, payload: task.payload } satisfies PoolRequest<TReq>)
    }
  }

  private spawnIfBelowCap(): Worker | null {
    if (this.workers.length >= this.size) return null
    const worker = new Worker(this.modulePath)
    this.workers.push(worker)
    this.byWorker.set(worker, [])

    worker.on('message', (res: PoolResponse<TRes>) => {
      const task = this.inflight.get(res.id)
      this.inflight.delete(res.id)
      const ids = this.byWorker.get(worker)
      if (ids) ids.splice(ids.indexOf(res.id), 1)
      if (task) {
        if (res.ok) task.resolve(res.value)
        else task.reject(new Error(res.error))
      }
      if (!this.disposed) {
        this.idle.push(worker)
        this.pump()
      }
    })

    // A crashed worker fails its inflight tasks; it is removed and a fresh
    // one is spawned on demand by the next pump().
    worker.on('error', (err) =>
      this.dropWorker(worker, err instanceof Error ? err : new Error(String(err)))
    )
    worker.on('exit', (code) => {
      if (code !== 0) this.dropWorker(worker, new Error(`${this.label} worker exited with ${code}`))
    })

    return worker
  }

  private dropWorker(worker: Worker, err: Error): void {
    this.workers = this.workers.filter((w) => w !== worker)
    this.idle = this.idle.filter((w) => w !== worker)
    for (const id of this.byWorker.get(worker) ?? []) {
      this.inflight.get(id)?.reject(err)
      this.inflight.delete(id)
    }
    this.byWorker.delete(worker)
    void worker.terminate()
    this.pump()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const err = new Error(`${this.label} pool disposed`)
    for (const task of this.queue) task.reject(err)
    this.queue = []
    for (const task of this.inflight.values()) task.reject(err)
    this.inflight.clear()
    await Promise.allSettled(this.workers.map((w) => w.terminate()))
    this.workers = []
    this.idle = []
  }
}

/** Worker-side half of the protocol: wire a handler to parentPort. */
export function servePool<TReq, TRes>(handler: (payload: TReq) => Promise<TRes>): void {
  parentPort?.on('message', (req: PoolRequest<TReq>) => {
    handler(req.payload)
      .then((value) =>
        parentPort?.postMessage({ id: req.id, ok: true, value } satisfies PoolResponse<TRes>)
      )
      .catch((e: unknown) =>
        parentPort?.postMessage({
          id: req.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e)
        } satisfies PoolResponse<TRes>)
      )
  })
}
