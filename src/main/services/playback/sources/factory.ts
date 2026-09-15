import type { MediaSourceProfile } from '@shared/schemas/app-config'
import { HereSphereSource } from './heresphere-source'
import { InternalSource } from './internal-source'
import { MpcSource } from './mpc-source'
import { MpvSource } from './mpv-source'
import type { MediaSourceAdapter } from './port'

/** One saved profile → the adapter that talks to that player. */
export function createMediaSource(profile: MediaSourceProfile): MediaSourceAdapter {
  switch (profile.kind) {
    case 'internal':
      return new InternalSource()
    case 'mpv':
      return new MpvSource(profile.exePath)
    case 'mpc-hc':
      return new MpcSource(profile.host, profile.port, profile.exePath)
    case 'heresphere':
      return new HereSphereSource(profile.host, profile.port)
  }
}
