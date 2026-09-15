import { createConnection, type Socket } from 'node:net'
import type { OutputTransport, OutputTransportEvents } from '../../application/ports/output'

export class TcpTCodeTransport implements OutputTransport {
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
    if (this.socket && !this.socket.destroyed) return
    const socket = createConnection({ host: this.host, port: this.port })
    socket.setNoDelay(true)
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => {
        socket.destroy()
        reject(error)
      }
      socket.once('error', fail)
      socket.once('connect', () => {
        socket.off('error', fail)
        socket.on('error', () => {})
        socket.on('data', (chunk) => this.events.message?.(chunk.toString('utf8')))
        socket.on('close', () => this.events.closed?.())
        this.socket = socket
        resolve()
      })
    })
  }

  async send(payload: string): Promise<void> {
    const socket = this.socket
    if (!socket || socket.destroyed) throw new Error('tcp transport is not connected')
    await new Promise<void>((resolve, reject) => {
      socket.write(payload, (error) => (error ? reject(error) : resolve()))
    })
  }

  async disconnect(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket || socket.destroyed) return
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve())
      socket.end()
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy()
      }, 500).unref()
    })
  }
}
