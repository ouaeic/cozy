import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { APP_ORIGIN } from './protocol.js'
import * as store from './store.js'

const isMac = process.platform === 'darwin'
const isDev = !!process.env.ELECTRON_RENDERER_URL

const INK = '#141312' // warm charcoal — matches --ink in app.css

let stage: BrowserWindow | null = null
let faces: BrowserWindow | null = null
let bar: BrowserWindow | null = null

export const getStage = () => stage

// ---------------------------------------------------------------- Stage

/** The main window: home screen, then the shared picture. Opaque on purpose —
 *  transparency is the expensive kind of window, and only Faces needs it. */
export function createStage(preload: string): BrowserWindow {
  const remembered = rememberedStageBounds()
  const win = new BrowserWindow({
    width: 1180,
    height: 720,
    ...remembered,
    minWidth: 520,
    minHeight: 360,
    show: false,
    backgroundColor: INK,
    // Native window controls, no native title bar — we draw our own chrome.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 18, y: 20 } } : {}),
    ...(isMac
      ? {}
      : {
          titleBarOverlay: { color: INK, symbolColor: '#A79E95', height: 44 },
        }),
    webPreferences: {
      preload,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Video decode should keep running when the window is behind something.
      backgroundThrottling: false,
    },
  })

  win.once('ready-to-show', () => win.show())

  // Persist size and position, but not while maximised or fullscreen — those
  // report the screen's dimensions, and restoring to them would leave the
  // window filling the display with no way to tell it once was smaller.
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  const rememberBounds = () => {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen() || win.isMinimized()) return
    if (saveTimer) clearTimeout(saveTimer)
    // Coalesce: a drag emits these continuously.
    saveTimer = setTimeout(() => store.write({ stageBounds: win.getBounds() }), 400)
  }
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)

  // Our own windows FIRST. Under `npm run dev` the renderer origin is
  // http://localhost:5173, so testing the http prefix first sent faces.html and
  // bar.html to the user's browser: two blank tabs whose inline script threw on
  // a null window.opener, and no overlays in the app at all. Packaged builds
  // load from app://, which is why every test suite missed it.
  win.webContents.setWindowOpenHandler((details) => {
    if (isFacesUrl(details.url)) return facesWindowOptions()
    if (isBarUrl(details.url)) return barWindowOptions()
    // Anything else that looks like the web really is the outside world.
    if (details.url.startsWith('http://') || details.url.startsWith('https://')) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // Catch the Faces window the moment it exists so we can apply the options
  // that aren't expressible in BrowserWindowConstructorOptions.
  win.webContents.on('did-create-window', (child, details) => {
    if (isFacesUrl(details.url)) {
      faces = child
      configureFaces(child)
      child.on('closed', () => {
        faces = null
      })
      return
    }
    if (isBarUrl(details.url)) {
      bar = child
      configureBar(child)
      child.on('closed', () => {
        bar = null
        stopCursorWatch()
      })
    }
  })

  const reportFullscreen = () => {
    win.webContents.send('window:fullscreen', win.isFullScreen())
    // The Stage just moved to (or left) its own Space. Pin the overlay again on
    // the other side of the transition, or it stays behind on the old one.
    reassertFacesFloat()
    setTimeout(reassertFacesFloat, 700) // once more after macOS finishes animating
  }
  win.on('enter-full-screen', reportFullscreen)
  win.on('leave-full-screen', reportFullscreen)

  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)

  stage = win
  win.on('closed', () => {
    stage = null
    // The Stage owns all the media; without it the overlays are empty frames.
    if (faces && !faces.isDestroyed()) faces.destroy()
    if (bar && !bar.isDestroyed()) bar.destroy()
    stopCursorWatch()
  })
  return win
}

const isFacesUrl = (url: string) => url.includes('faces.html')
const isBarUrl = (url: string) => url.includes('bar.html')

/** Only honour a remembered position if that screen still exists — monitors get
 *  unplugged, and a window restored onto one that's gone is a window you can't
 *  reach. */
function rememberedStageBounds(): { x: number; y: number; width: number; height: number } | undefined {
  const saved = store.read().stageBounds
  if (!saved) return undefined
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return (
      saved.x + saved.width > a.x + 80 &&
      saved.x < a.x + a.width - 80 &&
      saved.y >= a.y - 8 &&
      saved.y < a.y + a.height - 80
    )
  })
  return visible ? saved : undefined
}

// ---------------------------------------------------------------- Faces

/** Options handed back to setWindowOpenHandler. Transparency and framelessness
 *  can only be set at creation time, so they have to live here. */
function facesWindowOptions(): { action: 'allow'; overrideBrowserWindowOptions: object } {
  const { width, height, x, y } = defaultFacesBounds()
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width,
      height,
      x,
      y,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false, // we draw a softer one in CSS
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // A panel, on macOS, is the difference between "floats above other
      // windows" and "floats above everything, including whatever app someone
      // else just put into fullscreen". Only an NSPanel can join another
      // application's fullscreen Space; a plain NSWindow gets left behind on
      // the previous one however high you set its level.
      //
      // macOS logs "NSWindow does not support nonactivating panel styleMask"
      // once at creation because the frameless+transparent mask isn't a
      // combination it likes. The message is cosmetic; the panel behaviour we
      // need is applied regardless, and is verified by test/fullscreen.test.mjs.
      ...(isMac ? { type: 'panel' as const } : {}),
      webPreferences: {
        // No preload: this window is driven entirely by its opener, which is
        // in the same process and already has the bridge.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    },
  }
}

/**
 * Make the overlay float above everything, including other apps in fullscreen.
 *
 * Order is load-bearing and was got wrong once already. These collection
 * behaviours have to be applied to a window that is already on screen: set
 * them while it's still hidden and macOS quietly drops them, which reads as
 * "always on top doesn't work" with nothing logged. Hence everything happens
 * after showInactive(), and gets re-asserted whenever the Stage enters
 * fullscreen — that transition moves the Stage to a fresh Space and is exactly
 * when a mis-configured overlay gets left behind on the old one.
 */
function floatAboveEverything(win: BrowserWindow, relativeLevel = 1): void {
  if (win.isDestroyed()) return
  // Join every Space, including other apps' fullscreen ones. This is the flag
  // that matters, and it has to be set before the level or macOS re-clamps it.
  // skipTransformProcessType keeps our dock icon from disappearing.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  // 'screen-saver' is the highest level Electron exposes — above the level a
  // fullscreen application's window gets.
  win.setAlwaysOnTop(true, 'screen-saver', relativeLevel)
  win.moveTop()
}

function configureFaces(win: BrowserWindow): void {
  // Keeps the overlay out of the stream when you share your whole screen.
  // WDA_EXCLUDEFROMCAPTURE on Windows, NSWindowSharingNone on macOS — and it
  // genuinely works on both. Measured on macOS 14.6 by sharing an entire screen
  // with the overlay painted a solid colour: 0 of 576 sampled pixels of it
  // reached the far end (test/share.test.mjs). An earlier comment here claimed
  // ScreenCaptureKit ignored it; that was wrong.
  //
  // Not on Linux, where Electron implements this for darwin and win32 only and
  // there is no X11 or Wayland mechanism to fall back on — see LIMITATIONS.
  win.setContentProtection(true)

  restoreFacesPosition(win)
  win.on('moved', () => rememberFacesPosition(win))
  win.once('ready-to-show', () => {
    win.showInactive()
    floatAboveEverything(win)
  })
  // A resize can re-seat the window; keep the behaviours pinned to it.
  win.on('show', () => floatAboveEverything(win))
}

/** Called when the Stage enters or leaves fullscreen. */
export function reassertFacesFloat(): void {
  if (faces && !faces.isDestroyed()) floatAboveEverything(faces)
}

/** Top-right of whichever display the pointer is on, tucked in by a margin. */
function defaultFacesBounds(): { width: number; height: number; x: number; y: number } {
  const width = 236
  const height = 168
  const margin = 24
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const wa = display.workArea
  return {
    width,
    height,
    x: Math.round(wa.x + wa.width - width - margin),
    y: Math.round(wa.y + margin),
  }
}

function displayKey(win: BrowserWindow): string {
  const b = win.getBounds()
  return String(screen.getDisplayNearestPoint({ x: b.x, y: b.y }).id)
}

function rememberFacesPosition(win: BrowserWindow): void {
  const { x, y } = win.getBounds()
  const positions = { ...(store.read().facesPos ?? {}) }
  positions[displayKey(win)] = { x, y }
  store.write({ facesPos: positions })
}

function restoreFacesPosition(win: BrowserWindow): void {
  const saved = store.read().facesPos?.[displayKey(win)]
  if (!saved) return
  // Only honour it if that spot still exists — monitors get unplugged.
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return saved.x >= a.x - 40 && saved.x < a.x + a.width - 40 && saved.y >= a.y - 40 && saved.y < a.y + a.height - 40
  })
  if (onScreen) win.setPosition(saved.x, saved.y)
}

/** Called from the renderer as the tile size changes. */
export function resizeFaces(width: number, height: number): void {
  if (!faces || faces.isDestroyed()) return
  const { x, y } = faces.getBounds()
  const display = screen.getDisplayNearestPoint({ x, y })
  const wa = display.workArea
  // Grow leftwards/downwards from where it sits, but never off the edge.
  const nx = Math.min(Math.max(x, wa.x), wa.x + wa.width - width)
  const ny = Math.min(Math.max(y, wa.y), wa.y + wa.height - height)
  faces.setBounds({ x: Math.round(nx), y: Math.round(ny), width, height }, false)
}

export function resetFacesPosition(): void {
  if (!faces || faces.isDestroyed()) return
  const b = defaultFacesBounds()
  const cur = faces.getBounds()
  faces.setBounds({ x: b.x + (b.width - cur.width), y: b.y, width: cur.width, height: cur.height }, false)
  rememberFacesPosition(faces)
}

export function preloadPath(): string {
  return join(import.meta.dirname, '../preload/index.mjs')
}

// ------------------------------------------------------------------ Bar
//
// The controls live on the SCREEN, not in the app window.
//
// The moment you share something you stop looking at Cozy — you're in a video
// player, or a browser, and Cozy is behind it. Controls inside the app window
// mean alt-tabbing away from the film to mute yourself, which is exactly the
// wrong thing to make someone do. So the bar is a second always-on-top panel,
// like the faces: it hides at the top edge of the display and comes down when
// you push the cursor up there, from whatever app you happen to be in.

const BAR_REVEAL_ZONE = 4 // px from the very top of the display
const BAR_HIDE_GRACE = 420 // ms of being away before it retracts
const CURSOR_POLL_MS = 120

function barWindowOptions(): { action: 'allow'; overrideBrowserWindowOptions: object } {
  // The display the film is on, not the one the pointer happens to be resting
  // on when the call connects. pollCursor still moves the panel to follow the
  // pointer across displays once it's up; this is only where it starts.
  const anchor = stage && !stage.isDestroyed() ? stage.getBounds() : null
  const display = anchor
    ? screen.getDisplayNearestPoint({
        x: Math.round(anchor.x + anchor.width / 2),
        y: Math.round(anchor.y + anchor.height / 2),
      })
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const width = 560
  const height = 76
  const at = barBounds(display, { width, height })
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      width,
      height,
      x: at.x,
      y: at.y,
      // Required to sit flush at y=0 on macOS. AppKit's constrainFrameRect
      // otherwise pushes any window down below the menu bar — you ask for 0 and
      // silently get 25, which is exactly the "hovering near the top rather
      // than at it" symptom.
      enableLargerThanScreen: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      // macOS rounds a frameless window's corners for you, which rounded the
      // TOP two — so the panel read as a pill parked near the edge rather than
      // something hanging off it. The CSS wants square top corners; this lets
      // it have them.
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Without this the FIRST click on an unfocused window is eaten as the
      // click-to-focus, so reaching over from VLC to hit mute does nothing and
      // you have to click twice. It is the difference between the panel feeling
      // instant and feeling broken.
      acceptFirstMouse: true,
      // macOS: an NSPanel is genuinely non-activating — you can hit mute
      // without pulling the film out of focus, which is the whole point.
      //
      // Windows and Linux get nothing equivalent, deliberately. The obvious
      // candidate, `focusable: false`, sets WS_EX_NOACTIVATE — but Chromium
      // checks `HasNonClientView()` before it ever looks at that style and
      // returns MA_NOACTIVATEANDEAT, which does not just decline to activate,
      // it DISCARDS the mouse message. The button would stop working. The
      // usual approach for a floating overlay is to accept the focus change
      // instead, and that is what we do: clicking the panel
      // briefly focuses Cozy there, which is a smaller cost than a mute button
      // that does nothing.
      ...(isMac ? { type: 'panel' as const } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    },
  }
}

function configureBar(win: BrowserWindow): void {
  win.setContentProtection(true)
  // `show: false` is not reliably honoured for a window.open() child — Chromium
  // shows it anyway. Our `shown` flag then said false while the panel was
  // actually on screen, so the retract branch returned early every tick and the
  // panel never hid. Force the two into agreement before the watcher starts.
  win.hide()
  shown = false
  win.once('ready-to-show', () => {
    // Deliberately NOT calling floatAboveEverything here. It ends in moveTop(),
    // which brings a hidden window back on screen — which is precisely why the
    // panel appeared at launch and then never retracted: our `shown` flag said
    // false, so the retract branch had nothing to do, while the window sat
    // there. The float behaviours are applied at reveal time instead, in
    // pollCursor, which is also where macOS wants them (they only stick on a
    // window that is already on screen).
    win.hide()
    shown = false
    startCursorWatch()
  })
}

/**
 * Centred against the very top edge of the display.
 *
 * Deliberately `bounds`, not `workArea`: workArea starts below the menu bar, and
 * a panel that appears 25px down reads as floating near the top rather than
 * belonging to it. At the screen-saver window level we sit above the menu bar
 * anyway, and the panel is only on screen while you're reaching for it.
 */
function barBounds(display: Electron.Display, size: { width: number; height: number }) {
  const b = display.bounds
  return {
    x: Math.round(b.x + (b.width - size.width) / 2),
    y: Math.round(b.y),
    width: size.width,
    height: size.height,
  }
}

/** The panel's content size, so the hot strip knows what to expand back to. */
let barContentWidth = 560
let barContentHeight = 76

export function resizeBar(width: number, height: number): void {
  if (!bar || bar.isDestroyed()) return
  barContentWidth = Math.round(width)
  barContentHeight = Math.round(height)
  // While collapsed, remember the new size but stay collapsed — expanding here
  // would make the panel appear without the pointer having asked for it.
  if (HOT_STRIP && !shown) return armHotStrip()
  const current = bar.getBounds()
  const display = screen.getDisplayNearestPoint({ x: current.x, y: current.y })
  bar.setBounds(barBounds(display, { width: barContentWidth, height: barContentHeight }), false)
}

// ------------------------------------------------------------ cursor watch
//
// Reveal is driven by polling the cursor rather than by a transparent
// click-through strip across the top of the screen. The strip approach relies
// on mouse-event forwarding reaching an unfocused window, and puts a window
// over the macOS menu bar and the Windows taskbar. A poll is a few syscalls a
// second, works identically everywhere, and touches nothing it doesn't own.

let cursorTimer: ReturnType<typeof setInterval> | null = null
let hideAt = 0
let shown = false
/** Which display it's currently sitting on, so a move to another one is noticed
 *  even when it's already down. */
let shownDisplayId: number | null = null

/**
 * Reveal-on-cursor is a macOS and Windows feature, and saying so is better than
 * shipping something that silently misbehaves.
 *
 * On Wayland `getCursorScreenPoint()` returns the cursor's position inside our
 * OWN focused window, and when nothing of ours is focused, a made-up point just
 * past the largest window's corner. Both look like plausible screen
 * coordinates, which is worse than an obvious sentinel would be — so the
 * "is the pointer at the top of the screen" test would be permanently true and
 * the panel would pin open forever. On X11 Chromium caches the last pointer
 * position from events *our own windows* received and never refreshes it once
 * the pointer leaves them, so the poll reads a stale point indefinitely
 * (electron#42519, still open). Neither is a bug we can fix from here.
 *
 * So Linux gets the same behaviour by a different route: the panel window stays
 * alive but collapsed to a sliver at the top of the screen, and the pointer
 * ENTERING it is a real event the window receives — no polling, nothing to read
 * a stale answer from. It is only as wide as the panel itself, so the rest of
 * the desktop's top edge stays clickable.
 *
 * Wayland can't place a window at all, so it keeps the in-window overlays.
 */
const CURSOR_WATCH_WORKS = process.platform === 'darwin' || process.platform === 'win32'

/** Height of the invisible sliver that catches the pointer on Linux/X11. */
const HOT_STRIP_HEIGHT = 2

const HOT_STRIP =
  process.env.COZY_HOT_STRIP === '1' || (process.platform === 'linux' && !isWaylandSession())

function isWaylandSession(): boolean {
  return (
    process.platform === 'linux' &&
    (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY)
  )
}

/** Collapse to the sliver, so the pointer can find it again. */
function armHotStrip(): void {
  if (!bar || bar.isDestroyed()) return
  const b = bar.getBounds()
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y })
  bar.setBounds(
    { ...barBounds(display, { width: barContentWidth, height: HOT_STRIP_HEIGHT }) },
    false,
  )
  bar.showInactive()
  floatAboveEverything(bar, 2)
}

/** The pointer reached the sliver (or left the panel). Same reveal path the
 *  cursor watch uses on macOS and Windows, so both ends behave identically. */
export function setBarHot(hot: boolean): void {
  if (!HOT_STRIP || !bar || bar.isDestroyed()) return
  if (hot) {
    hideAt = 0
    if (shown) return
    shown = true
    const b = bar.getBounds()
    const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y })
    bar.setBounds(barBounds(display, { width: barContentWidth, height: barContentHeight }), false)
    bar.showInactive()
    floatAboveEverything(bar, 2)
    stage?.webContents.send('bar:visible', true)
    return
  }
  if (!shown || barPinned) return
  shown = false
  stage?.webContents.send('bar:visible', false)
  armHotStrip()
}

function startCursorWatch(): void {
  if (HOT_STRIP) {
    armHotStrip()
    shown = false
    return
  }
  if (!CURSOR_WATCH_WORKS) {
    // Wayland: nothing to poll and nowhere to put the window, so the panel is
    // drawn inside the Stage instead (see renderer/main.tsx).
    if (bar && !bar.isDestroyed()) {
      bar.showInactive()
      floatAboveEverything(bar, 2)
      shown = true
      stage?.webContents.send('bar:visible', true)
    }
    return
  }
  if (cursorTimer) return
  cursorTimer = setInterval(pollCursor, CURSOR_POLL_MS)
}

function stopCursorWatch(): void {
  if (cursorTimer) clearInterval(cursorTimer)
  cursorTimer = null
  shown = false
  hideAt = 0
  shownDisplayId = null
}

/** Held open while a popover is up, so the bar can't retract mid-interaction. */
let barPinned = false
export function pinBar(pinned: boolean): void {
  if (HOT_STRIP) {
    barPinned = pinned
    setBarHot(pinned || shown)
    if (!pinned) setBarHot(false)
    return
  }
  barPinned = pinned
  if (pinned) hideAt = 0
}

function pollCursor(): void {
  if (!bar || bar.isDestroyed()) return
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point)
  const bounds = bar.getBounds()

  const atTopEdge = point.y <= display.bounds.y + BAR_REVEAL_ZONE
  // Once it's down, keep it down while the pointer is anywhere over it (plus a
  // little slack, so a slightly wobbly hand doesn't dismiss it).
  const overBar =
    shown &&
    point.x >= bounds.x - 24 &&
    point.x <= bounds.x + bounds.width + 24 &&
    point.y <= bounds.y + bounds.height + 24

  if (atTopEdge || overBar || barPinned) {
    hideAt = 0
    if (!shown) {
      // Follow the cursor to whichever display it's on.
      bar.setBounds(barBounds(display, { width: bounds.width, height: bounds.height }), false)
      bar.showInactive()
      floatAboveEverything(bar, 2)
      shown = true
      // To the STAGE, not to the panel: the panel window has no preload — it is
      // rendered into by its opener — so anything sent to it lands nowhere.
      stage?.webContents.send('bar:visible', true)
    }
    return
  }

  if (!shown) return
  if (!hideAt) hideAt = Date.now() + BAR_HIDE_GRACE
  if (Date.now() >= hideAt) {
    shown = false
    hideAt = 0
    stage?.webContents.send('bar:visible', false)
    bar.hide()
  }
}
