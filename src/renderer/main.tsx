import { render } from 'preact'
import { effect } from '@preact/signals'
import './styles/app.css'
import { App } from './ui/App.js'
import { Faces } from './ui/Faces.js'
import { ControlBar } from './ui/ControlBar.js'
import * as S from './core/state.js'
import { boot } from './core/app.js'

// The Stage window is the app. It owns every MediaStream, every peer connection
// and all state, and it *renders into* the Faces window rather than talking to
// it — they share a renderer process, so a child window is close enough to a
// div that Preact can just draw there. One runtime, one store, nothing to sync.

render(<App />, document.getElementById('root')!)
void boot()

/**
 * Wayland gives an app no way to place a window, raise it, or keep it on top:
 * setAlwaysOnTop stores the value and discards it, setPosition and moveTop and
 * showInactive are documented no-ops, and getBounds always answers (0,0). Two
 * frameless always-on-top overlays are therefore two windows that land wherever
 * the compositor feels like, BEHIND the film, in the taskbar, unmovable.
 *
 * So on Wayland the overlays are drawn inside the Stage instead. Less good —
 * they can't follow you into another app — but honest, and it works.
 */
const INLINE_OVERLAYS = window.cozy.inlineOverlays

// ------------------------------------------------------- the Faces window

let facesWindow: Window | null = null
/** Where we rendered the overlay, so it can be unmounted before the window
 *  goes. Without this every hide/show cycle leaves a live Preact tree behind,
 *  still subscribed to the store, still holding <video> elements pointed at
 *  peer MediaStreams, re-rendering into a document nobody can see. */
let facesHost: Element | null = null

let barWindow: Window | null = null
let barHost: Element | null = null

interface FacesBridge {
  mountFaces(doc: Document): void
  mountBar(doc: Document): void
}

;(window as unknown as { __cozy: FacesBridge }).__cozy = {
  mountFaces(doc: Document) {
    doc.body.classList.add('faces-window')
    adoptStyles(doc)
    const host = doc.getElementById('faces') ?? doc.body
    facesHost = host
    render(<Faces />, host)
  },

  mountBar(doc: Document) {
    doc.body.classList.add('bar-window')
    adoptStyles(doc)
    const host = doc.getElementById('bar') ?? doc.body
    barHost = host
    render(<ControlBar />, host)
  },
}

/** The child document has no bundle of its own, so lend it ours. */
function adoptStyles(doc: Document): void {
  for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    doc.head.appendChild(node.cloneNode(true))
  }
  // Vite swaps <style> contents on hot reload; keep the child in step.
  if (import.meta.hot) {
    new MutationObserver(() => {
      doc.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((n) => n.remove())
      for (const node of document.querySelectorAll('style, link[rel="stylesheet"]')) {
        doc.head.appendChild(node.cloneNode(true))
      }
    }).observe(document.head, { childList: true, subtree: true, characterData: true })
  }
}

// The control bar exists for the whole call. Unlike the faces it has no
// visibility toggle — hiding it would leave someone with no way to unmute.
effect(() => {
  const wanted = S.scene.value === 'call' && !INLINE_OVERLAYS
  if (wanted && (!barWindow || barWindow.closed)) {
    barWindow = window.open('bar.html', 'cozy-bar')
  } else if (!wanted && barWindow && !barWindow.closed) {
    unmountBar()
    barWindow.close()
    barWindow = null
  }
})

effect(() => {
  const wanted = S.scene.value === 'call' && S.facesVisible.value && !INLINE_OVERLAYS
  if (wanted && (!facesWindow || facesWindow.closed)) {
    // The options that make it float (frameless, transparent, always-on-top)
    // are applied in the main process — see setWindowOpenHandler.
    facesWindow = window.open('faces.html', 'cozy-faces')
  } else if (!wanted && facesWindow && !facesWindow.closed) {
    unmountFaces()
    facesWindow.close()
    facesWindow = null
  }
})

function unmountBar(): void {
  if (!barHost) return
  try {
    render(null, barHost)
  } catch {
    /* the document may already be gone */
  }
  barHost = null
}

function unmountFaces(): void {
  if (!facesHost) return
  try {
    render(null, facesHost)
  } catch {
    /* the document may already be gone */
  }
  facesHost = null
}

// If the Stage goes away, so does the overlay it was drawing.
window.addEventListener('beforeunload', () => {
  unmountFaces()
  unmountBar()
  if (facesWindow && !facesWindow.closed) facesWindow.close()
  if (barWindow && !barWindow.closed) barWindow.close()
})
