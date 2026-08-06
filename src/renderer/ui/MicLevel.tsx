import { useEffect, useState } from 'preact/hooks'
import type { JSX } from 'preact'

/**
 * A live level bar under the home-screen preview.
 *
 * The question everybody has before a call is "can they actually hear me?", and
 * the usual answer is to start the call and ask. A bar that moves when you
 * speak answers it in one second, and catches the muted-input and
 * wrong-microphone cases before they waste anyone's evening.
 *
 * It runs only here, on the home screen — never during a call, where the mixer's
 * existing 10 Hz poll already does the metering it needs.
 */
export function MicLevel({ stream, muted }: { stream: MediaStream | null; muted: boolean }): JSX.Element | null {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!stream || muted) {
      setLevel(0)
      return
    }
    const track = stream.getAudioTracks()[0]
    if (!track) return

    let context: AudioContext | null = null
    let raf = 0
    let stopped = false

    try {
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.smoothingTimeConstant = 0.75
      context.createMediaStreamSource(new MediaStream([track])).connect(analyser)
      const buffer = new Float32Array(analyser.fftSize)

      const tick = () => {
        if (stopped) return
        analyser.getFloatTimeDomainData(buffer)
        let peak = 0
        for (const sample of buffer) {
          const abs = Math.abs(sample)
          if (abs > peak) peak = abs
        }
        // Speech sits low in a linear scale; a gentle curve makes normal talking
        // fill most of the bar instead of twitching along the bottom.
        setLevel(Math.min(1, Math.pow(peak, 0.6) * 1.6))
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    } catch {
      /* no audio context available; the bar just stays still */
    }

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      void context?.close().catch(() => {})
    }
  }, [stream, muted])

  if (!stream) return null

  return (
    <div class="level" aria-hidden="true">
      <div
        class="level__fill"
        style={{ transform: `scaleX(${muted ? 0 : level.toFixed(3)})` }}
      />
    </div>
  )
}
