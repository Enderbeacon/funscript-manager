import { WebSocket } from 'undici'
import type { OutputTransport, OutputTransportEvents } from '../../application/ports/output'

export class WebSocketTCodeTransport implements OutputTransport {
  private socket: WebSocket | null = null
  private events: OutputTransportEvents = {}

  constructor(private readonly url: string) {}

  setEvents(events: OutputTransportEvents): void {
    this.events = events
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return
    const socket = new WebSocket(this.url)
    await new Promise<void>((resolve, reject) => {
      const opened = (): void => {
        cleanup()
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') this.events.message?.(event.data)
          else if (event.data instanceof ArrayBuffer) {
            this.events.message?.(new TextDecoder().decode(event.data))
          }
        })
        socket.addEventListener('close', () => this.events.closed?.())
        this.socket = socket
        resolve()
      }
      const failed = (): void => {
        cleanup()
        socket.close()
        reject(new Error('websocket connection failed'))
      }
      const cleanup = (): void => {
        socket.removeEventListener('open', opened)
        socket.removeEventListener('error', failed)
      }
      socket.addEventListener('open', opened)
      socket.addEventListener('error', failed)
    })
  }

  async send(payload: string): Promise<void> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('websocket transport is not connected')
    }
    socket.send(payload)
  }

  async disconnect(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (!socket || socket.readyState === WebSocket.CLOSED) return
    socket.close(1000)
  }
}
