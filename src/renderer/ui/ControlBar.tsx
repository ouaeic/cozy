import { useState, useEffect, useRef } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { Icon } from './icons.js'
import { health, describe } from '../core/health.js'

/**
 * The controls, as a panel on the screen rather than a strip inside the app.
 *
 * It lives in its own always-on-top window (see main/windows.ts), hidden at the
 * top edge of whichever display your cursor is on, and comes down when you push
 * the pointer up there — from inside a fullscreen video player, from a browser,
 * from anywhere. That is the whole point: the moment you share something you
 * stop looking at Cozy, and muting yourself should not mean going to find it.
 */
export function ControlBar(): JSX.Element {
  const [pop, setPop] = useState<'sound' | null>(null)
  const [revealed, setRevealed] = useState(true)
  const root = useRef<HTMLDivElement>(null)
  const sharing = S.sharing.value
  const connected = S.connected.value

  // Size the window to the content. The popover makes it taller; without this
  // the panel would clip it.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Measure to the BOTTOM edge, not the height. getBoundingClientRect
    // excludes margins, so sizing the window to `height` alone clipped whatever
    // sat above it — the panel came out a few pixels short and looked cut off.
    // A little slack keeps the rounded corner and any popover off the edge.
    window.cozy.bar.setSize(Math.ceil(rect.width), Math.ceil(rect.bottom + 4))
  }, [pop, sharing, connected, S.peers.value.length, S.health?.value?.state])

  // On Linux/X11 the panel is revealed by the pointer ENTERING it rather than
  // by polling for where the pointer is — Electron's getCursorScreenPoint
  // caches a stale answer there (electron#42519). Collapsed, the window is a
  // two-pixel sliver at the top of the screen; entering it expands the panel,
  // leaving it collapses it again. Same behaviour as macOS and Windows, just
  // driven by an event the window actually receives.
  useEffect(() => {
    const el = root.current
    const doc = el?.ownerDocument
    if (!doc || !window.cozy.bar.hot) return
    const enter = () => window.cozy.bar.hot(true)
    const leave = () => window.cozy.bar.hot(false)
    doc.addEventListener('pointerenter', enter)
    doc.addEventListener('pointerleave', leave)
    // A window resize can move the pointer out from under us without a leave.
    doc.addEventListener('pointermove', enter)
    return () => {
      doc.removeEventListener('pointerenter', enter)
      doc.removeEventListener('pointerleave', leave)
      doc.removeEventListener('pointermove', enter)
    }
  }, [])

  // Arriving is a small movement rather than a snap — the window itself appears
  // instantly, so without this the panel pops into being mid-screen.
  useEffect(() => {
    window.cozy.bar.onVisible((visible) => {
      setRevealed(visible)
      if (!visible) setPop(null)
    })
  }, [])

  // Hold the panel open while a popover is up, or it retracts out from under
  // the pointer the moment you reach for the slider.
  useEffect(() => {
    window.cozy.bar.pin(pop !== null)
    return () => window.cozy.bar.pin(false)
  }, [pop])

  return (
    <div
      class={`floatbar ${revealed ? 'floatbar--in' : ''}`}
      ref={root}
      onMouseLeave={() => setPop(null)}
    >

      <div class="floatbar__group">
        <button
          class={`icon ${S.micOn.value ? '' : 'icon--off'}`}
          onClick={() => app.toggleMic()}
          title={S.micOn.value ? 'Mute (⌘D)' : 'Unmute (⌘D)'}
          aria-label={S.micOn.value ? 'Mute microphone' : 'Unmute microphone'}
        >
          <Icon name={S.micOn.value ? 'mic' : 'micOff'} />
        </button>
        <button
          class={`icon ${S.camOn.value ? '' : 'icon--off'}`}
          onClick={() => app.toggleCam()}
          title={S.camOn.value ? 'Camera off (⌘E)' : 'Camera on (⌘E)'}
          aria-label={S.camOn.value ? 'Turn camera off' : 'Turn camera on'}
        >
          <Icon name={S.camOn.value ? 'cam' : 'camOff'} />
        </button>
      </div>

      <div class="floatbar__group">
        <button
          class={`icon ${sharing ? 'icon--live' : ''}`}
          onClick={() => (sharing ? void app.stopSharing() : void app.openSharePicker())}
          disabled={!connected || S.askedToShare.value}
          title={shareTitle()}
          aria-label={shareTitle()}
        >
          <Icon name={sharing ? 'shareOff' : 'share'} />
        </button>
        <button
          class="icon"
          onClick={() => setPop(pop === 'sound' ? null : 'sound')}
          title="Sound balance"
          aria-label="Sound balance"
        >
          <Icon name="sound" />
        </button>
      </div>

      <div class="floatbar__divide" />

      {/* Only ever appears when something is actually wrong. A permanent signal
          bar is noise; a word that shows up when the picture softens is an
          answer to the question everyone asks. */}
      {health.value && health.value.state !== 'good' && (
        <button
          class="badge badge--warn"
          onClick={() => app.openSettings()}
          title={describe(health.value)}
        >
          <Icon name="warn" size={13} />
          {health.value.state === 'limited-cpu' ? 'This computer' : 'Connection'}
        </button>
      )}

      {sharing && <span class="badge">Sharing</span>}

      <div class="floatbar__group">
        <button
          class={`icon ${S.facesVisible.value ? '' : 'icon--off'}`}
          onClick={() => (S.facesVisible.value = !S.facesVisible.value)}
          title="Show or hide the floating faces (⌘F)"
          aria-label="Show or hide faces"
        >
          <Icon name="faces" />
        </button>
        <button
          class="icon"
          onClick={() => window.cozy.window.setFullscreen(!S.fullscreen.value)}
          title={S.fullscreen.value ? 'Leave fullscreen' : 'Fullscreen (F)'}
          aria-label="Toggle fullscreen"
        >
          <Icon name={S.fullscreen.value ? 'collapse' : 'expand'} />
        </button>
        <button
          class="icon"
          onClick={() => app.openSettings()}
          title="Settings"
          aria-label="Settings"
        >
          <Icon name="gear" />
        </button>
        <button
          class="icon btn--danger"
          onClick={() => app.leave()}
          title="Leave (⌘W)"
          aria-label="Leave the call"
        >
          <Icon name="leave" />
        </button>
      </div>

      {pop === 'sound' && <SoundPop />}
    </div>
  )
}

function shareTitle(): string {
  if (S.sharing.value) return 'Stop sharing (⌘S)'
  if (S.askedToShare.value) return 'Waiting for them to answer…'
  if (S.someoneElseSharing.value) {
    const holder = S.peers.value.find((p) => p.sharing)
    return `Ask ${holder?.name ?? 'them'} if you can share instead (⌘S)`
  }
  return 'Share a screen or window (⌘S)'
}

/** The one audio control that matters: how loud the film sits under the voice. */
function SoundPop(): JSX.Element {
  const balance = S.settings.value.balance
  const duck = S.settings.value.autoDuck

  return (
    <div class="pop pop--bar">
      <h3>Sound</h3>
      <p>Their voice always plays at full volume. This sets how loud everything else is under it.</p>
      <input
        class="slider"
        type="range"
        min="0"
        max="100"
        value={Math.round(balance * 100)}
        onInput={(e) => void app.setBalance(Number((e.target as HTMLInputElement).value) / 100)}
        aria-label="Film volume"
      />
      <div class="slider-ends">
        <span>Just voices</span>
        <span>Film loud</span>
      </div>

      <button
        class={`toggle ${duck ? 'toggle--on' : ''}`}
        onClick={() => void app.setAutoDuck(!duck)}
        aria-pressed={duck}
      >
        <span>
          Duck the film when they talk
          <br />
          <span class="faint">So you can say something without pausing</span>
        </span>
        <span class="toggle__track" />
      </button>
    </div>
  )
}
