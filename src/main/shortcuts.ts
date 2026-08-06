import { globalShortcut } from 'electron'

// When you're sharing, you're off in VLC or a browser — not in Cozy. A global
// mute is the one shortcut that genuinely needs to work from anywhere.

const ACCELERATOR = process.platform === 'darwin' ? 'Alt+Shift+A' : 'Ctrl+Shift+A'

export function register(onToggleMic: () => void): boolean {
  try {
    // Registration fails if another app already owns the combination; that's
    // not worth an error dialog, the in-app shortcut still works.
    return globalShortcut.register(ACCELERATOR, onToggleMic)
  } catch {
    return false
  }
}

export function unregister(): void {
  globalShortcut.unregisterAll()
}

export const accelerator = ACCELERATOR
