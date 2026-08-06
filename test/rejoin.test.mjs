// What happens after somebody says goodnight.
//
// Two bugs lived here, and both survived because every other suite stops at
// "they connected":
//
//   1. When the last peer left, the Stage kept rendering "Reconnecting…"
//      indefinitely. Nobody was coming back to that room, so it was a lie that
//      looked exactly like a slow network.
//
//   2. On the FIRST evening the two of them could not find each other again.
//      The one who stayed was sitting in the room derived from the INVITE CODE;
//      the one who returned pressed "Reconnect" and arrived in the room derived
//      from the PAIR SECRET. Different rooms. The code was no longer on screen
//      and had never been saved, so there was no way back at all. From the
//      second evening on both sides used the pair room, which is why this hid.
//
//   node server/serve.mjs &
//   npm run build && npm run test:rejoin

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach, reporter, sleep, reapOnExit, reapNow, deadline, REPO, ELECTRON } from './cdp.mjs'

// The display names below must be ones the generator could produce:
// startup replaces anything else, because names are assigned, not typed.
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const PROFILES = join(tmpdir(), 'cozy-test')
const { check, finish } = reporter()
const clearDeadline = deadline(420_000)
const t0 = Date.now()
const step = (m) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
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
    { cwd: REPO, stdio: 'ignore' },
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

/** Wait for a heading to appear anywhere in the app, and report what it is. */
const HEADING = (seconds) => `
  for (let i = 0; i < ${seconds * 4}; i++) {
    const h = document.querySelector('.waiting h1, .hearth h1');
    if (h) return h.textContent.trim();
    await new Promise(r => setTimeout(r, 250));
  }
  return document.querySelector('.stage') ? 'STILL ON THE STAGE' : 'nothing';`

try {
  launch(9226, 'rejoin-a')
  launch(9337, 'rejoin-b')
  let a = await (await attach(9226)).init()
  let b = await (await attach(9337)).init()

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
  a = await (await attach(9226)).init()
  b = await (await attach(9337)).init()
  await sleep(1200)

  // ---- first evening: meet with a code ----
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
  step('met')
  check('they met using the code', (await a.eval(REACHED_CALL)) && (await b.eval(REACHED_CALL)))
  await sleep(3500)

  check(
    'and paired',
    (await a.eval(`return (await window.cozy.readSettings()).partner?.name ?? null`)) ===
      'CosmicOtter',
  )

  step('paired; attaching to B control panel')
  // ---- B says goodnight, using the actual control ----
  // Leave lives in the control-bar WINDOW, not the Stage. Rather than attach a
  // second debugger to a hidden window, reach it the way the app itself does:
  // it's same-origin and was opened by name, so window.open('', name) hands
  // back the live reference without navigating it.
  const clicked = await b.eval(`
    const bar = window.open('', 'cozy-bar');
    if (!bar || bar.closed) return 'no bar window';
    const leave = [...bar.document.querySelectorAll('button')].find(
      (x) => (x.getAttribute('aria-label') || '') === 'Leave the call');
    if (!leave) return 'no leave button';
    leave.click();
    return 'clicked';`)
  check('the leave button in the control panel works', clicked === 'clicked', clicked)
  step('left')
  await sleep(1500)

  // A must stop pretending. This is the check that used to sit on
  // "Reconnecting…" until the process was killed.
  const heading = await a.eval(HEADING(20))
  step(`A heading: ${heading}`)
  check(
    'the one who stayed is told, not left staring at "Reconnecting…"',
    heading !== 'STILL ON THE STAGE' && heading !== 'nothing',
    heading,
  )

  // ---- the same evening: B presses Reconnect ----
  const reconnectLabel = await b.eval(`
    for (let i = 0; i < 40; i++) {
      const btn = document.querySelector('.reconnect');
      if (btn) return btn.textContent.trim();
      await new Promise(r => setTimeout(r, 250));
    }
    return null;`)
  check('the returning one is offered a one-button reconnect', !!reconnectLabel, reconnectLabel ?? 'no button')

  step('clicking reconnect')
  await b.eval(`document.querySelector('.reconnect')?.click(); return true;`)

  const backTogether = (await a.eval(REACHED_CALL)) && (await b.eval(REACHED_CALL))
  check(
    'and they find each other again on the SAME evening',
    backTogether,
    backTogether ? 'both on the stage' : 'they ended up in different rooms',
  )

  // Not a hollow pass. "Both on the stage" only proves a scene changed; it
  // would still pass if no media crossed. The tiles live in the faces overlay
  // window, so look there, and require a frame with real dimensions.
  const tile = await a.eval(`
    for (let i = 0; i < 60; i++) {
      const faces = window.open('', 'cozy-faces');
      const v = faces && !faces.closed ? faces.document.querySelector('.tile video') : null;
      if (v && v.videoWidth > 0) {
        const r = v.getBoundingClientRect();
        return { w: v.videoWidth, h: v.videoHeight, laidOut: Math.round(r.width) + 'x' + Math.round(r.height) };
      }
      await new Promise(r => setTimeout(r, 250));
    }
    return null;`)
  check(
    'with live video flowing again, not just a scene change',
    !!tile && tile.w > 0 && tile.h > 0,
    tile ? `${tile.w}x${tile.h}, laid out ${tile.laidOut}` : 'no frames arrived',
  )

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
