import { app } from 'electron'
import * as store from './store.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import electronUpdater from 'electron-updater'

// Updates, done quietly.
//
// Cozy is for two people who open it once a week to watch something. The worst
// possible moment to interrupt is the one moment they use it — so nothing here
// is allowed to show a dialog, steal focus, or restart anything mid-evening.
// The new version is fetched in the background and installed when the app is
// next quit, which for this app is the same evening, after the film.
//
// Unsigned builds are fine on Windows and Linux. macOS refuses to auto-update
// an unsigned app (Squirrel.Mac verifies the signature), so there we quietly do
// nothing rather than fail on a timer forever — see the README on signing.

const { autoUpdater } = electronUpdater

/**
 * A .deb or .rpm can only be replaced by root. electron-updater's Linux path
 * runs `pkexec dpkg -i`, which raises a polkit PASSWORD PROMPT — and it does it
 * from the quit handler, as the user closes the app after the film. With no
 * polkit agent it silently falls back to a TTY-less `sudo` and just fails.
 *
 * Neither outcome is acceptable for something that promised not to interrupt,
 * so on package installs Cozy doesn't self-update at all: the distribution's
 * own package manager owns that file. AppImage is fine — it rewrites itself in
 * place with no privileges, and self-disables when $APPIMAGE isn't set.
 */
const isPackageInstall = (() => {
  if (process.platform !== 'linux') return false
  // An AppImage always sets $APPIMAGE, and it is checked FIRST on purpose:
  // electron-builder writes resources/package-type into the same
  // linux-<arch>-unpacked directory that the AppImage is packaged from, so a
  // machine that has built a .deb can ship an AppImage carrying
  // `package-type=deb`. Trusting that file alone would disable updates for the
  // one Linux format that can actually do them safely.
  if (process.env.APPIMAGE) return false
  try {
    return ['deb', 'rpm', 'pacman'].includes(
      readFileSync(join(process.resourcesPath, 'package-type'), 'utf8').trim(),
    )
  } catch {
    return false // no such file: an unpacked or distro-packaged build
  }
})()

/** Whether this build can actually replace itself. */
const canSelfUpdate = () => app.isPackaged && process.platform !== 'darwin' && !isPackageInstall

export function start(): void {
  if (!canSelfUpdate()) return

  autoUpdater.autoDownload = true
  // The install happens on quit, not on download. Nobody gets a restart prompt
  // in the middle of a film.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false

  // A failed update check is not an error worth surfacing — the user is here to
  // watch something, and the old version still works.
  autoUpdater.on('error', (err) => console.warn('[updater]', err?.message ?? err))
  autoUpdater.on('update-downloaded', (info) =>
    console.log(`[updater] ${info.version} ready; installs on quit`),
  )

  const check = () => {
    // Read the setting each time rather than at startup, so turning it off
    // takes effect immediately instead of at the next launch. This is the only
    // thing Cozy does without being asked, and docs/PRIVACY.md says as much —
    // so it needs a switch, not just a disclosure.
    if (!store.read().autoUpdate) return
    autoUpdater.checkForUpdates().catch(() => {
      /* offline, rate-limited, or no release yet */
    })
  }

  // Once shortly after launch, then daily for anyone who leaves it running.
  setTimeout(check, 15_000).unref?.()
  setInterval(check, 24 * 60 * 60 * 1000).unref?.()
}
