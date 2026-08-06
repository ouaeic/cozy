// Sharing a screen or window, with its sound, all the way to the other end —
// the thing that justifies this being a desktop app rather than a web page.
//
//   node server/serve.mjs &
//   npm run build && npm run test:share

import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach, reporter, sleep, reapOnExit, reapNow, deadline, REPO, ELECTRON } from './cdp.mjs'

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

  const permissions = await a.eval(`return await window.cozy.getPermissions()`)
  check('screen recording is permitted', permissions.screen === 'granted', permissions.screen)

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

  // Retry briefly: enumeration can come back empty for a moment while another
  // app's windows are being torn down, which has nothing to do with us.
  const sources = await a.eval(`
    for (let i = 0; i < 15; i++) {
      const list = await window.cozy.getSources();
      if (list.length) return list.map(s => ({ id: s.id, kind: s.kind, thumb: s.thumbnail.length }));
      await new Promise(r => setTimeout(r, 400));
    }
    return [];`)
  check('desktopCapturer listed sources', sources.length > 0, `${sources.length} found`)
  check(
    'thumbnails rendered',
    sources.every((s) => s.thumb > 500),
    `smallest ${Math.min(...sources.map((s) => s.thumb))} bytes`,
  )

  // Straight through the main-process handler, so the loopback audio path is
  // exercised exactly as the app uses it.
  const target = sources.find((s) => s.kind === 'screen') ?? sources[0]
  const captured = await a.eval(`
    await window.cozy.armCapture(${JSON.stringify(target.id)}, true, true);
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      });
      const v = s.getVideoTracks()[0], au = s.getAudioTracks()[0];
      const out = {
        ok: true, video: !!v, audio: !!au,
        settings: au ? au.getSettings() : null,
        size: v ? v.getSettings().width + 'x' + v.getSettings().height : null,
      };
      s.getTracks().forEach(t => t.stop());
      return out;
    } catch (e) { return { ok: false, error: String(e) }; }`)

  check('captured a picture', captured.ok && captured.video, captured.error ?? captured.size)
  check('captured an audio track', captured.ok && captured.audio, captured.audio ? 'present' : 'MISSING')
  // Left to itself Chromium returns mono with AGC, noise suppression and echo
  // cancellation on — three algorithms that between them flatten a soundtrack.
  check(
    'film audio is stereo with speech processing off',
    !!captured.settings &&
      captured.settings.channelCount === 2 &&
      !captured.settings.autoGainControl &&
      !captured.settings.noiseSuppression &&
      !captured.settings.echoCancellation,
    JSON.stringify(captured.settings),
  )

  // And now the real path, through the picker, so the peer actually receives it.
  //
  // It MUST be a whole screen. The picker opens on the "A window" tab, and
  // capture.ts filters Cozy's own windows out of the list — so picking the
  // first card shared some unrelated third-party window, in which the floating
  // overlay could not possibly appear. The leak check below was therefore
  // passing by construction, and only stayed green because whoever ran it
  // happened to have another app open.
  const picked = await a.eval(`
    window.dispatchEvent(new CustomEvent('cozy:share'));
    for (let i = 0; i < 40; i++) {
      if (document.querySelector('.tab')) break;
      await new Promise(r => setTimeout(r, 200));
    }
    const screenTab = [...document.querySelectorAll('.tab')].find(t => /whole screen/i.test(t.textContent));
    if (!screenTab) return 'no screen tab';
    screenTab.click();
    // The window cards are still on screen the instant the tab is clicked, so
    // waiting for '.source' to merely EXIST re-picks a window. Wait for the
    // list to actually be screens.
    let cards = [];
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      cards = [...document.querySelectorAll('.source')];
      if (cards.length && /screen/i.test(cards[0].textContent)) break;
    }
    if (!cards.length) return 'no screens offered';
    if (!/screen/i.test(cards[0].textContent)) return 'still on windows: ' + cards[0].textContent.trim().slice(0, 40);
    cards[0].click();
    return 'whole screen: ' + cards[0].textContent.trim().slice(0, 40);`)
  check('the picker offered a whole screen to share', picked.startsWith('whole screen'), picked)

  const received = await b.eval(`
    for (let i = 0; i < 60; i++) {
      const v = document.querySelector('.stage > video');
      if (v && v.videoWidth > 0) return v.videoWidth + 'x' + v.videoHeight;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;`)
  check('the other end received the picture', !!received, received ?? 'never arrived')

  const sinks = await b.eval(`
    return [...document.querySelectorAll('audio')]
      .filter(e => e.srcObject)
      .map(e => Math.round(e.volume * 100) / 100);`)
  check(
    'the film is mixed under the voice',
    sinks.includes(1) && sinks.some((v) => v < 1),
    `sink volumes: ${sinks.join(', ')}`,
  )

  // ---- does the floating overlay leak into the shared screen? ----
  // Without content protection the sharer's own overlay appears in the stream,
  // so the viewer watches a small copy of themselves in the corner of the film.
  // Paint the overlay an unmistakable colour and look for it in the frames the
  // viewer is actually receiving.
  const facesTarget = await attach(9222, (t) => t.url.includes('faces')).catch(() => null)
  if (facesTarget) {
    const faces = await facesTarget.init()
    const box = await faces.eval(`
      document.body.style.background = 'rgb(255,0,255)';
      document.querySelectorAll('.tile').forEach(t => { t.style.visibility = 'hidden'; });
      return { x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight };`)
    const screenSize = await a.eval(`return { w: window.screen.width, h: window.screen.height };`)
    await sleep(2000)

    const leak = await b.eval(`
      const v = document.querySelector('.stage > video');
      if (!v || !v.videoWidth) return null;
      const sx = v.videoWidth / ${screenSize.w};
      const sy = v.videoHeight / ${screenSize.h};
      const c = document.createElement('canvas');
      c.width = 24; c.height = 24;
      const ctx = c.getContext('2d');
      ctx.drawImage(v,
        Math.round((${box.x} + ${box.w} / 2 - 12) * sx), Math.round((${box.y} + ${box.h} / 2 - 12) * sy),
        Math.round(24 * sx), Math.round(24 * sy), 0, 0, 24, 24);
      const d = ctx.getImageData(0, 0, 24, 24).data;
      let magenta = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 180 && d[i+1] < 90 && d[i+2] > 180) magenta++;
      }
      return { magenta, of: d.length / 4, size: v.videoWidth + 'x' + v.videoHeight };`)

    console.log('overlay-leak probe:', JSON.stringify(leak))
    check(
      'the floating overlay is kept OUT of the shared screen',
      !!leak && leak.magenta === 0,
      leak ? `${leak.magenta}/${leak.of} pixels of it visible in the stream` : 'could not sample',
    )
    faces.close()
  }

  const errors = [...a.errors, ...b.errors]
  check('no uncaught errors', errors.length === 0, errors.slice(0, 2).join(' | '))
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
