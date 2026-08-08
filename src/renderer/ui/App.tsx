import type { JSX } from 'preact'
import * as S from '../core/state.js'
import { Icon } from './icons.js'
import { Hearth } from './Hearth.js'
import { Waiting } from './Waiting.js'
import { Stage } from './Stage.js'
import { SharePicker } from './SharePicker.js'
import { Faces, facesPixelSize } from './Faces.js'
import { ControlBar } from './ControlBar.js'
import {
  Trouble,
  BlankCapture,
  SilentCapture,
  PermissionNeeded,
  Ducking,
  ShareRequest,
  SettingsSheet,
} from './Sheets.js'

const isMac = window.cozy.platform === 'darwin'
// See renderer/main.tsx — Wayland won't float a window, so the overlays live in
// this window instead of getting their own.
const inlineOverlays = window.cozy.inlineOverlays

export function App(): JSX.Element {
  const scene = S.scene.value
  const inCall = scene === 'call'

  return (
    <div class="app">
      {/* In a call the picture owns the window, so the title bar goes — but
          that used to take the ONLY drag region with it, leaving the window
          unmovable for the whole evening. The control bar is no substitute: it
          is a separate, movable:false window sitting at the top of the SCREEN,
          not of this one. So the call gets a slim invisible strip instead. */}
      {inCall && <div class="dragstrip" />}
      {!inCall && (
        <div class={`titlebar ${isMac ? 'titlebar--mac' : ''}`}>
          <b>Cozy</b>
          <div class="spacer" />
          {scene === 'waiting' && <span class="faint">Waiting</span>}
          {/* Reachable before a call, not just during one. Choosing a
              microphone, or pointing the app at a signalling server, are both
              things you do BEFORE you can call anyone — and the home screen
              tells you to come here. */}
          <button
            class="icon icon--sm no-drag"
            onClick={() => (S.sheet.value = 'settings')}
            title="Settings"
            aria-label="Settings"
          >
            <Icon name="gear" size={16} />
          </button>
        </div>
      )}

      {scene === 'hearth' && <Hearth />}
      {scene === 'waiting' && <Waiting />}
      {inCall && <Stage />}

      {inCall && inlineOverlays && <InlineOverlays />}

      {S.sheet.value === 'share' && <SharePicker />}
      {S.sheet.value === 'settings' && <SettingsSheet />}
      {S.sheet.value === 'trouble' && <Trouble />}
      {S.sheet.value === 'blank-capture' && <BlankCapture />}
      {S.sheet.value === 'silent-capture' && <SilentCapture />}
      {S.sheet.value === 'permission' && <PermissionNeeded />}
      {S.sheet.value === 'ducking' && <Ducking />}
      {S.sheet.value === 'share-request' && <ShareRequest />}

      {/* A browser will not start audio until the page has been touched, and
          the sinks are invisible — so without this the call looks perfect and
          is completely silent. Any click anywhere fixes it; this just says so. */}
      {S.audioBlocked.value && (
        <div class="notice notice--tap" role="status">
          Tap anywhere to turn the sound on — your browser is holding it until you do.
        </div>
      )}

      {S.notice.value && <div class="notice">{S.notice.value}</div>}
    </div>
  )
}

/** The Wayland fallback: the same two components, drawn over the picture in
 *  this window rather than in windows of their own. */
function InlineOverlays(): JSX.Element {
  const tiles = S.peers.value.length + (S.settings.value.selfView ? 1 : 0)
  const { width, height } = facesPixelSize(tiles, S.settings.value.faceSize)

  return (
    <>
      <div class="inlay inlay--bar">
        <ControlBar />
      </div>
      {S.facesVisible.value && (
        <div class="inlay inlay--faces" style={{ width, height }}>
          <Faces />
        </div>
      )}
    </>
  )
}
