import { SerialPort } from 'serialport'
import type { OutputTransport, OutputTransportEvents } from '../../application/ports/output'

function callbackPromise(run: (done: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => (error ? reject(error) : resolve()))
  })
}

export class SerialTCodeTransport implements OutputTransport {
  private port: SerialPort | null = null
  private events: OutputTransportEvents = {}

  constructor(
    private readonly path: string,
    private readonly settings: {
      baudRate: number
      dataBits: 5 | 6 | 7 | 8
      stopBits: 1 | 1.5 | 2
      parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
      flowControl: 'none' | 'xonxoff' | 'rtscts' | 'rtscts-xonxoff'
      dtr: boolean
      rts: boolean
    }
  ) {}

  setEvents(events: OutputTransportEvents): void {
    this.events = events
  }

  async connect(): Promise<void> {
    if (this.port?.isOpen) return
    const softwareFlow = this.settings.flowControl === 'xonxoff' || this.settings.flowControl === 'rtscts-xonxoff'
    const hardwareFlow = this.settings.flowControl === 'rtscts' || this.settings.flowControl === 'rtscts-xonxoff'
    const port = new SerialPort({
      path: this.path,
      baudRate: this.settings.baudRate,
      dataBits: this.settings.dataBits,
      stopBits: this.settings.stopBits,
      parity: this.settings.parity,
      rtscts: hardwareFlow,
      xon: softwareFlow,
      xoff: softwareFlow,
      autoOpen: false
    })
    await callbackPromise((done) => port.open(done))
    await callbackPromise((done) => port.set({ dtr: this.settings.dtr, rts: this.settings.rts }, done))
    port.on('data', (chunk: Buffer) => this.events.message?.(chunk.toString('utf8')))
    port.on('close', () => this.events.closed?.())
    this.port = port
  }

  async send(payload: string): Promise<void> {
    const port = this.port
    if (!port?.isOpen) throw new Error('serial transport is not connected')
    await callbackPromise((done) => port.write(payload, done))
  }

  async disconnect(): Promise<void> {
    const port = this.port
    this.port = null
    if (!port?.isOpen) return
    await callbackPromise((done) => port.close(done)).catch(() => {})
  }

  static async list(): Promise<{ path: string; manufacturer: string | null }[]> {
    const ports = await SerialPort.list()
    return ports.map((port) => ({ path: port.path, manufacturer: port.manufacturer ?? null }))
  }
}
