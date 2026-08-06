// Runs every suite, with a signalling server of its own.
//
// The suites drive real Electron windows and need something to introduce the
// instances to each other. Requiring a contributor to remember to start it in
// another terminal is how `npm test` ends up failing on a fresh clone for a
// reason that has nothing to do with their change.
//
//   npm test
//   npm test -- bar inline      # just those two

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const ALL = [
  'codes',
  'call',
  'share',
  'group',
  'bar',
  'fullscreen',
  'stereo',
  'inline',
  'rejoin',
  'hotstrip',
]

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const suites = wanted.length ? wanted : ALL

const unknown = suites.filter((s) => !ALL.includes(s))
if (unknown.length) {
  console.error(`Unknown suite(s): ${unknown.join(', ')}\nAvailable: ${ALL.join(', ')}`)
  process.exit(2)
}

// Its own port, so a server the developer already has running on the default
// one is left alone rather than fought with.
const PORT = process.env.COZY_TEST_PORT ?? '8799'
const SIGNAL = `ws://127.0.0.1:${PORT}/ws`

console.log(`signalling on ${SIGNAL}\n`)
const server = spawn(process.execPath, [join(ROOT, 'server', 'serve.mjs')], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, PORT },
})

let stopped = false
const stopServer = () => {
  if (stopped) return
  stopped = true
  try {
    server.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}
process.on('exit', stopServer)
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => (stopServer(), process.exit(130)))

await sleep(700)

const results = []
for (const suite of suites) {
  process.stdout.write(`\n──── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}\n`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, 'test', `${suite}.test.mjs`)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, COZY_SIGNAL: SIGNAL },
    })
    child.on('exit', (c) => resolve(c ?? 1))
  })
  results.push({ suite, ok: code === 0 })
  // Electron windows from one suite can still be tearing down while the next
  // starts, which shows up as flaky geometry rather than a real failure.
  await sleep(2500)
}

stopServer()

const failed = results.filter((r) => !r.ok)
console.log(`\n${'═'.repeat(64)}`)
for (const r of results) console.log(`${r.ok ? '  ok  ' : ' FAIL '} ${r.suite}`)
console.log(
  `\n${results.length - failed.length}/${results.length} suites passed` +
    (failed.length ? ` — failed: ${failed.map((f) => f.suite).join(', ')}` : ''),
)
process.exit(failed.length ? 1 : 0)
