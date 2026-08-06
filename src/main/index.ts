import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron'
import { join } from 'node:path'
import { registerScheme, serveRenderer } from './protocol.js'
import * as windows from './windows.js'
import * as capture from './capture.js'
import * as power from './power.js'
import * as audioEnv from './audio-env.js'
import * as tray from './tray.js'
import * as shortcuts from './shortcuts.js'
import * as updater from './updater.js'
import * as store from './store.js'
import type { Settings } from '../shared/types.js'
import { inviteFromUrl, inviteFromArgv } from '../shared/deeplink.js'

const isMac = process.platform === 'darwin'

// Must happen before `ready`.
registerScheme()

// A call app should not have to beg for a click before it can play the other
// person's voice. The user opened Cozy; that is the gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

if (process.platform === 'linux') {
  // `appendSwitch` OVERWRITES: base::CommandLine keeps one value per switch, so
  // naming `enable-features` blind would silently discard anything the user
  // passed on the command line. Merge instead.
  const existing = app.commandLine.getSwitchValue('enable-features')
  app.commandLine.appendSwitch(
    'enable-features',
    [
      existing,
      // Global shortcuts on Wayland can only work through xdg-desktop-portal;
      // there is no equivalent of X11's key grab. The PreferredTrigger half is
      // still default-OFF in Chromium, and without it Chromium refuses to even
      // create the listener on GNOME — which is most Wayland users.
      'GlobalShortcutsPortal',
      'GlobalShortcutsPortalPreferredTrigger',
    ]
      .filter(Boolean)
      .join(','),
  )

  // WebRTC's automatic gain control writes its recommendation back to the
  // capture device. On Linux that device is a PulseAudio monitor source, so the
  // AGC persistently turns down the thing the film's audio comes from — and it
  // stays down after Cozy quits, which is why the feature is disabled here.
  app.commandLine.appendSwitch('disable-features', 'WebRtcAllowInputVolumeAdjustment')

  // Deliberately NOT set here:
  //   --ozone-platform-hint=auto   removed from Chromium in 140; Electron 38+
  //                                already picks Wayland from XDG_SESSION_TYPE,
  //                                and ozone is chosen in PreSandboxStartup,
  //                                long before this code runs.
  //   --enable-features=WebRTCPipeWireCapturer
  //                                the feature was DELETED in Chromium 133.
  //                                PipeWire capture is unconditional now.

  // The portal identifies us by desktop file. electron-builder installs
  // `cozy.desktop` (from the lowercased executable name), so that is the name
  // that has to be here — a name with no matching file on disk is worse than
  // none, because the portal then refuses to bind any shortcut at all.
  app.setDesktopName('cozy.desktop')
}

// One Cozy at a time — a second launch (or an invite link) focuses the first.
// The exception is development, where two instances on one machine is how you
// test a call; --user-data-dir opts out.
const hasCustomUserData = process.argv.some((a) => a.startsWith('--user-data-dir'))
if (!hasCustomUserData && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  main()
}

function main(): void {
  app.on('second-instance', (_e, argv) => {
    const stage = windows.getStage()

    // `cozy --toggle-mute` hands off to the running app and exits. This is the
    // escape hatch for Wayland, where a global hotkey may be impossible: the
    // user binds a key in their own desktop settings to this command, which
    // works on every compositor including the ones with no portal backend at
    // all. See docs/LIMITATIONS.md for the per-desktop recipes.
    if (argv.includes('--toggle-mute')) {
      stage?.webContents.send('toggle-mic')
      return
    }

    if (stage) {
      if (stage.isMinimized()) stage.restore()
      stage.focus()
    }
    const code = inviteFromArgv(argv)
    if (code) stage?.webContents.send('invite', code)
  })

  // macOS delivers deep links as an event rather than in argv.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    const code = inviteFromUrl(url)
    if (!code) return
    const stage = windows.getStage()
    if (stage) stage.webContents.send('invite', code)
    else pendingInvite = code
  })

  void app.whenReady().then(onReady)

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows.createStage(preload())
    else windows.getStage()?.show()
  })

  app.on('will-quit', () => {
    shortcuts.unregister()
    power.releaseAll()
    tray.destroy()
  })
}

let pendingInvite: string | null = null

function onReady(): void {
  app.setAppUserModelId('app.getcozy.desktop')
  if (!app.isDefaultProtocolClient('cozy')) app.setAsDefaultProtocolClient('cozy')

  serveRenderer(join(import.meta.dirname, '../renderer'))
  capture.installHandlers()
  installMenu()
  installIpc()

  const stage = windows.createStage(preload())

  tray.create({
    showStage: () => {
      const s = windows.getStage()
      if (!s) return
      if (s.isMinimized()) s.restore()
      s.show()
      s.focus()
    },
    toggleFaces: () => windows.getStage()?.webContents.send('faces:toggle'),
    toggleMic: () => windows.getStage()?.webContents.send('toggle-mic'),
    leave: () => windows.getStage()?.webContents.send('leave'),
  })

  // On Wayland this can return true and still never fire: the portal bind
  // resolves later, and a refusal is only logged. Never treat it as proof.
  shortcuts.register(() => windows.getStage()?.webContents.send('toggle-mic'))

  power.watchPower((onBattery) => windows.getStage()?.webContents.send('power:battery', onBattery))

  updater.start()

  stage.webContents.once('did-finish-load', () => {
    const code = pendingInvite ?? inviteFromArgv(process.argv)
    pendingInvite = null
    if (code) stage.webContents.send('invite', code)
  })
}

// ------------------------------------------------------------------- IPC

function installIpc(): void {
  ipcMain.handle('sources:list', () => capture.listSources())

  ipcMain.handle(
    'capture:arm',
    (_e, sourceId: string, withAudio: boolean, muteLocal: boolean) => {
      capture.arm({ sourceId, withAudio, muteLocal })
      return capture.routesFilmThroughMixer()
    },
  )

  ipcMain.handle('settings:read', () => store.read())
  ipcMain.handle('settings:write', (_e, patch: Partial<Settings>) => store.write(patch))

  ipcMain.handle('perm:get', () => capture.permissions())
  ipcMain.handle('perm:open', async (_e, kind: 'camera' | 'microphone' | 'screen') => {
    if (!isMac) return
    // Ask in-process first; the OS only shows its prompt once ever, after which
    // the user has to be walked to System Settings.
    if (kind !== 'screen') {
      const granted = await capture.requestPermission(kind)
      if (granted) return
    }
    const pane = {
      camera: 'Privacy_Camera',
      microphone: 'Privacy_Microphone',
      screen: 'Privacy_ScreenCapture',
    }[kind]
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`)
  })

  ipcMain.handle('audio:ducking', () => audioEnv.readDucking())
  ipcMain.handle('audio:stop-ducking', () => audioEnv.stopDucking())
  ipcMain.handle('audio:sound-settings', () => audioEnv.openSoundSettings())

  ipcMain.handle('power:keepAwake', (_e, on: boolean) => power.keepAwake(on))
  ipcMain.handle('power:battery', () => power.onBattery())

  ipcMain.on('call:state', (_e, s: { connected: boolean; sharing: boolean; micOn: boolean }) => {
    tray.setState(s)
    // Only hold the display awake while a picture is actually moving.
    power.keepAwake(s.sharing || s.connected)
  })

  ipcMain.on('window:minimise', () => windows.getStage()?.minimize())
  ipcMain.on('window:toggleMaximise', () => {
    const w = windows.getStage()
    if (!w) return
    w.isMaximized() ? w.unmaximize() : w.maximize()
  })
  ipcMain.on('window:close', () => windows.getStage()?.close())
  ipcMain.on('window:fullscreen:set', (_e, on: boolean) => windows.getStage()?.setFullScreen(on))
  ipcMain.handle('window:fullscreen:get', () => windows.getStage()?.isFullScreen() ?? false)

  ipcMain.on('bar:size', (_e, width: number, height: number) => windows.resizeBar(width, height))
  ipcMain.on('bar:pin', (_e, pinned: boolean) => windows.pinBar(pinned))
  // Linux/X11: the panel collapses to a sliver and the pointer entering it is a
  // real event, rather than something we poll for and get a stale answer to.
  ipcMain.on('bar:hot', (_e, hot: boolean) => windows.setBarHot(hot))
  ipcMain.on('window:show', () => {
    const w = windows.getStage()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })

  ipcMain.on('faces:size', (_e, width: number, height: number) => windows.resizeFaces(width, height))
  ipcMain.on('faces:reset', () => windows.resetFacesPosition())
}

// ------------------------------------------------------------------ menu

function installMenu(): void {
  // Keep the menu minimal but real — macOS needs one for copy/paste to work at
  // all, and the shortcuts below are the app's whole keyboard surface.
  const send = (channel: string) => () => windows.getStage()?.webContents.send(channel)

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? ([{ role: 'appMenu' as const }]) : []),
      {
        label: 'Call',
        submenu: [
          { label: 'Toggle Microphone', accelerator: 'CmdOrCtrl+D', click: send('toggle-mic') },
          { label: 'Toggle Camera', accelerator: 'CmdOrCtrl+E', click: send('toggle-cam') },
          { label: 'Share a Screen or Window…', accelerator: 'CmdOrCtrl+S', click: send('share') },
          { type: 'separator' },
          { label: 'Show / Hide Faces', accelerator: 'CmdOrCtrl+F', click: send('faces:toggle') },
          { label: 'Recentre Faces', click: () => windows.resetFacesPosition() },
          { type: 'separator' },
          { label: 'Leave', accelerator: 'CmdOrCtrl+W', click: send('leave') },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'togglefullscreen' },
          { role: 'resetZoom' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
          { role: 'reload' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  )
}

function preload(): string {
  return windows.preloadPath()
}
