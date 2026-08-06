import { useEffect } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { Icon, initial, tint } from './icons.js'
import { Video } from './Video.js'
import type { FaceSize } from '../../shared/types.js'

// This is the part a browser tab can't do. It's a real OS window: frameless,
// transparent, always on top, and it follows you into fullscreen and onto other
// desktops. So it works the same whether you're watching in a window, watching
// fullscreen, or off using your computer while you share it.

const TILE_WIDTH: Record<FaceSize, number> = { S: 160, M: 224, L: 320 }
const PADDING = 12
const GAP = 8
const PILL_HEIGHT = 44

/** A column for a pair, then wider as the room fills — a six-tall stack down
 *  the side of someone's screen is unusable. */
function columnsFor(tiles: number): number {
  if (tiles <= 2) return 1
  if (tiles <= 6) return 2
  return 3
}

/** Exactly the contents' size — used for the OS window on macOS and Windows,
 *  and for the in-window host on Wayland, which has no OS window to size. */
export function facesPixelSize(tiles: number, size: FaceSize): { width: number; height: number } {
  if (tiles === 0) return { width: 180, height: PILL_HEIGHT + PADDING }
  const columns = columnsFor(tiles)
  const rows = Math.max(1, Math.ceil(tiles / columns))
  const tileWidth = TILE_WIDTH[size]
  const tileHeight = Math.round((tileWidth * 9) / 16)
  return {
    width: columns * tileWidth + (columns - 1) * GAP + PADDING * 2,
    height: rows * tileHeight + (rows - 1) * GAP + PADDING * 2,
  }
}

export function Faces(): JSX.Element {
  const size = S.settings.value.faceSize
  const selfView = S.settings.value.selfView
  const people = S.peers.value

  const tiles = people.length + (selfView ? 1 : 0)
  const columns = columnsFor(tiles)

  // Keep the OS window exactly the size of its contents — a transparent window
  // bigger than its contents still swallows clicks.
  useEffect(() => {
    // On Wayland there is no separate window to resize; the host div sizes
    // itself from facesPixelSize instead.
    if (window.cozy.inlineOverlays) return
    const { width, height } = facesPixelSize(tiles, size)
    window.cozy.faces.setSize(width, height)
  }, [tiles, size])

  if (tiles === 0) {
    return (
      <div class="faces" style={{ gridTemplateColumns: '1fr' }}>
        <div class="pill">
          <span class="pulse" /> waiting for someone
        </div>
      </div>
    )
  }

  return (
    <div class="faces" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
      <div class="faces__tools">
        <button
          class="icon icon--sm"
          onClick={() => void app.setFaceSize(nextSize(size))}
          title="Change size"
          aria-label="Change size"
        >
          <Icon name={size === 'L' ? 'minus' : 'plus'} size={14} />
        </button>
        <button
          class={`icon icon--sm ${S.micOn.value ? '' : 'icon--off'}`}
          onClick={() => app.toggleMic()}
          title={S.micOn.value ? 'Mute' : 'Unmute'}
          aria-label={S.micOn.value ? 'Mute microphone' : 'Unmute microphone'}
        >
          <Icon name={S.micOn.value ? 'mic' : 'micOff'} size={14} />
        </button>
        <button
          class="icon icon--sm"
          onClick={() => (S.facesVisible.value = false)}
          title="Hide"
          aria-label="Hide faces"
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      {people.map((person) => (
        <Tile
          key={person.id}
          name={person.name}
          seed={person.avatarSeed || person.name}
          stream={person.cam ? person.stream : null}
          muted={!person.mic}
          speaking={person.speaking}
        />
      ))}

      {selfView && (
        <Tile
          name="You"
          seed={S.settings.value.name || 'you'}
          stream={S.camOn.value ? S.localStream.value : null}
          muted={!S.micOn.value}
          speaking={false}
          self
        />
      )}
    </div>
  )
}

function Tile({
  name,
  seed,
  stream,
  muted,
  speaking,
  self = false,
}: {
  name: string
  seed: string
  stream: MediaStream | null
  muted: boolean
  speaking: boolean
  self?: boolean
}): JSX.Element {
  return (
    <div class={`tile ${speaking ? 'tile--speaking' : ''} ${self ? 'tile--self' : ''}`}>
      {stream ? (
        <Video stream={stream} visible />
      ) : (
        <div class="tile__off">
          <span class="tile__initial" style={{ background: tint(seed) }}>
            {initial(name)}
          </span>
        </div>
      )}
      <div class={`tile__name ${muted ? 'tile__name--pinned' : ''}`}>
        {muted && (
          <span class="tile__muted">
            <Icon name="micOff" size={11} />
          </span>
        )}
        <span>{name}</span>
      </div>
    </div>
  )
}

const nextSize = (size: FaceSize): FaceSize => (size === 'S' ? 'M' : size === 'M' ? 'L' : 'S')
