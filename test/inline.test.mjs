// Wayland gives an app no way to place a window, raise it, or keep it on top,
// so the two overlays are drawn INSIDE the Stage there instead of getting OS
// windows of their own.
//
// That fallback is the one path no machine here can reach — this is a Mac. So
// COZY_INLINE_OVERLAYS forces it on, and the same switch is a real escape hatch
// for X11 users with no compositor, where a transparent window paints black.
//
// What makes this worth testing: "renders inside the window" fails silently in
// exactly the way the Faces window once did — a tile with a healthy intrinsic
// video size inside an element that laid out at zero height. So every check
// here reads laid-out geometry, never just presence.
//
//   node server/serve.mjs &
//   npm run build && npm run test:inline

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  attach, reporter, sleep, reapOnExit, reapNow, deadline, windowsOwnedBy, REPO, ELECTRON,
} from './cdp.mjs'

// The display names below must be ones the generator could produce:
// startup replaces anything else, because names are assigned, not typed.
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const PROFILES = join(tmpdir(), 'cozy-test')
const { check, finish } = reporter()
const clearDeadline = deadline()
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
    { cwd: REPO, stdio: 'ignore', env: { ...process.env, COZY_INLINE_OVERLAYS: '1' } },
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

try {
  launch(9224, 'inline-a')
  launch(9335, 'inline-b')
  let a = await (await attach(9224)).init()
  let b = await (await attach(9335)).init()

  check(
    'the switch reaches the renderer',
    await a.eval(`return window.cozy.inlineOverlays === true`),
    true,
  )

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
  a = await (await attach(9224)).init()
  b = await (await attach(9335)).init()
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

  // ---- no child windows at all ----
  const barTarget = await attach(9224, (t) => t.url.includes('bar.html')).catch(() => null)
  check('no separate control-panel window was opened', barTarget === null)
  const facesTarget = await attach(9224, (t) => t.url.includes('faces.html')).catch(() => null)
  check('no separate faces window was opened', facesTarget === null)

  // The window server is the authority — a window that was created and then
  // hidden is still a window, and still lands in someone's alt-tab.
  const layers = windowsOwnedBy(procs)
  if (layers) {
    // Skipping silently would make this suite pass while testing nothing —
    // which is the exact failure mode it exists to catch.
    check('the window-server probe found our instances', layers.length > 0, `${layers.length} windows`)
    const floating = layers.filter((w) => w.layer > 0)
    check(
      'our instances own one window each, not three',
      layers.length === procs.length,
      `${layers.length} windows for ${procs.length} instances: ${layers
        .map((w) => `${w.name || '?'}@${w.layer}`)
        .join(', ')}`,
    )
    // The point of inline mode: nothing is asking to float, because nothing on
    // Wayland could have honoured the request anyway.
    check(
      'and nothing is sitting at a floating window level',
      floating.length === 0,
      floating.length ? floating.map((w) => `${w.name || '?'}@${w.layer}`).join(', ') : 'all at layer 0',
    )
  }

  // ---- and both overlays are really laid out inside the Stage ----
  const bar = await a.eval(`
    for (let i = 0; i < 30; i++) {
      const el = document.querySelector('.inlay--bar .floatbar');
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 100) return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top),
                                    buttons: document.querySelectorAll('.inlay--bar .floatbar button').length };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return null;`)
  check(
    'the controls are laid out inside the main window',
    !!bar && bar.w > 100 && bar.buttons >= 6,
    bar ? `${bar.w}x${bar.h} at top ${bar.top}, ${bar.buttons} buttons` : 'never laid out',
  )
  check('and sit against the top edge', !!bar && bar.top <= 2, bar ? `top ${bar.top}` : 'n/a')

  const faces = await a.eval(`
    for (let i = 0; i < 40; i++) {
      const host = document.querySelector('.inlay--faces');
      const tile = host && host.querySelector('.tile video');
      if (host && tile) {
        const h = host.getBoundingClientRect(), t = tile.getBoundingClientRect();
        if (t.height > 20) return {
          hostW: Math.round(h.width), hostH: Math.round(h.height),
          tileW: Math.round(t.width), tileH: Math.round(t.height),
          right: Math.round(innerWidth - h.right), top: Math.round(h.top),
          intrinsic: tile.videoWidth + 'x' + tile.videoHeight,
        };
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return null;`)
  check(
    'the faces are laid out inside the main window',
    !!faces && faces.hostH > 40 && faces.tileH > 20,
    faces
      ? `host ${faces.hostW}x${faces.hostH}, tile ${faces.tileW}x${faces.tileH} (video ${faces.intrinsic})`
      : 'never laid out',
  )
  check(
    'in the top-right corner',
    !!faces && faces.right >= 0 && faces.right < 40 && faces.top < 40,
    faces ? `${faces.right}px from the right, ${faces.top}px from the top` : 'n/a',
  )

  // The host is sized from facesPixelSize. If that ever drifts from what the
  // grid actually needs, the tiles overflow or swim in dead space — and since
  // this host has no OS window to be clipped by, nothing else would catch it.
  check(
    'the host is sized to its contents',
    !!faces && Math.abs(faces.hostW - (faces.tileW + 24)) <= 2,
    faces ? `host ${faces.hostW} vs tile ${faces.tileW} + 24 padding` : 'n/a',
  )

  // Inside a window, the faces' drag region would drag the Stage instead.
  const drag = await a.eval(
    `return getComputedStyle(document.querySelector('.inlay--faces .faces')).webkitAppRegion`,
  )
  check('the faces do not drag the window they live in', drag !== 'drag', drag)
  const errors = [...a.errors, ...b.errors]
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | '))
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
