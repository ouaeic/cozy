// The control panel lives on the screen, not in the app window: its own
// always-on-top window that hides at the top edge and comes down when the
// pointer goes looking for it — from whatever app you happen to be in.
//
// This is exactly the kind of feature that can look fine and be useless: a
// panel that opens behind the film, or one that never reveals because the
// cursor watcher isn't running, both look like "nothing happened".
//
//   node server/serve.mjs &
//   npm run build && npm run test:bar

import { spawn, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import {
  attach,
  reporter,
  sleep,
  reapOnExit,
  reapNow,
  deadline,
  windowsOwnedBy,
  swiftHelper,
  REPO,
  ELECTRON,
} from './cdp.mjs'

// The display names below must be ones the generator could produce:
// startup replaces anything else, because names are assigned, not typed.
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const PROFILES = join(tmpdir(), 'cozy-test')
const { check, skip, finish } = reporter()
const clearDeadline = deadline()
const procs = []
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
  launch(9222, 'bar-a')
  launch(9333, 'bar-b')
  let a = await (await attach(9222)).init()
  let b = await (await attach(9333)).init()

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
  a = await (await attach(9222)).init()
  b = await (await attach(9333)).init()
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
  await sleep(2500)

  // ---- the panel is its own window, not a strip inside the app ----
  const barTarget = await attach(9222, (t) => t.url.includes('bar.html')).catch(() => null)
  check('the control panel opened as its own window', !!barTarget, barTarget?.target.url ?? 'missing')
  if (!barTarget) throw new Error('no control panel')

  const bar = await barTarget.init()

  // It must NOT be inside the Stage any more — that was the whole point.
  const insideStage = await a.eval(`return !!document.querySelector('.floatbar')`)
  check('and not inside the main window', insideStage === false)

  const laidOut = await bar.eval(`
    for (let i = 0; i < 30; i++) {
      const el = document.querySelector('.floatbar');
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 100) return { w: Math.round(r.width), h: Math.round(r.height),
                                     buttons: document.querySelectorAll('.floatbar button').length };
      }
      await new Promise(r => setTimeout(r, 200));
    }
    return null;`)
  check(
    'the panel has laid out with its controls',
    !!laidOut && laidOut.w > 100 && laidOut.buttons >= 6,
    laidOut ? `${laidOut.w}x${laidOut.h}, ${laidOut.buttons} buttons` : 'never laid out',
  )

  // The window should have been sized to fit that content, not left at its
  // default — otherwise the pill is clipped or swimming in dead space.
  const fit = await bar.eval(`return { win: innerWidth, content: Math.ceil(document.querySelector('.floatbar').getBoundingClientRect().width) }`)
  check(
    'the window was resized to fit the panel',
    Math.abs(fit.win - fit.content) < 40,
    `window ${fit.win}px vs content ${fit.content}px`,
  )

  // ---- it starts HIDDEN, and floats above everything once revealed ----
  // The window server is the only honest source here. A panel that is on screen
  // at launch and never retracts looks identical in the DOM to one that is
  // working perfectly — the DOM has no idea whether its window is visible.
  const layers = windowsOwnedBy(procs)
  if (layers) {
    // Faces live at 1001, the panel at 1002. With the pointer nowhere near the
    // top edge there should be no 1002 window on screen at all.
    const panels = layers.filter((w) => w.layer === 1002)
    check(
      'the panel is hidden until it is wanted',
      panels.length === 0,
      panels.length ? `${panels.length} panel window(s) already on screen` : 'nothing at layer 1002',
    )

    const faces = layers.filter((w) => w.layer === 1001)
    check(
      'the faces are floating above everything',
      faces.length >= 1,
      `${faces.length} at layer 1001`,
    )

    // Now pin it open and confirm it comes up ABOVE the faces.
    await a.eval(`window.cozy.bar.pin(true); return true;`)
    await sleep(600)
    const shownPanels = (windowsOwnedBy(procs) ?? []).filter((w) => w.layer === 1002)
    check(
      'and outranks them when revealed',
      shownPanels.length >= 1,
      `${shownPanels.length} panel window(s) at layer 1002`,
    )
    await a.eval(`window.cozy.bar.pin(false); return true;`)
    await sleep(900)
  } else {
    check('window-layer checks ran', true, 'skipped off macOS')
  }

  // ---- the cursor watcher actually drives it ----
  // Park the pointer in the middle of the screen, then at the very top, and
  // watch the panel's own visibility events.
  // The panel window has no preload — it's rendered into by the Stage — so the
  // visibility events arrive in the Stage, which is where we listen.
  await a.eval(`
    window.__seen = [];
    window.cozy.bar.onVisible((v) => window.__seen.push(v));
    return true;`)

  const screenSize = await a.eval(`return { w: screen.width, h: screen.height }`)
  // Rebuilt when movecursor.swift changes — a stale binary used to make the
  // `read` sub-command throw, which looked exactly like a missing permission.
  const mover = swiftHelper('movecursor')
  const move = (x, y) => {
    try {
      if (!mover) return false
      execFileSync(mover, [String(x), String(y)])
      return true
    } catch {
      return false
    }
  }

  /** Where the pointer actually is, so we can tell a blocked move from a bug. */
  const cursorAt = () => {
    try {
      if (!mover) return null
      const [x, y] = execFileSync(mover, ['read'], { encoding: 'utf8' }).trim().split(' ').map(Number)
      return { x, y }
    } catch {
      return null
    }
  }

  // Probe with a deliberately odd point. Aiming at the centre of the screen and
  // asking "did it land near the centre?" is a FALSE POSITIVE whenever the
  // pointer was already sitting there — which is how this suite came to run the
  // cursor checks on a machine where macOS was silently dropping every
  // synthetic move, and then reported them as product failures.
  const target = { x: 37, y: 401 }
  move(target.x, target.y)
  await sleep(250)
  const landed = cursorAt()
  // Posting a synthetic move needs Accessibility permission for whatever is
  // running the tests. Without it macOS drops the event and reports success, so
  // check rather than assume — a silent skip is better than a false failure.
  const canMove =
    !!landed && Math.abs(landed.x - target.x) < 8 && Math.abs(landed.y - target.y) < 8

  if (canMove) {
    await sleep(900) // let it retract
    move(Math.round(screenSize.w / 2), 1) // top edge
    await sleep(700)
    const revealed = await a.eval(`return !!window.__seen.includes(true)`)
    check('it reveals when the pointer reaches the top of the screen', revealed === true)

    move(Math.round(screenSize.w / 2), Math.round(screenSize.h / 2))
    await sleep(1400)
    const retracted = await a.eval(`return window.__seen[window.__seen.length - 1] === false`)
    check('and retracts when the pointer leaves', retracted === true)
  } else {
    skip(
      'cursor-driven reveal',
      !mover
        ? 'could not build movecursor.swift (needs Xcode command line tools)'
        : `macOS is dropping synthetic pointer moves — grant Accessibility to whatever runs the tests${
            landed ? ` (asked for ${target.x},${target.y}; pointer stayed at ${landed.x},${landed.y})` : ''
          }`,
    )
  }

  // ---- show/hide, without needing permission to move the pointer ----
  // Pinning is what holds the panel open while a popover is up, and it runs
  // through exactly the same reveal and retract path the cursor watcher uses.
  // So this covers the mechanism even where the synthetic-cursor route can't.
  await a.eval(`window.__seen = []; window.cozy.bar.onVisible(v => window.__seen.push(v)); return true;`)
  await a.eval(`window.cozy.bar.pin(true); return true;`)
  await sleep(500)
  const pinnedOpen = await a.eval(`return window.__seen.includes(true)`)
  check('pinning reveals the panel', pinnedOpen === true, `events: ${await a.eval('return window.__seen.join(",")')}`)

  await a.eval(`window.cozy.bar.pin(false); return true;`)
  await sleep(1400)
  const retracted = await a.eval(`return window.__seen[window.__seen.length - 1] === false`)
  check(
    'and it retracts once nothing is holding it',
    retracted === true,
    `events: ${await a.eval('return window.__seen.join(",")')}`,
  )

  // ---- appearance, last, because resizing the window perturbs the reveal
  // state machine that everything above is asserting on ----
  // Centred at ANY width, not just when the window happens to hug the pill.
  // `.floatbar` is inline-flex, and auto margins never centre an inline-level
  // box — so this was left-aligned and only looked right because the window is
  // resized to fit. Force a mismatch and check.
  await a.eval(`window.cozy.bar.setSize(900, 90); return true`)
  await sleep(800)
  const centred = await bar.eval(`
    const r = document.querySelector('.floatbar').getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), win: innerWidth };`)
  check(
    'the panel stays centred even when its window is wider than it is',
    Math.abs(centred.left - centred.right) <= 2 && centred.win > 500,
    `${centred.left}px left vs ${centred.right}px right in a ${centred.win}px window`,
  )

  // Square at the top, so it reads as hanging off the screen edge rather than
  // parked near it. macOS rounds frameless windows unless told not to, and the
  // CSS shorthand ordering once put the top border straight back.
  const corners = await bar.eval(`
    const cs = getComputedStyle(document.querySelector('.floatbar'));
    return { tl: cs.borderTopLeftRadius, tr: cs.borderTopRightRadius,
             bl: cs.borderBottomLeftRadius, topBorder: cs.borderTopWidth };`)
  check(
    'its top corners are square and joined to the screen edge',
    corners.tl === '0px' && corners.tr === '0px' && corners.topBorder === '0px' && corners.bl !== '0px',
    `top ${corners.tl}/${corners.tr}, bottom ${corners.bl}, top border ${corners.topBorder}`,
  )

  // Put it back before the checks that depend on the real size.
  await a.eval(`window.cozy.bar.setSize(367, 60); return true`)
  await sleep(500)


  const errors = [...a.errors, ...b.errors, ...bar.errors]
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | '))
  bar.close()
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
