// Is the overlay on top of everything, always?
//
// Not "on top of Cozy" — on top of whatever anyone else has fullscreened. So
// this drives TWO separate processes: one goes fullscreen, and we check the
// OTHER one's overlay is still above it. That's the case a browser tab can
// never handle, and the one people actually hit, because the whole point is
// watching a film in someone else's fullscreen player.
//
//   npm run server:dev &
//   npm run build && npm run test:fullscreen
//
// Note on method: the overlay sets content protection so it never leaks into a
// shared screen, which also makes it invisible to screencapture — sampling
// pixels can NEVER see it, however well it's working. (That cost an hour once.)
// So we ask the window server directly instead: CoreGraphics knows every
// window's layer and stacking order whether or not it can be photographed.

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { attach, reporter, sleep, reapOnExit, reapNow, deadline, REPO, ELECTRON, descendantsOf } from './cdp.mjs'

// The display names below must be ones the generator could produce:
// startup replaces anything else, because names are assigned, not typed.
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const WORK = join(tmpdir(), 'cozy-test')
const { check, finish } = reporter()
const clearDeadline = deadline()
const procs = []
/** Every launch is registered so it dies with the harness, however it ends. */
const track = (proc) => {
  procs.push(proc)
  reapOnExit({ proc })
  return proc
}

if (process.platform !== 'darwin') {
  console.log('macOS-only (uses CoreGraphics window layers); skipping.')
  process.exit(0)
}

// --- the window-server probe -------------------------------------------------
const probe = join(WORK, 'windowlayers')
if (!existsSync(probe)) {
  try {
    execFileSync('/usr/bin/swiftc', ['-O', '-o', probe, join(dirname(new URL(import.meta.url).pathname), 'windowlayers.swift')])
  } catch (err) {
    console.log('Could not build the window probe (needs Xcode command line tools):', String(err))
    process.exit(1)
  }
}
const windows = () => JSON.parse(execFileSync(probe).toString())
// Scoped to the instances THIS suite launched. Matching on owner name alone
// also matched any other Electron app and anything a previous suite was still
// tearing down — which here would be a FALSE PASS, since the assertions below
// are "a Faces overlay exists above the fullscreen app".
const cozyWindows = () => {
  const ours = descendantsOf(procs.map((p) => p.pid).filter(Boolean))
  return windows().filter((w) => ours.has(w.pid))
}
const overlays = () => cozyWindows().filter((w) => w.name.includes('Faces'))

const REACHED = `for (let i=0;i<60;i++){ if (document.querySelector('.stage')) return true; await new Promise(r=>setTimeout(r,500)); } return false;`

const launch = (port, profile) =>
  track(
    spawn(
      ELECTRON,
      [
        '.',
        `--user-data-dir=${join(WORK, profile)}`,
        `--remote-debugging-port=${port}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
      { cwd: REPO, stdio: 'ignore' },
    ),
  )

try {
  launch(9501, 'fs-a')
  launch(9502, 'fs-b')
  let a = await (await attach(9501)).init()
  let b = await (await attach(9502)).init()

  for (const [client, name] of [
    [a, 'SwiftFox'],
    [b, 'CosmicOtter'],
  ]) {
    await client
      .eval(
        `await window.cozy.writeSettings({ signalUrl: ${JSON.stringify(SIGNAL)}, name: ${JSON.stringify(name)}, partner: null, selfView: true, faceSize: 'M' });
         location.reload();`,
      )
      .catch(() => {})
  }
  await sleep(2500)
  a = await (await attach(9501)).init()
  b = await (await attach(9502)).init()
  await sleep(1500)

  await a.eval(`document.querySelector('.btn--primary').click(); return true;`)
  const code = await a.eval(`
    for (let i=0;i<40;i++){ const el=document.querySelector('.code'); if (el) return el.textContent.trim().split('\\n')[0].trim(); await new Promise(r=>setTimeout(r,200)); }
    return null;`)
  await b.eval(`
    const input = document.querySelector('.hearth__join input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(code ?? '')});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('.hearth__join .btn')?.click();
    return true;`)
  check('two separate processes connected', (await a.eval(REACHED)) && (await b.eval(REACHED)))
  await sleep(6000)

  const windowed = overlays()
  console.log('overlays, windowed:', JSON.stringify(windowed.map((w) => ({ layer: w.layer, at: `${w.x},${w.y}`, size: `${w.w}x${w.h}` }))))
  check('both overlays are on screen', windowed.length >= 2, `${windowed.length} found`)

  // NSNormalWindowLevel is 0 and NSScreenSaverWindowLevel is 1000. Anything
  // comfortably above the menu bar (25) is above every ordinary window.
  check(
    'the overlay sits on a floating window layer',
    windowed.length > 0 && windowed.every((w) => w.layer >= 1000),
    windowed.map((w) => w.layer).join(', '),
  )

  const normals = cozyWindows().filter((w) => !w.name.includes('Faces') && w.h > 200)
  check(
    'and above the app windows',
    normals.length > 0 && Math.min(...windowed.map((w) => w.layer)) > Math.max(...normals.map((w) => w.layer)),
    `overlay ${Math.min(...windowed.map((w) => w.layer))} vs windows ${Math.max(...normals.map((w) => w.layer))}`,
  )

  // --- now put the OTHER process into fullscreen ---
  await a.eval(`window.cozy.window.setFullscreen(true); return true;`)
  await sleep(4500) // macOS animates the Space transition

  check(
    'the other process really went fullscreen',
    (await a.eval(`return await window.cozy.window.isFullscreen()`)) === true,
  )

  const all = cozyWindows()
  const stillUp = all.filter((w) => w.name.includes('Faces'))
  const fullscreenWindow = all
    .filter((w) => !w.name.includes('Faces'))
    .sort((x, y) => y.w * y.h - x.w * x.h)[0]

  console.log('overlays over fullscreen:', JSON.stringify(stillUp.map((w) => ({ layer: w.layer, order: w.order, at: `${w.x},${w.y}` }))))
  console.log('fullscreen window:', JSON.stringify(fullscreenWindow && { layer: fullscreenWindow.layer, order: fullscreenWindow.order, size: `${fullscreenWindow.w}x${fullscreenWindow.h}` }))

  check(
    'the overlay is still on screen with another app fullscreen',
    stillUp.length >= 1,
    `${stillUp.length} on screen`,
  )
  check(
    'it is on a higher layer than the fullscreen window',
    !!fullscreenWindow && stillUp.every((w) => w.layer > fullscreenWindow.layer),
    fullscreenWindow ? `overlay ${stillUp.map((w) => w.layer).join('/')} vs fullscreen ${fullscreenWindow.layer}` : 'no fullscreen window found',
  )
  check(
    'and stacked in front of it',
    !!fullscreenWindow && stillUp.every((w) => w.order < fullscreenWindow.order),
    fullscreenWindow ? `overlay order ${stillUp.map((w) => w.order).join('/')} vs ${fullscreenWindow.order}` : '',
  )

  const visibility = await (await (await attach(9502, (t) => t.url.includes('faces'))).init()).eval(
    `return document.visibilityState`,
  )
  check('the overlay was not parked on another Space', visibility === 'visible', visibility)

  await a.eval(`window.cozy.window.setFullscreen(false); return true;`)
  await sleep(1500)
} catch (err) {
  check('harness ran', false, String(err))
} finally {
  for (const p of procs) p.kill('SIGTERM')
  await sleep(800)
  for (const p of procs) p.kill('SIGKILL')
}

clearDeadline()
reapNow()
finish()
