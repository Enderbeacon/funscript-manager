export interface PlaybackSample {
  mediaId: string | null
  scriptVersionId: string | null
  positionMs: number | null
  paused: boolean | null
}

export interface PlaybackClockPort {
  sample(): PlaybackSample
}

