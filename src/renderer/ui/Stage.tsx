import { useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { Icon } from './icons.js'
import { Video } from './Video.js'

const CURSOR_IDLE_MS = 2500

/**
 * The picture, and nothing else.
 *
 * The controls used to live here, sliding down from the top of this window. They
 * don't any more: they're a separate always-on-top panel that reveals at the top
 * of the *screen* (see ControlBar and main/windows.ts), because the moment you
 * share something you are looking at a video player, not at Cozy. A control bar
 * you have to alt-tab to find is a control bar you don't use.
 */
export function Stage(): JSX.Element {
  const [cursorIdle, setCursorIdle] = useState(false)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)

  const stream = S.stageStream.value
  const fullscreen = S.fullscreen.value

  useEffect(() => {
    return () => {
      if (idle.current) clearTimeout(idle.current)
    }
  }, [])

  const onMove = () => {
    // Only chase the cursor in fullscreen — in a window it should behave like
    // any other window.
    if (!fullscreen) return
    setCursorIdle(false)
    if (idle.current) clearTimeout(idle.current)
    idle.current = setTimeout(() => setCursorIdle(true), CURSOR_IDLE_MS)
  }

  return (
    <div
      class={`stage ${cursorIdle && fullscreen ? 'stage--hide-cursor' : ''}`}
      onMouseMove={onMove}
    >
      {stream ? (
        <Video stream={stream} visible />
      ) : (
        <div class="stage__empty">
          <Icon name="share" size={30} />
          <h2>{waitingLine()}</h2>
          {!S.someoneElseSharing.value && !S.sharing.value && (
            <button
              class="btn"
              onClick={() => void app.openSharePicker()}
              disabled={!S.connected.value}
            >
              Share a screen or window
            </button>
          )}
          <p class="faint" style={{ maxWidth: 340, textAlign: 'center' }}>
            Move your pointer to the top of the screen for the controls — they’re
            there whichever app you’re in.
          </p>
        </div>
      )}
    </div>
  )
}

function waitingLine(): string {
  if (S.sharing.value) return 'You’re sharing. They can see it now.'
  const them = S.peers.value[0]?.name
  if (!S.connected.value) return 'Reconnecting…'
  return them ? `Nothing on screen yet — you or ${them} can start` : 'Nothing on screen yet'
}
