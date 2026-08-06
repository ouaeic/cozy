// More than two people. The mesh, the overlay grid, the self-view, and the
// uplink budget that has to shrink as the room fills.
//
//   npm run server:dev &
//   npm run build && npm run test:group

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

const PEOPLE = [
  { name: 'SwiftFox', port: 9401, profile: 'g1' },
  { name: 'CosmicOtter', port: 9402, profile: 'g2' },
  { name: 'JollyPuffin', port: 9403, profile: 'g3' },
  { name: 'MistyHeron', port: 9404, profile: 'g4' },
]

const launch = ({ port, profile }) =>
  procs.push(
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

const REACHED = `for (let i=0;i<80;i++){ if (document.querySelector('.stage')) return true; await new Promise(r=>setTimeout(r,500)); } return false;`

try {
  for (const person of PEOPLE) launch(person)

  let clients = []
  for (const person of PEOPLE) clients.push(await (await attach(person.port)).init())

  for (const [i, client] of clients.entries()) {
    await client
      .eval(
        `await window.cozy.writeSettings({
           signalUrl: ${JSON.stringify(SIGNAL)},
           name: ${JSON.stringify(PEOPLE[i].name)},
           partner: null, selfView: true, faceSize: 'M'
         });
         location.reload();`,
      )
      .catch(() => {})
  }
  await sleep(3000)
  clients = []
  for (const person of PEOPLE) clients.push(await (await attach(person.port)).init())
  await sleep(1500)

  const [ada, ...rest] = clients

  await ada.eval(`document.querySelector('.btn--primary').click(); return true;`)
  const code = await ada.eval(`
    for (let i=0;i<40;i++){ const el=document.querySelector('.code'); if (el) return el.textContent.trim().split('\\n')[0].trim(); await new Promise(r=>setTimeout(r,200)); }
    return null;`)

  // Stagger the joins: simultaneous arrivals are exactly when glare happens.
  for (const client of rest) {
    await client.eval(`
      const input = document.querySelector('.hearth__join input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(code ?? '')});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 120));
      document.querySelector('.hearth__join .btn')?.click();
      return true;`)
    await sleep(1200)
  }

  for (const [i, client] of clients.entries()) {
    check(`${PEOPLE[i].name} reached the call`, (await client.eval(REACHED)) === true)
  }
  await sleep(6000)

  // Everyone should see the other three, plus themselves.
  const faces = await attach(9401, (t) => t.url.includes('faces')).catch(() => null)
  check('the overlay opened', !!faces)
  if (faces) {
    const f = await faces.init()
    const layout = await f.eval(`
      for (let i=0;i<40;i++){
        const tiles = document.querySelectorAll('.tile');
        if (tiles.length >= 4) break;
        await new Promise(r=>setTimeout(r,500));
      }
      const tiles = [...document.querySelectorAll('.tile')];
      const decoding = tiles.filter(t => { const v = t.querySelector('video'); return v && v.videoWidth > 0; }).length;
      const names = tiles.map(t => (t.querySelector('.tile__name span')||{}).textContent).filter(Boolean);
      const cs = getComputedStyle(document.querySelector('.faces'));
      const boxes = tiles.map(t => { const r = t.getBoundingClientRect(); return Math.round(r.width)+'x'+Math.round(r.height); });
      return {
        tiles: tiles.length, decoding, names,
        columns: cs.gridTemplateColumns.split(' ').length,
        window: innerWidth + 'x' + innerHeight,
        boxes,
        shadow: getComputedStyle(tiles[0] || document.body).boxShadow,
      };`)
    console.log('overlay:', JSON.stringify(layout))

    check('four tiles: three others plus yourself', layout.tiles === 4, `${layout.tiles} tiles`)
    check('your own camera is one of them', layout.names.includes('You'), layout.names.join(', '))
    check('every tile is decoding video', layout.decoding === 4, `${layout.decoding}/4`)
    check(
      'it lays out as a grid, not a tall stack',
      layout.columns === 2,
      `${layout.columns} columns, window ${layout.window}`,
    )
    check(
      'tiles have a real size',
      layout.boxes.every((b) => {
        const [w, h] = b.split('x').map(Number)
        return w > 100 && h > 60
      }),
      layout.boxes.join(' '),
    )
    check('no drop shadow on the overlay', layout.shadow === 'none', layout.shadow)
    f.close()
  }

  // The sharer uploads one copy per viewer, so the ceiling has to come down.
  await ada.eval(`
    window.dispatchEvent(new CustomEvent('cozy:share'));
    for (let i=0;i<40;i++){ if (document.querySelector('.source')) break; await new Promise(r=>setTimeout(r,200)); }
    const tabs = [...document.querySelectorAll('.tab')];
    if (tabs[1]) tabs[1].click();
    await new Promise(r=>setTimeout(r,400));
    const cards = [...document.querySelectorAll('.source')];
    if (cards.length) cards[0].click();
    return cards.length;`)

  const gotPicture = await Promise.all(
    rest.map((c) =>
      c.eval(`
        for (let i=0;i<60;i++){
          const v = document.querySelector('.stage > video');
          if (v && v.videoWidth > 0) return true;
          await new Promise(r=>setTimeout(r,500));
        }
        return false;`),
    ),
  )
  check(
    'all three viewers received the shared picture',
    gotPicture.every(Boolean),
    `${gotPicture.filter(Boolean).length}/3`,
  )

  // Nobody should have been offered a "reconnect with…" in a group.
  const remembered = await Promise.all(
    clients.map((c) => c.eval(`return (await window.cozy.readSettings()).partner?.name ?? null`)),
  )
  check(
    'no partner was remembered from a group call',
    remembered.every((r) => r === null),
    remembered.join(', '),
  )

  const errors = clients.flatMap((c) => c.errors)
  check('no uncaught errors anywhere', errors.length === 0, errors.slice(0, 3).join(' | '))
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
