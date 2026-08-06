// The Linux/X11 reveal, forced on so it can be tested from a Mac.
//
// macOS and Windows reveal the panel by polling where the pointer is. Linux
// can't: Electron's getCursorScreenPoint caches the last position seen by our
// OWN windows and never refreshes it (electron#42519), so the poll reads a
// stale point forever. The panel used to be pinned permanently visible there,
// which is not the behaviour this app is supposed to have on any platform.
//
// Instead the window stays alive, collapsed to a two-pixel sliver at the top of
// the screen and only as wide as the panel — so the rest of the desktop's top
// edge stays clickable. The pointer entering that sliver is a real event the
// window receives, with nothing to poll and nothing to go stale.
//
// COZY_HOT_STRIP=1 forces the mode, so the mechanism is exercised on every
// platform rather than only the one machine that needs it.
//
//   node server/serve.mjs &
//   npm run build && npm run test:hotstrip

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attach,
  reporter,
  sleep,
  reapOnExit,
  reapNow,
  deadline,
  windowsOwnedBy,
  REPO,
  ELECTRON,
} from './cdp.mjs'

// The display names below must be ones the generator could produce:
// startup replaces anything else, because names are assigned, not typed.
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const PROFILES = join(tmpdir(), 'cozy-test')
const { check, finish } = reporter()
const clearDeadline = deadline(300_000)
const procs = []

const launch = (port, profile) => {
  const proc = spawn(
    ELECTRON,
    [
      '.',
      `--user-data-dir=${join(PROFILES, profile)}`,
      `--remote-debugging-port=${port}`,
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
    { cwd: REPO, stdio: 'ignore', env: { ...process.env, COZY_HOT_STRIP: '1' } },
  )
  procs.push(proc)
  reapOnExit({ proc })
  return proc
}

const REACHED_CALL = `
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.stage')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;`

/** The panel window's height, from the window server — the authority. */
const panelHeight = () => {
  const all = windowsOwnedBy(procs) ?? []
  const panels = all.filter((w) => w.layer === 1002)
  return panels.length ? panels[0].h : null
}

try {
  launch(9228, 'hot-a')
  launch(9339, 'hot-b')
  let a = await (await attach(9228)).init()
  let b = await (await attach(9339)).init()

  for (const [client, name] of [
    [a, 'SwiftFox'],
    [b, 'CosmicOtter'],
  ]) {
    await client
      .eval(
        `await window.cozy.writeSettings({ signalUrl: ${JSON.stringify(SIGNAL)}, name: ${JSON.stringify(name)}, partner: null });
         location.reload();`,
      )
      .catch(() => {})
  }
  await sleep(2500)
  a = await (await attach(9228)).init()
  b = await (await attach(9339)).init()
  await sleep(1200)

  await a.eval(`document.querySelector('.btn--primary').click(); return true;`)
  const code = await a.eval(`
    for (let i = 0; i < 30; i++) {
      const el = document.querySelector('.code');
      if (el) return el.textContent.trim().split('\\n')[0].trim();
      await new Promise(r => setTimeout(r, 200));
    }
    return null;`)
  await b.eval(`
    const input = document.querySelector('.hearth__join input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(code ?? '')});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('.hearth__join .btn')?.click();
    return true;`)
  check('connected', (await a.eval(REACHED_CALL)) && (await b.eval(REACHED_CALL)))
  await sleep(3000)

  // It is still a real, separate, always-on-top window — not something drawn
  // inside the app. That is the whole point of this mode over the Wayland one.
  check(
    'the panel is still its own window',
    (await attach(9228, (t) => t.url.includes('bar.html')).then(() => true, () => false)) === true,
  )
  check(
    'no overlay was drawn inside the app window instead',
    (await a.eval(`return !document.querySelector('.inlay--bar') && !document.querySelector('.inlay--faces')`)) === true,
  )

  const collapsed = panelHeight()
  check(
    'and it waits collapsed to a sliver, not pinned open',
    collapsed !== null && collapsed <= 4,
    collapsed === null ? 'no panel window found' : `${collapsed}px tall`,
  )
  check(
    'the floating faces are above everything, as on every other platform',
    ((windowsOwnedBy(procs) ?? []).filter((w) => w.layer === 1001).length) >= 1,
    `${(windowsOwnedBy(procs) ?? []).filter((w) => w.layer === 1001).length} at layer 1001`,
  )

  // ---- the pointer reaches the sliver ----
  await a.eval(`window.__seen = []; window.cozy.bar.onVisible(v => window.__seen.push(v)); return true;`)
  const panel = await (await attach(9228, (t) => t.url.includes('bar.html'))).init()
  await panel.eval(`document.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false })); return true;`)
  await sleep(700)

  const opened = panelHeight()
  check(
    'entering it opens the panel',
    opened !== null && opened > 30,
    opened === null ? 'panel vanished' : `${opened}px tall`,
  )
  check('and the app is told it is visible', (await a.eval(`return window.__seen.includes(true)`)) === true)

  // ---- and leaving puts it away again ----
  await panel.eval(`document.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false })); return true;`)
  await sleep(900)
  const reclosed = panelHeight()
  check(
    'leaving collapses it back to the sliver',
    reclosed !== null && reclosed <= 4,
    reclosed === null ? 'panel vanished' : `${reclosed}px tall`,
  )
  check(
    'and the app is told it is hidden',
    (await a.eval(`return window.__seen[window.__seen.length - 1] === false`)) === true,
    `events: ${await a.eval('return window.__seen.join(",")')}`,
  )

  const errors = [...a.errors, ...b.errors]
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  panel.close()
  a.close()
  b.close()
} catch (err) {
  check('harness ran', false, String(err))
} finally {
  for (const p of procs) p.kill('SIGTERM')
  await sleep(600)
  for (const p of procs) p.kill('SIGKILL')
}

clearDeadline()
reapNow()
finish()
