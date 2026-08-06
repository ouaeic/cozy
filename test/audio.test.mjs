// Does system-audio capture deliver actual samples, or a live track full of
// zeros? This is the failure that raises no error and simply makes the film
// arrive silent, so it is worth measuring rather than assuming.
//
// Must run against a PACKAGED build — see docs/LIMITATIONS.md. On macOS a dev
// Electron launched from a shell has your terminal as the responsible process,
// and the capture is silent for reasons that have nothing to do with the code.
//
//   npm run pack && npm run test:audio
//
// Plays a short sound, so turn your volume up enough to hear it.

import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach, reporter, sleep, reapOnExit, reapNow, deadline, REPO } from './cdp.mjs'

const { check, finish } = reporter()
const clearDeadline = deadline()
const PORT = 9666
const profile = join(tmpdir(), 'cozy-test', 'audio')

const APP = [
  join(REPO, 'release', 'mac-arm64', 'Cozy.app'),
  join(REPO, 'release', 'mac-universal', 'Cozy.app'),
  join(REPO, 'release', 'mac', 'Cozy.app'),
].find(existsSync)

if (process.platform !== 'darwin') {
  console.log('This check is macOS-only for now; skipping.')
  process.exit(0)
}
if (!APP) {
  console.log('No packaged app found. Run `npm run pack` first.')
  process.exit(1)
}

// `open` rather than spawn: it makes the app its own responsible process, which
// is what macOS consults for the audio-capture permission.
reapOnExit({ port: PORT })
execFileSync('/usr/bin/open', [
  '-n',
  '-a',
  APP,
  '--args',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
])

// Track the players so an interrupted run can never leave a sound looping on
// someone's machine.
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
    execFileSync('/usr/bin/pkill', ['-f', 'afplay.*Submarine'])
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

const noise = async (seconds) => {
  const until = Date.now() + seconds * 1000
  while (Date.now() < until) {
    await new Promise((resolve) => {
      const child = execFile('/usr/bin/afplay', ['-v', '2', '/System/Library/Sounds/Submarine.aiff'], () => {
        players.delete(child)
        resolve()
      })
      players.add(child)
      setTimeout(resolve, 1500)
    })
  }
}

// Raw AudioData frames — no WebAudio in the path, so a silent reading can't be
// blamed on the meter.
const METER = `
window.__peak = async (track, ms) => {
  let peak = 0, frames = 0, stop = false;
  const el = new Audio(); el.muted = true; el.srcObject = new MediaStream([track]); el.play().catch(()=>{});
  (async () => {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    while (!stop) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      frames++;
      const d = new Float32Array(value.numberOfFrames);
      try { value.copyTo(d, { planeIndex: 0, format: 'f32-planar' }); } catch { value.close(); continue; }
      for (const v of d) { const a = Math.abs(v); if (a > peak) peak = a; }
      value.close();
    }
  })();
  await new Promise(r => setTimeout(r, ms));
  stop = true; el.srcObject = null;
  return { peak: Number(peak.toFixed(5)), frames };
};
return true;`

try {
  const c = await (await attach(PORT)).init()
  await sleep(2500)

  const renderer = await c.eval(`
    return { url: location.href, bridge: typeof window.cozy, painted: (document.getElementById('root')||{}).childElementCount };`)
  // A packaged renderer served out of app.asar is where the blank-window class
  // of bug lives; an unpacked dev run never reproduces it.
  check(
    'the packaged renderer painted',
    renderer.bridge === 'object' && renderer.painted > 0,
    `${renderer.url} · ${renderer.painted} children`,
  )

  const permissions = await c.eval(`return await window.cozy.getPermissions()`)
  check('screen recording is granted', permissions.screen === 'granted', permissions.screen)

  await c.eval(METER)
  const source = await c.eval(`
    const l = await window.cozy.getSources();
    if (!l.length) return null;
    return (l.find(x => x.kind === 'screen') || l[0]).id;`)
  if (!source) throw new Error('no capture sources')

  const settings = await c.eval(`
    await window.cozy.armCapture(${JSON.stringify(source)}, true, true);
    window.__cap = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
    });
    const a = window.__cap.getAudioTracks()[0];
    return a ? a.getSettings() : null;`)
  check(
    'stereo, 48kHz, no speech processing',
    !!settings && settings.channelCount === 2 && settings.sampleRate === 48000 && !settings.autoGainControl,
    JSON.stringify(settings),
  )

  const measuring = c.eval(`
    const r = await window.__peak(window.__cap.getAudioTracks()[0], 6000);
    window.__cap.getTracks().forEach(t => t.stop());
    return r;`)
  await noise(5.5)
  const result = await measuring

  check(
    'real samples arrive (not digital silence)',
    result.peak > 0.001,
    `peak ${result.peak} over ${result.frames} frames`,
  )
  if (result.peak <= 0.001) {
    console.log(
      '\nEnable Cozy under System Settings → Privacy & Security → Screen & System Audio\n' +
        'Recording, then QUIT AND REOPEN the app — macOS only applies it on a fresh launch.',
    )
  }
} catch (err) {
  check('harness ran', false, String(err))
} finally {
  silence()
  try {
    // Match on the debug port: the profile path is long enough that pkill's
    // pattern matching misses it.
    execFileSync('/usr/bin/pkill', ['-f', `remote-debugging-port=${PORT}`])
  } catch {
    /* already gone */
  }
}

clearDeadline()
reapNow()
finish()
