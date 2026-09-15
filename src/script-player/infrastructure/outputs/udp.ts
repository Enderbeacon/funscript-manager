import { createSocket, type Socket } from 'node:dgram'
import type { OutputTransport, OutputTransportEvents } from '../../application/ports/output'

export class UdpTCodeTransport implements OutputTransport {
  private socket: Socket | null = null
  private events: OutputTransportEvents = {}

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {}

  setEvents(events: OutputTransportEvents): void {
    this.events = events
  }

  async connect(): Promise<void> {
    if (this.socket) return
    const socket = createSocket('udp4')
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        socket.close()
        reject(error)
      }
      socket.once('error', fail)
      socket.connect(this.port, this.host, () => {
        socket.off('error', fail)
        socket.on('error', () => {})
        socket.on('message', (message) => this.events.message?.(message.toString('utf8')))
        socket.on('close', () => this.events.closed?.())
        this.socket = socket
        resolve()
      })
    })
  }

  async send(payload: string): Promise<void> {
    const socket = this.socket
    if (!socket) throw new Error('udp transport is not connected')
    await new Promise<void>((resolve, reject) => {
      socket.send(payload, (error) => (error ? reject(error) : resolve()))
    })
  }

  async disconnect(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    await new Promise<void>((resolve) => socket.close(() => resolve()))
  }
}
