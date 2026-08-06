import { Tray, Menu, nativeImage, nativeTheme, app } from 'electron'
import { join } from 'node:path'
import { accelerator } from './shortcuts.js'

// The Stage is often hidden — you're watching in fullscreen, or you're the one
// sharing and you're busy in another app. The tray is how you mute or hang up
// without hunting for a window.

interface CallState {
  connected: boolean
  sharing: boolean
  micOn: boolean
}

interface Actions {
  showStage: () => void
  toggleFaces: () => void
  toggleMic: () => void
  leave: () => void
}

let tray: Tray | null = null
let state: CallState = { connected: false, sharing: false, micOn: true }
let actions: Actions | null = null

export function create(acts: Actions): void {
  actions = acts
  tray = new Tray(buildIcon())
  tray.setToolTip('Cozy')
  render()

  // Electron never updates the tray for a theme change, and on Windows the
  // correct system-theme value isn't even populated until the first one.
  nativeTheme.on('updated', () => {
    if (tray && !tray.isDestroyed()) tray.setImage(buildIcon())
  })

  // On Windows/Linux a left click should do the obvious thing.
  if (process.platform !== 'darwin') tray.on('click', () => acts.showStage())
}

export function setState(next: CallState): void {
  if (
    next.connected === state.connected &&
    next.sharing === state.sharing &&
    next.micOn === state.micOn
  ) {
    return
  }
  state = next
  render()
}

function render(): void {
  if (!tray || !actions) return
  const a = actions
  const status = !state.connected
    ? 'Not connected'
    : state.sharing
      ? 'Connected · sharing'
      : 'Connected'

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Cozy — ${status}`, enabled: false },
      { type: 'separator' },
      {
        label: state.micOn ? 'Mute microphone' : 'Unmute microphone',
        accelerator,
        enabled: state.connected,
        click: () => a.toggleMic(),
      },
      { label: 'Show / hide faces', click: () => a.toggleFaces() },
      { label: 'Open Cozy', click: () => a.showStage() },
      { type: 'separator' },
      { label: 'Leave', enabled: state.connected, click: () => a.leave() },
      { label: 'Quit Cozy', role: 'quit' },
    ]),
  )
}

/**
 * Which glyph to draw, per platform.
 *
 * macOS gets a template image: black plus alpha, which AppKit inverts to suit a
 * light or dark menu bar on its own.
 *
 * Windows gets neither the inversion nor the concept — `setTemplateImage` is a
 * no-op there and the pixels are drawn literally, so shipping the macOS asset
 * puts a black glyph on the default black taskbar. It also insists on a real
 * `.ico`: a `.png` is converted from its 1x frame alone and then stretched,
 * which is why so many Electron apps have a fuzzy tray icon.
 *
 * And the theme signal is the subtle part. `nativeTheme.shouldUseDarkColors`
 * reads the *app* theme; the taskbar follows the *system* theme, which Windows
 * lets you set independently. Someone running light apps on a dark taskbar
 * would get the wrong icon. `shouldUseDarkColorsForSystemIntegratedUI` is the
 * right one — with the caveat that it falls back to the app theme until the
 * first theme-change event, so we re-render whenever one arrives.
 */
function iconPath(): string {
  const dir = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), 'resources')

  if (process.platform === 'darwin') return join(dir, 'trayTemplate.png')

  const theme = nativeTheme as typeof nativeTheme & {
    shouldUseDarkColorsForSystemIntegratedUI?: boolean
  }
  const darkChrome =
    theme.shouldUseDarkColorsForSystemIntegratedUI ?? nativeTheme.shouldUseDarkColors
  const glyph = darkChrome ? 'tray-light-glyph' : 'tray-dark-glyph'
  return join(dir, `${glyph}.${process.platform === 'win32' ? 'ico' : 'png'}`)
}

function buildIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(iconPath())
  // Only macOS has any use for this; it is a no-op elsewhere.
  if (process.platform === 'darwin') icon.setTemplateImage(true)
  return icon
}

export function destroy(): void {
  tray?.destroy()
  tray = null
}
