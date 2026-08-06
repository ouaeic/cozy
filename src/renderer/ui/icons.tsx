import type { JSX } from 'preact'

// Hand-rolled so there's no icon package to pull in for a dozen glyphs.
// 24×24, 1.7px stroke, round caps — one visual family.

const paths: Record<string, JSX.Element> = {
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3.5" />
    </>
  ),
  micOff: (
    <>
      <path d="M9 5.2A3 3 0 0 1 15 6v4.2" />
      <path d="M15 13.4a3 3 0 0 1-6-1.4V8.6" />
      <path d="M5 11a7 7 0 0 0 10.5 6.06M19 11a7 7 0 0 1-.4 2.3" />
      <path d="M12 18v3.5" />
      <path d="M3.5 3.5l17 17" />
    </>
  ),
  cam: (
    <>
      <rect x="2.5" y="6" width="13" height="12" rx="3" />
      <path d="M15.5 10.5l6-3.2v9.4l-6-3.2z" />
    </>
  ),
  camOff: (
    <>
      <path d="M15.5 13.2V15a3 3 0 0 1-3 3h-10a3 3 0 0 1 0-.2V9a3 3 0 0 1 3-3h1.3" />
      <path d="M10.8 6h1.7a3 3 0 0 1 3 3v1.5l6-3.2v9.4l-3-1.6" />
      <path d="M3.5 3.5l17 17" />
    </>
  ),
  share: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M8 20.5h8" />
      <path d="M12 8.2v5.4M12 8.2l-2.4 2.4M12 8.2l2.4 2.4" />
    </>
  ),
  shareOff: (
    <>
      <rect x="2.5" y="4" width="19" height="13" rx="2.5" />
      <path d="M8 20.5h8" />
      <path d="M9.4 8.4l5.2 5.2M14.6 8.4l-5.2 5.2" />
    </>
  ),
  sound: (
    <>
      <path d="M4 9.2h3.4L12 5.4v13.2L7.4 14.8H4z" />
      <path d="M15.6 9.6a3.6 3.6 0 0 1 0 4.8" />
      <path d="M18.4 7a7.4 7.4 0 0 1 0 10" />
    </>
  ),
  expand: (
    <>
      <path d="M3.5 9V4.5a1 1 0 0 1 1-1H9" />
      <path d="M15 3.5h4.5a1 1 0 0 1 1 1V9" />
      <path d="M20.5 15v4.5a1 1 0 0 1-1 1H15" />
      <path d="M9 20.5H4.5a1 1 0 0 1-1-1V15" />
    </>
  ),
  collapse: (
    <>
      <path d="M9 3.5V8a1 1 0 0 1-1 1H3.5" />
      <path d="M15 3.5V8a1 1 0 0 0 1 1h4.5" />
      <path d="M15 20.5V16a1 1 0 0 1 1-1h4.5" />
      <path d="M9 20.5V16a1 1 0 0 0-1-1H3.5" />
    </>
  ),
  gear: (
    <>
      {/* Eight trapezoidal teeth swept between an inner and outer radius, and a
          hub. Generated from that geometry rather than traced, so this file's
          claim to be hand-rolled stays true. */}
      <circle cx="12" cy="12" r="3.4" />
      <path d="M10.02 5.08L10.36 2.14L13.64 2.14L13.98 5.08L15.49 5.7L17.81 3.86L20.14 6.19L18.3 8.51L18.92 10.02L21.86 10.36L21.86 13.64L18.92 13.98L18.3 15.49L20.14 17.81L17.81 20.14L15.49 18.3L13.98 18.92L13.64 21.86L10.36 21.86L10.02 18.92L8.51 18.3L6.19 20.14L3.86 17.81L5.7 15.49L5.08 13.98L2.14 13.64L2.14 10.36L5.08 10.02L5.7 8.51L3.86 6.19L6.19 3.86L8.51 5.7Z" />
    </>
  ),
  leave: (
    <>
      <path d="M14.5 3.5h3a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3h-3" />
      <path d="M10 16.5L14.5 12 10 7.5" />
      <path d="M14.5 12h-11" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M15.5 5.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2" />
    </>
  ),
  check: <path d="M4.5 12.8l4.8 4.7L19.5 6.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  faces: (
    <>
      <circle cx="9" cy="9.5" r="4" />
      <circle cx="16" cy="14.5" r="4" />
    </>
  ),
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.5 15.5L20.5 20.5" />
    </>
  ),
  shuffle: (
    <>
      <path d="M3 7h3.5l3 5M21 7h-4.5l-8 10H3" />
      <path d="M18 4.2L21 7l-3 2.8" />
      <path d="M18 14.2L21 17l-3 2.8" />
      <path d="M21 17h-4.5l-1.6-2" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3.5l9 16H3z" />
      <path d="M12 9.5v4.2M12 16.6v.5" />
    </>
  ),
}

export type IconName = keyof typeof paths

export function Icon({ name, size = 19 }: { name: IconName; size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

/** A stable, pleasant colour per person, so the far end always looks the same. */
export function tint(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  // Warm half of the wheel only — it should feel like the rest of the app.
  const hue = 12 + (Math.abs(hash) % 66)
  return `hsl(${hue} 62% 64%)`
}

/** Generated names are run together ("SwiftFox"); typed ones usually have a
 *  space ("Dan Smith"). Both should give two letters — one initial makes half
 *  the room look identical. */
export function initial(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/[\s_-]+/).filter(Boolean)
  const caps = parts.length === 1 ? (parts[0]!.match(/[A-Z]/g) ?? []) : []
  const letters = caps.length >= 2 ? caps.slice(0, 2) : parts.slice(0, 2).map((p) => p[0]!)
  return letters.join('').toUpperCase()
}
