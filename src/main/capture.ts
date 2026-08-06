import { desktopCapturer, session, systemPreferences } from 'electron'
import type { CaptureSource, PermissionState } from '../shared/types.js'

const isMac = process.platform === 'darwin'

// The reason this app is native at all.
//
// In a browser, sharing a *window* captures no audio on any OS, and whole-screen
// audio is Windows-only — so a movie night gets you the picture and silence.
// Electron routes getDisplayMedia through the main process, where we can answer
// with `audio: 'loopback'` and get real system audio on macOS 12.3+ (CoreAudio
// tap), Windows 10+ (WASAPI loopback) and Linux (the PulseAudio monitor of the
// default sink — NOT PipeWire; Chromium has no PipeWire audio backend, it
// reaches PipeWire systems through pipewire-pulse), whatever surface was picked.

/**
 * Muting local playback while capturing means Cozy can play the film back
 * through its own mixer, which is what lets the film duck for the person
 * sharing and not just the person watching. Lovely on macOS, where Chromium
 * maps it to a Core Audio tap with CATapMuted — the tap is muted, nothing else.
 *
 * On Windows it is a trap. Chromium implements it by calling
 * IAudioEndpointVolume::SetMute(true) on the actual render endpoint — it mutes
 * the user's speakers, system-wide, the way the volume icon does. Cozy's own
 * playback goes to that same endpoint, so the sharer would hear nothing at all.
 * Worse, the unmute only happens on a clean Stop(): crash mid-share and the
 * machine is left muted with no clue why. This is a well-known hazard of the
 * flag and the reason it is not used here.
 *
 * Linux is a trap too, for a different reason. Chromium routes the request to
 * PulseLoopbackManager, which calls MuteAllSinksExcept(<monitor source name>) —
 * and then compares that monitor-SOURCE name against SINK names, which can
 * never match. So the "except" never fires and every sink on the machine is
 * muted, including the one being captured. Under classic PulseAudio the mute is
 * applied before the monitor tap, so the capture is digital zero as well.
 *
 * So only macOS mutes. Everywhere else uses plain loopback and the sharer keeps
 * hearing the film from their own speakers, as they already were.
 */
const CAN_MUTE_LOCAL_PLAYBACK = process.platform === 'darwin'

interface Pending {
  sourceId: string
  withAudio: boolean
  /** Mute the sharer's own speakers so Cozy can be the one mixing it back in. */
  muteLocal: boolean
}

/** Whether the renderer should play the captured film back itself. */
export const routesFilmThroughMixer = () => CAN_MUTE_LOCAL_PLAYBACK

let pending: Pending | null = null

export function arm(next: Pending): void {
  pending = next
}

export function installHandlers(): void {
  const ses = session.defaultSession

  ses.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const want = pending
      pending = null
      if (!want) return callback({})

      // Note: the audio key must be OMITTED, not set to undefined — Electron
      // throws a TypeError on `audio: undefined`.
      const audio = (): { audio?: 'loopback' | 'loopbackWithMute' } => {
        if (!want.withAudio) return {}
        return { audio: want.muteLocal && CAN_MUTE_LOCAL_PLAYBACK ? 'loopbackWithMute' : 'loopback' }
      }

      if (isWayland) {
        // The portal owns the choosing, and this getSources() call IS the
        // dialog. Ids from it are single-use — BaseCapturerPipeWire takes a
        // fresh one from RestoreTokenManager::GetUnusedId() on every
        // construction — so matching against an id fetched earlier can only
        // ever fail (electron#40097). Take whatever the user picked.
        try {
          const [video] = await desktopCapturer.getSources({
            types: ['screen', 'window'],
            thumbnailSize: { width: 0, height: 0 },
          })
          // The promise from getDisplayMedia never settles unless we call back,
          // so a cancelled portal dialog still has to answer.
          return callback(video ? { video, ...audio() } : {})
        } catch {
          return callback({})
        }
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 0, height: 0 },
      })
      const video = sources.find((s) => s.id === want.sourceId)
      if (!video) return callback({})

      callback({ video, ...audio() })
    },
    // Our own picker is nicer and identical across platforms, so we never hand
    // off to the macOS system picker.
    { useSystemPicker: false },
  )

  // Our own origin is the only thing loaded, and the OS still gates camera,
  // mic and screen recording behind its own prompts. Say yes to the web layer
  // and let the platform be the real gatekeeper.
  ses.setPermissionRequestHandler((_wc, permission, done) => {
    done(['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission))
  })
  ses.setPermissionCheckHandler((_wc, permission) =>
    ['media', 'display-capture', 'clipboard-sanitized-write'].includes(permission),
  )
}

/**
 * Wayland doesn't work like the others. There is no enumerable list of windows
 * to show — the compositor won't tell us, on purpose. xdg-desktop-portal returns
 * a single generic entry, and the real choosing happens in the desktop's own
 * portal dialog when the capture starts. Thumbnails come back empty too.
 *
 * So on Wayland the picker has exactly one thing to offer, and clicking it hands
 * over to the system dialog. Filtering out sources without thumbnails — the
 * obvious thing to do everywhere else — would leave a Linux user with an empty
 * picker and no way to share anything at all.
 */
export const isWayland =
  process.platform === 'linux' &&
  (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)

/** Screens and windows with thumbnails, fetched once when the picker opens. */
export async function listSources(): Promise<CaptureSource[]> {
  // On Wayland, getSources() does not enumerate anything — it OPENS the
  // desktop's portal dialog. Calling it here and again when the capture starts
  // would make the user pick their window twice. So the picker gets one
  // synthetic entry, and the real dialog appears once, on the way in.
  if (isWayland) {
    return [
      {
        id: 'portal',
        name: 'Choose a window or screen…',
        kind: 'screen',
        thumbnail: '',
        appIcon: null,
      },
    ]
  }

  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: true,
  })

  return sources
    .filter((s) => !s.thumbnail.isEmpty())
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }))
    // Our own windows are titled "Cozy", "Cozy — Faces" and "Cozy — Bar".
    // Matching only the bare name left the two overlays in the list.
    .filter((s) => s.name && !s.name.startsWith('Cozy'))
}

// ------------------------------------------------------------- permissions

export function permissions(): PermissionState {
  if (!isMac) {
    // Windows and Linux don't gate these at the OS level in a way we can query.
    return { camera: 'granted', microphone: 'granted', screen: 'granted' }
  }
  return {
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen'),
  }
}

/** Ask nicely first; the caller opens System Settings if this comes back false. */
export async function requestPermission(kind: 'camera' | 'microphone'): Promise<boolean> {
  if (!isMac) return true
  try {
    return await systemPreferences.askForMediaAccess(kind)
  } catch {
    return false
  }
}
