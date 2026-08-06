// Does the film's sound reach the other person in stereo?
//
// This is the question the whole app stands on, and it fails silently: Opus
// negotiates a mono speech profile by default, and a collapsed soundtrack still
// plays, still shows healthy stats, and still looks completely fine in the UI.
//
// So: synthesise a WAV whose LEFT channel has a tone and whose RIGHT is silent,
// play it, share it, and measure the channels at BOTH ends. Measuring the
// capture as well as the reception is what separates "our pipeline collapsed
// it" from "this Mac is set to play stereo as mono".
//
//   npm run pack && npm run server:dev &   # in another shell
//   npm run test:stereo
//
// Plays a tone for a few seconds. The sharer's own output is muted by
// loopbackWithMute, so it should be quiet.

import { spawn, execFile, execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach, reporter, sleep, reapOnExit, reapNow, deadline, REPO } from './cdp.mjs'

const { check, finish } = reporter()
const clearDeadline = deadline()
const SIGNAL = process.env.COZY_SIGNAL ?? 'ws://127.0.0.1:8787/ws'
const WORK = join(tmpdir(), 'cozy-test')
const TONE = join(WORK, 'stereo-probe.wav')

const APP = [
  join(REPO, 'release', 'mac-arm64', 'Cozy.app'),
  join(REPO, 'release', 'mac-universal', 'Cozy.app'),
  join(REPO, 'release', 'mac', 'Cozy.app'),
].find(existsSync)

if (process.platform !== 'darwin') {
  console.log('macOS-only for now; skipping.')
  process.exit(0)
}
if (!APP) {
  console.log('No packaged app found. Run `npm run pack` first.')
  console.log('(A dev build cannot capture system audio on macOS — see docs/LIMITATIONS.md.)')
  process.exit(1)
}

// ---------------------------------------------------------------- the tone

mkdirSync(WORK, { recursive: true })
writeStereoWav(TONE, { seconds: 8, rate: 48000, leftHz: 440, rightHz: 0 })

function writeStereoWav(path, { seconds, rate, leftHz, rightHz }) {
  const frames = seconds * rate
  const data = Buffer.alloc(frames * 4) // 2ch × 16-bit
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const l = leftHz ? Math.sin(2 * Math.PI * leftHz * t) * 0.7 : 0
    const r = rightHz ? Math.sin(2 * Math.PI * rightHz * t) * 0.7 : 0
    data.writeInt16LE(Math.round(l * 32767), i * 4)
    data.writeInt16LE(Math.round(r * 32767), i * 4 + 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(2, 22) // stereo
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 4, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([header, data]))
}

// Track the players so an interrupted run can never leave a tone looping on
// someone's machine. Ctrl-C, a thrown assertion and a normal finish all land in
// silence().
const players = new Set()
function silence() {
  for (const child of players) {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
  players.clear()
  try {
    execFileSync('/usr/bin/pkill', ['-f', 'afplay.*stereo-probe'])
  } catch {
    /* nothing playing */
  }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    silence()
    process.exit(130)
  })
}
process.on('exit', silence)

const play = (seconds) =>
  new Promise((resolve) => {
    const child = execFile('/usr/bin/afplay', ['-v', '2', TONE], () => {
      players.delete(child)
      resolve()
    })
    players.add(child)
    setTimeout(resolve, seconds * 1000)
  })

// -------------------------------------------------------------- the meter

// Per-channel RMS from raw AudioData. No WebAudio, so a mono reading can't be
// an artefact of the measurement.
const METER = `
window.__channels = async (track, ms) => {
  let channels = 0, frames = 0;
  const sums = [0, 0], counts = [0, 0];
  let stop = false;
  (async () => {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (!stop) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      frames++;
      channels = Math.max(channels, value.numberOfChannels);
      for (let ch = 0; ch < Math.min(2, value.numberOfChannels); ch++) {
        const d = new Float32Array(value.numberOfFrames);
        try { value.copyTo(d, { planeIndex: ch, format: 'f32-planar' }); } catch { continue; }
        let s = 0;
        for (const v of d) s += v * v;
        sums[ch] += s; counts[ch] += d.length;
      }
      value.close();
    }
  })();
  await new Promise(r => setTimeout(r, ms));
  stop = true;
  const rms = [0, 1].map(ch => counts[ch] ? Math.sqrt(sums[ch] / counts[ch]) : 0);
  return { channels, frames, left: Number(rms[0].toFixed(5)), right: Number(rms[1].toFixed(5)) };
};
return true;`

// ----------------------------------------------------------------- the run

const launched = []
function launch(profile, port) {
  // Detached launches have no child handle, so the debug port is what the
  // reaper matches on — precise, and it can never match the user's own copy.
  reapOnExit({ port })
  execFileSync('/usr/bin/open', [
    '-n',
    '-a',
    APP,
    '--args',
    `--user-data-dir=${join(WORK, profile)}`,
    `--remote-debugging-port=${port}`,
  ])
  launched.push(port)
}

try {
  launch('stereo-a', 9770)
  launch('stereo-b', 9771)
  let a = await (await attach(9770)).init()
  let b = await (await attach(9771)).init()
  await sleep(2000)

  for (const [client, name] of [
    [a, 'Sharer'],
    [b, 'Viewer'],
  ]) {
    await client
      .eval(
        `await window.cozy.writeSettings({ signalUrl: ${JSON.stringify(SIGNAL)}, name: ${JSON.stringify(name)}, partner: null });
         location.reload();`,
      )
      .catch(() => {})
  }
  await sleep(3000)
  a = await (await attach(9770)).init()
  b = await (await attach(9771)).init()
  await sleep(1500)
  await a.eval(METER)
  await b.eval(METER)

  // Connect the two.
  await a.eval(`document.querySelector('.btn--primary').click(); return true;`)
  const code = await a.eval(`
    for (let i = 0; i < 40; i++) {
      const el = document.querySelector('.code');
      if (el) return el.textContent.trim().split('\\n')[0].trim();
      await new Promise(r => setTimeout(r, 200));
    }
    return null;`)
  await b.eval(`
    const input = document.querySelector('.hearth__join input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(code ?? '')});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    document.querySelector('.hearth__join .btn')?.click();
    return true;`)
  const reached = `for (let i=0;i<60;i++){ if (document.querySelector('.stage')) return true; await new Promise(r=>setTimeout(r,500)); } return false;`
  check('the two instances connected', (await a.eval(reached)) && (await b.eval(reached)))
  await sleep(3000)

  // Keep the viewer silent, or its playback would feed back into the sharer's
  // own loopback capture and contaminate the measurement.
  await b.eval(`document.querySelectorAll('audio').forEach(e => { e.muted = true; }); return true;`)

  // Share the screen, with sound.
  const started = await a.eval(`
    window.dispatchEvent(new CustomEvent('cozy:share'));
    // Wait for the CARDS, not just the sheet. The sheet appears immediately with
    // a loading state while thumbnails are fetched, so breaking out on the sheet
    // races the list and intermittently clicks nothing.
    const waitForCards = async () => {
      for (let i = 0; i < 60; i++) {
        if (document.querySelector('.source')) return true;
        await new Promise(r => setTimeout(r, 200));
      }
      return false;
    };
    await waitForCards();
    const heading = (document.querySelector('.sheet h2') || {}).textContent || null;
    const tabs = [...document.querySelectorAll('.tab')];
    if (tabs[1]) tabs[1].click();               // whole screen: always producing
    await waitForCards();                        // the tab switch re-renders the list
    const cards = [...document.querySelectorAll('.source')];
    if (cards.length) cards[0].click();
    await new Promise(r => setTimeout(r, 3000));
    // The picker closing is the signal that the share started. The "Sharing"
    // badge used to be the tell, but the controls moved out of this window and
    // into their own floating panel, so it isn't in this document any more.
    return {
      sheet: heading,
      sources: cards.length,
      sharing: !document.querySelector('.sheet') && !!document.querySelector('.stage'),
    };`)
  console.log('share attempt:', JSON.stringify(started))
  check(
    'the share actually started',
    started.sources > 0 && started.sharing,
    started.sheet ? `sheet said: "${started.sheet}"` : `${started.sources} sources`,
  )

  await sleep(1500)
  await b.eval(`document.querySelectorAll('audio').forEach(e => { e.muted = true; }); return true;`)

  // The film's sink is the one turned down under the voices; a voice sink sits
  // at 1.0. Picking "the first audio element with a stream" would grab someone's
  // microphone, which is mono and would look exactly like a stereo failure.
  const FILM_SINK = `[...document.querySelectorAll('audio')]
      .find(e => e.srcObject && e.volume < 1 && e.srcObject.getAudioTracks().length)`

  const sent = a.eval(`
    const el = ${FILM_SINK};
    if (!el) return null;
    return await window.__channels(el.srcObject.getAudioTracks()[0], 7000);`)
  const heard = b.eval(`
    const el = ${FILM_SINK};
    if (!el) return null;
    return await window.__channels(el.srcObject.getAudioTracks()[0], 7000);`)

  await play(7)
  const captured = await sent
  const received = await heard

  console.log('captured at the sharer :', JSON.stringify(captured))
  console.log('received at the viewer :', JSON.stringify(received))

  check('the sharer captured audio', !!captured && captured.left > 0.005, JSON.stringify(captured))
  check(
    'the capture itself is stereo (left loud, right quiet)',
    !!captured && captured.right < captured.left * 0.25,
    captured ? `L ${captured.left} vs R ${captured.right}` : 'nothing captured',
  )

  check('the viewer received audio', !!received && received.left > 0.002, JSON.stringify(received))
  check(
    'stereo survived the trip (right stayed quiet)',
    !!received && received.left > 0.002 && received.right < received.left * 0.35,
    received
      ? `L ${received.left} vs R ${received.right} — ratio ${(received.right / (received.left || 1)).toFixed(3)}`
      : 'nothing received',
  )

  if (captured && received && captured.right >= captured.left * 0.25) {
    console.log(
      '\nThe capture arrived mono, so this is macOS rather than Cozy: check\n' +
        'System Settings → Accessibility → Audio → "Play stereo audio as mono".',
    )
  }
} catch (err) {
  check('harness ran', false, String(err))
} finally {
  silence()
  for (const port of launched) {
    try {
      execFileSync('/usr/bin/pkill', ['-f', `remote-debugging-port=${port}`])
    } catch {
      /* already gone */
    }
  }
}

clearDeadline()
reapNow()
finish()
void spawn
