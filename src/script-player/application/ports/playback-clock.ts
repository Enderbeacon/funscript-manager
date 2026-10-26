export interface PlaybackSample {
  mediaId: string | null
  scriptVersionId: string | null
  positionMs: number | null
  paused: boolean | null
  playbackRate?: number
}

export interface PlaybackClockPort {
  sample(): PlaybackSample
}

