import type { OutputTransport, OutputTransportEvents } from '../../application/ports/output'
import { unprotectString } from '../credentials/protected-string'

const API_BASE = 'https://www.handyfeeling.com/api/handy/v2'

export class HandyOutputTransport implements OutputTransport {
  private events: OutputTransportEvents = {}
  private controller: AbortController | null = null
  private headers: Record<string, string> = {}

  constructor(private readonly protectedConnectionKey: string) {}

  setEvents(events: OutputTransportEvents): void {
    this.events = events
  }

  async connect(): Promise<void> {
    const connectionKey = unprotectString(this.protectedConnectionKey)
    this.controller = new AbortController()
    this.headers = { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Connection-Key': connectionKey }

    const connected = await this.request('connected')
    if (connected.connected !== true) throw new Error('handy device is offline')
    const info = await this.request('info')
    if (info.fwStatus === 1) throw new Error('handy firmware update required')
    const mode = await this.request('mode', 'PUT', { mode: 2 })
    if (mode.result === -1) throw new Error('unable to enter HDSP mode')

    // Thirty round trips with the extremes trimmed, before reporting ready. The
    // average is reported to the UI rather than used to correct timing: it is a
    // warm-up and a latency reading the user can act on.
    const samples: number[] = []
    for (let index = 0; index < 30; index++) {
      const startedAt = performance.now()
      await this.request('servertime')
      samples.push(performance.now() - startedAt)
    }
    samples.sort((a, b) => a - b)
    const trimmed = samples.slice(3, -3)
    const averageRttMs = trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length
    this.events.message?.(JSON.stringify({ connected: true, averageRttMs: Math.round(averageRttMs) }))
  }

  async send(payload: string): Promise<void> {
    const body = JSON.parse(payload) as Record<string, unknown>
    const response = await this.request('hdsp/xpt', 'PUT', body)
    this.events.message?.(JSON.stringify(response))
  }

  async disconnect(): Promise<void> {
    this.controller?.abort()
    this.controller = null
    this.headers = {}
  }

  private async request(path: string, method = 'GET', body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${API_BASE}/${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: this.controller?.signal
    })
    if (!response.ok) throw new Error(`handy api status ${response.status}`)
    const json = await response.json() as Record<string, unknown>
    if (json.error) throw new Error('handy api error')
    return json
  }
}
