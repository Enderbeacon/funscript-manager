export type OutputConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'error'

export interface OutputTransportEvents {
  message?: (payload: string) => void
  closed?: () => void
}

export interface OutputTransport {
  setEvents(events: OutputTransportEvents): void
  connect(): Promise<void>
  send(payload: string): Promise<void>
  disconnect(): Promise<void>
}
