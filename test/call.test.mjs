// Two real Electron instances, one local signalling server, an actual WebRTC
// call between them. Fake camera and microphone so it's deterministic.
//
//   node server/serve.mjs &
//   npm run build && npm run test:call
//
// This is the suite that has caught the real bugs: a collapsed overlay window,
// a Perfect Negotiation race, an asar-only blank screen. Assert on laid-out
// geometry, not just on objects existing — a zero-height video element still
// reports a perfectly healthy videoWidth.

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { attach, reporter, sleep, reapOnExit, reapNow, deadline, REPO, ELECTRON } from './cdp.mjs'

// Read from the source rather than hardcoding: the length has changed once
// already, and a stale literal here fails in a way that looks like a real bug.
const CODE_LENGTH = Number(
  readFileSync(`${REPO}/src/renderer/core/invite.ts`, 'utf8').match(/const CODE_LENGTH = (\d+)/)[1],
)

// The display names below must be ones the generator could produce:
// startup replaces anything else, because names are assigned, not typed.
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const PROFILES = join(tmpdir(), 'cozy-test')
const { check, finish } = reporter()
const clearDeadline = deadline()
const procs = []
/** Every launch is registered so it dies with the harness, however it ends. */
const track = (proc) => {
  procs.push(proc)
  reapOnExit({ proc })
  return proc
}

const launch = (port, profile) =>
  track(
    spawn(
      ELECTRON,
      [
        '.',
        `--user-data-dir=${join(PROFILES, profile)}`,
        `--remote-debugging-port=${port}`,
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
      { cwd: REPO, stdio: 'ignore' },
    ),
  )

const REACHED_CALL = `
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('.stage')) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;`

try {
  launch(9222, 'a')
  launch(9333, 'b')

  let a = await (await attach(9222)).init()
  let b = await (await attach(9333)).init()
  check('both renderers attached', true)

  for (const [client, name] of [
    [a, 'SwiftFox'],
    [b, 'CosmicOtter'],
  ]) {
    await client
      .eval(
        `await window.cozy.writeSettings({
           signalUrl: ${JSON.stringify(SIGNAL)},
           name: ${JSON.stringify(name)},
           partner: null, selfView: false, faceSize: 'M'
         });
         location.reload();`,
      )
      .catch(() => {}) // reload kills the reply
  }
  await sleep(2500)
  a = await (await attach(9222)).init()
  b = await (await attach(9333)).init()
  await sleep(1500)

  check(
    'settings applied',
    (await a.eval(`return (await window.cozy.readSettings()).signalUrl`)) === SIGNAL,
  )

  check(
    'camera preview is live',
    (await a.eval(`
      // Re-query each time: the element may not be mounted on the first tick,
      // and holding a stale null here made this check flaky.
      for (let i = 0; i < 40; i++) {
        const v = document.querySelector('.preview video');
        if (v && v.videoWidth > 0) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;`)) === true,
  )

  await a.eval(`document.querySelector('.btn--primary').click(); return true;`)
  const code = await a.eval(`
    for (let i = 0; i < 30; i++) {
      const el = document.querySelector('.code');
      if (el) return el.textContent.trim().split('\\n')[0].trim();
      await new Promise(r => setTimeout(r, 200));
    }
    return null;`)
  check(
    'an invite code appears',
    !!code && code.replace(/-/g, '').length === CODE_LENGTH,
    code ?? 'none',
  )

  await b.eval(`
    const input = document.querySelector('.hearth__join input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(code ?? '')});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    document.querySelector('.hearth__join .btn')?.click();
    return true;`)

  check('A reached the call', (await a.eval(REACHED_CALL)) === true)
  check('B reached the call', (await b.eval(REACHED_CALL)) === true)
  await sleep(3000)

  // The floating overlay is a separate OS window sharing one renderer process
  // with the Stage. That relationship is the whole architecture, so prove it.
  const facesTarget = await attach(9222, (t) => t.url.includes('faces')).catch(() => null)
  check('the floating Faces window opened', !!facesTarget, facesTarget?.target.url ?? '')

  if (facesTarget) {
    const faces = await facesTarget.init()
    const decoding = await faces.eval(`
      for (let i = 0; i < 30; i++) {
        const v = document.querySelector('.tile video');
        if (v && v.videoWidth > 0) return v.videoWidth + 'x' + v.videoHeight;
        await new Promise(r => setTimeout(r, 300));
      }
      return null;`)
    check('the remote camera is decoding in it', !!decoding, decoding ?? 'no frames')

    // 480x270 is the 'M' rung of the receiver-driven ladder: proof the far end
    // is encoding to the size we're drawing, not to a wasteful default.
    check('the quality ladder was honoured', decoding === '480x270', decoding ?? '?')

    // videoWidth is INTRINSIC and stays correct even when the tile has collapsed
    // to nothing. Measure the laid-out box or a zero-height overlay sails through.
    const box = await faces.eval(`
      const t = document.querySelector('.tile');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), win: innerWidth + 'x' + innerHeight };`)
    check(
      'the tile has a real size on screen',
      !!box && box.w > 100 && box.h > 60,
      box ? `${box.w}x${box.h} in a ${box.win} window` : 'no tile',
    )
    faces.close()
  }

  // After one successful connection there should never be a code again.
  check(
    'A remembered B',
    (await a.eval(`return (await window.cozy.readSettings()).partner?.name ?? null`)) === 'CosmicOtter',
  )
  check(
    'B remembered A',
    (await b.eval(`return (await window.cozy.readSettings()).partner?.name ?? null`)) === 'SwiftFox',
  )

  // The window has to stay movable during a call. Dropping the title bar took
  // the only drag region with it, and the control bar can't stand in — it is a
  // separate movable:false window at the top of the screen, not this one.
  const drag = await a.eval(`
    const strip = document.querySelector('.dragstrip');
    if (!strip) return 'no drag region during a call';
    const r = strip.getBoundingClientRect();
    return getComputedStyle(strip).webkitAppRegion === 'drag' && r.width > 100 && r.height > 8
      ? 'draggable ' + Math.round(r.width) + 'x' + Math.round(r.height)
      : 'present but not draggable';`)
  check('the window can still be dragged during a call', drag.startsWith('draggable'), drag)

  check('no uncaught errors in A', a.errors.length === 0, a.errors.slice(0, 2).join(' | '))
  check('no uncaught errors in B', b.errors.length === 0, b.errors.slice(0, 2).join(' | '))
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
