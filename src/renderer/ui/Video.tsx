import { useEffect, useRef } from 'preact/hooks'
import type { JSX } from 'preact'

/**
 * srcObject can't be set as an attribute, so it needs a ref. Video also gets
 * paused when nothing is looking at it — a decoder running for a window the
 * user can't see is pure battery spend.
 */
export function Video({
  stream,
  muted = true,
  visible = true,
  class: className,
}: {
  stream: MediaStream | null
  muted?: boolean
  visible?: boolean
  class?: string
}): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    if (stream && visible) void el.play().catch(() => {})
    else if (!visible) el.pause()
    // Let go on unmount. A detached <video> still holding a live MediaStream
    // keeps a decoder referenced for as long as the element is reachable.
    return () => {
      el.pause()
      el.srcObject = null
    }
  }, [stream, visible])

  return (
    <video
      ref={ref}
      class={className}
      autoplay
      playsinline
      // Audio never comes out of a <video> here — the mixer owns every sink so
      // it can hold voices above the film.
      muted={muted}
    />
  )
}
