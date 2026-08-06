// Minimal declarations for the slice of WebCodecs we use. Chromium has these;
// TypeScript's lib.dom does not, and pulling in a whole @types package for one
// class isn't worth it.

interface AudioData {
  readonly numberOfFrames: number
  readonly numberOfChannels: number
  readonly sampleRate: number
  copyTo(destination: Float32Array, options: { planeIndex: number; format?: string }): void
  close(): void
}

declare class MediaStreamTrackProcessor<T = AudioData> {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<T>
}
