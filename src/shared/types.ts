// Shared between main, preload and renderer. Keep it small and serialisable —
// everything here crosses the IPC boundary.

/** How big the remote face tiles are being drawn. Drives the send-side ladder. */
export type FaceSize = 'S' | 'M' | 'L'

/** A screen or window offered by the OS for capture. */
export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** PNG data URL, rendered once when the picker opens. */
  thumbnail: string
  /** App icon data URL, windows only. */
  appIcon: string | null
}

/** Persisted to <userData>/cozy.json. Small enough to write whole every time. */
export interface Settings {
  /** What we call you. Prefilled from the OS on first run. */
  name: string
  /** 0 = voices only, 1 = movie at full volume. Voice is always 1.0. */
  balance: number
  /** Dip the movie while the other person is talking. */
  autoDuck: boolean
  /** Show your own camera in the overlay alongside everyone else's. On by
   *  default: people want to know they're framed and lit before they stop
   *  thinking about it. */
  selfView: boolean
  faceSize: FaceSize
  /** Remembered position of the Faces window, per display id. */
  facesPos: Record<string, { x: number; y: number }> | null
  /** Remembered size and position of the main window. An app that opens at a
   *  different size every time feels unfinished. */
  stageBounds: { x: number; y: number; width: number; height: number } | null
  /** Bring-your-own TURN. Empty unless the user hit a connectivity wall and
   *  pasted their own credentials — the project never ships defaults. */
  turn: { urls: string; username: string; credential: string } | null
  /** Override the signaling host (self-hosters). */
  signalUrl: string | null
  /** Explicit microphone choice; null means let Cozy decide. */
  micDeviceId: string | null
  /** Explicit camera choice; null means the system default. */
  camDeviceId: string | null
  /** Avoid a headset's own microphone when using it would drop the headset out
   *  of stereo. See core/devices.ts. */
  protectPlayback: boolean
  /** Check GitHub Releases for a new version. The only thing Cozy ever does
   *  without being asked, so it can be switched off. */
  autoUpdate: boolean
  /** Don't nag about Windows turning other apps down more than once. */
  duckingNoticeSeen: boolean
  /** The one thing that makes this an app for two people rather than a tool. */
  partner: { name: string; secret: string; avatarSeed: string } | null
}

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  balance: 0.55,
  autoDuck: true,
  selfView: true,
  faceSize: 'M',
  facesPos: null,
  stageBounds: null,
  turn: null,
  signalUrl: null,
  micDeviceId: null,
  camDeviceId: null,
  protectPlayback: true,
  autoUpdate: true,
  duckingNoticeSeen: false,
  partner: null,
}

/** Which OS permissions we have. macOS is the only one that gates these. */
export interface PermissionState {
  camera: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  microphone: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
  screen: 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'
}

/** The API the preload exposes on `window.cozy`. */
export interface CozyBridge {
  platform: NodeJS.Platform
  /** True when the overlays must be drawn in-window rather than as their own
   *  floating OS windows — Wayland, or X11 with no compositor. */
  inlineOverlays: boolean
  /** Screens and windows available to capture, with fresh thumbnails. */
  getSources(): Promise<CaptureSource[]>
  /** Arm the main-process display-media handler, then call getDisplayMedia.
   *  `withAudio` requests system loopback audio alongside the picture. */
  armCapture(sourceId: string, withAudio: boolean, muteLocal: boolean): Promise<boolean>
  readSettings(): Promise<Settings>
  writeSettings(patch: Partial<Settings>): Promise<Settings>
  getPermissions(): Promise<PermissionState>
  /** Open the relevant OS settings pane so the user can grant access. */
  openPermissionSettings(kind: 'camera' | 'microphone' | 'screen'): Promise<void>
  /** Whether Windows will turn other applications down while our mic is open. */
  getDucking(): Promise<{ applies: boolean; willDuck: boolean; preference: number | null }>
  /** Set the Windows per-user preference to leave other apps alone. */
  stopDucking(): Promise<boolean>
  /** Open the Sound control panel on its Communications tab (Windows). */
  openSoundSettings(): Promise<void>
  /** Hold the display awake while something is being shared. */
  keepAwake(on: boolean): Promise<void>
  /** True when the machine is running on battery, so we can ease off. */
  onBatteryPower(): Promise<boolean>
  /** Tell main about call state so the tray and global shortcuts stay honest. */
  setCallState(state: { connected: boolean; sharing: boolean; micOn: boolean }): void
  /** Fires when the tray or the global hotkey asks for a mic toggle. */
  onToggleMic(cb: () => void): void
  /** Fires when the app is opened via a cozy:// invite link. */
  onInvite(cb: (code: string) => void): void
  /** Fires when the tray asks to leave the call. */
  onLeave(cb: () => void): void
  window: {
    minimise(): void
    toggleMaximise(): void
    close(): void
    setFullscreen(on: boolean): void
    /** Bring the Stage forward — it may be behind a fullscreen film. */
    show(): void
    isFullscreen(): Promise<boolean>
    onFullscreenChange(cb: (on: boolean) => void): void
    /** macOS traffic lights — hidden while a film is playing, shown with the bar. */
  }
  /** The floating control panel at the top of the screen. */
  bar: {
    /** Size the window to its content, so a popover isn't clipped. */
    setSize(width: number, height: number): void
    /** Hold it open while a popover is up. */
    pin(pinned: boolean): void
    /** Pointer entered or left the panel's hot strip (Linux/X11). */
    hot(hot: boolean): void
    /** Fires as the panel reveals and retracts. */
    onVisible(cb: (visible: boolean) => void): void
  }
  /** Move/resize the Faces window from the renderer that owns it. */
  faces: {
    setSize(width: number, height: number): void
    /** Nudge it back on-screen at the top-right of the active display. */
    resetPosition(): void
  }
}

declare global {
  interface Window {
    cozy: CozyBridge
  }
}
