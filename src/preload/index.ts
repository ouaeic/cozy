import { contextBridge, ipcRenderer } from 'electron'
import type { CozyBridge, Settings, CaptureSource, PermissionState } from '../shared/types.js'

// The whole native surface, in one small object. Only the Stage window loads
// this — the Faces window reaches it through its opener, since they share a
// renderer process.

const bridge: CozyBridge = {
  platform: process.platform,
  // Whether the overlays have to be drawn inside the main window instead of
  // getting OS windows of their own. True on Wayland, which refuses every API
  // they depend on (see renderer/main.tsx). The env var is the escape hatch for
  // the other case that breaks them: X11 with no compositor running, where a
  // transparent window renders as a black rectangle.
  inlineOverlays:
    process.env.COZY_FLOAT_OVERLAYS === '1'
      ? false
      : process.env.COZY_INLINE_OVERLAYS === '1' ||
        (process.platform === 'linux' &&
          (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)),

  getSources: () => ipcRenderer.invoke('sources:list') as Promise<CaptureSource[]>,
  armCapture: (sourceId, withAudio, muteLocal) =>
    ipcRenderer.invoke('capture:arm', sourceId, withAudio, muteLocal) as Promise<boolean>,

  readSettings: () => ipcRenderer.invoke('settings:read') as Promise<Settings>,
  writeSettings: (patch) => ipcRenderer.invoke('settings:write', patch) as Promise<Settings>,

  getPermissions: () => ipcRenderer.invoke('perm:get') as Promise<PermissionState>,
  openPermissionSettings: (kind) => ipcRenderer.invoke('perm:open', kind) as Promise<void>,

  getDucking: () =>
    ipcRenderer.invoke('audio:ducking') as Promise<{
      applies: boolean
      willDuck: boolean
      preference: number | null
    }>,
  stopDucking: () => ipcRenderer.invoke('audio:stop-ducking') as Promise<boolean>,
  openSoundSettings: () => ipcRenderer.invoke('audio:sound-settings') as Promise<void>,

  keepAwake: (on) => ipcRenderer.invoke('power:keepAwake', on) as Promise<void>,
  onBatteryPower: () => ipcRenderer.invoke('power:battery') as Promise<boolean>,

  setCallState: (state) => ipcRenderer.send('call:state', state),

  onToggleMic: (cb) => ipcRenderer.on('toggle-mic', () => cb()),
  onInvite: (cb) => ipcRenderer.on('invite', (_e, code: string) => cb(code)),
  onLeave: (cb) => ipcRenderer.on('leave', () => cb()),

  window: {
    minimise: () => ipcRenderer.send('window:minimise'),
    toggleMaximise: () => ipcRenderer.send('window:toggleMaximise'),
    close: () => ipcRenderer.send('window:close'),
    setFullscreen: (on) => ipcRenderer.send('window:fullscreen:set', on),
    show: () => ipcRenderer.send('window:show'),
    isFullscreen: () => ipcRenderer.invoke('window:fullscreen:get') as Promise<boolean>,
    onFullscreenChange: (cb) => ipcRenderer.on('window:fullscreen', (_e, on: boolean) => cb(on)),
  },

  bar: {
    setSize: (w, h) => ipcRenderer.send('bar:size', w, h),
    pin: (pinned) => ipcRenderer.send('bar:pin', pinned),
    hot: (hot) => ipcRenderer.send('bar:hot', hot),
    onVisible: (cb) => ipcRenderer.on('bar:visible', (_e, visible: boolean) => cb(visible)),
  },

  faces: {
    setSize: (w, h) => ipcRenderer.send('faces:size', w, h),
    resetPosition: () => ipcRenderer.send('faces:reset'),
  },
}

contextBridge.exposeInMainWorld('cozy', bridge)

// A few menu/tray commands don't fit the bridge's request/response shape; they
// arrive as plain events the renderer subscribes to by name.
for (const channel of ['toggle-cam', 'share', 'faces:toggle', 'power:battery'] as const) {
  ipcRenderer.on(channel, (_e, ...args: unknown[]) => {
    window.dispatchEvent(new CustomEvent(`cozy:${channel}`, { detail: args[0] }))
  })
}
