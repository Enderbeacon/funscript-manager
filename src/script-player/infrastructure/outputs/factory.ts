import type { OutputTransport } from '../../application/ports/output'
import type { TCodeOutputProfile } from '../../shared/config'
import { SerialTCodeTransport } from './serial'
import { TcpTCodeTransport } from './tcp'
import { UdpTCodeTransport } from './udp'
import { WebSocketTCodeTransport } from './websocket'
import { HandyOutputTransport } from './handy'

export function createOutputTransport(profile: TCodeOutputProfile): OutputTransport {
  switch (profile.transport) {
    case 'serial':
      return new SerialTCodeTransport(profile.endpoint, {
        baudRate: profile.baudRate,
        dataBits: profile.dataBits,
        stopBits: profile.stopBits,
        parity: profile.parity,
        flowControl: profile.flowControl,
        dtr: profile.dtr,
        rts: profile.rts
      })
    case 'udp':
      return new UdpTCodeTransport(profile.endpoint, profile.port)
    case 'tcp':
      return new TcpTCodeTransport(profile.endpoint, profile.port)
    case 'websocket':
      return new WebSocketTCodeTransport(profile.endpoint)
    case 'handy':
      return new HandyOutputTransport(profile.connectionKey)
  }
}
