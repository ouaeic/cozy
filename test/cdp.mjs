// A very small Chrome DevTools Protocol client, so the tests can drive real
// Electron windows: click things, read the DOM, measure audio. Enough to check
// the things that only break in a running app.

import { execFileSync } from 'node:child_process'
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')

export const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
export const ELECTRON = join(REPO, 'node_modules', '.bin', 'electron')
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- cleanup
//
// A test that throws, times out, or is interrupted used to leave a blank
// Electron window on screen for someone else to force-quit. Every launched
// process registers here and is killed on ANY exit path — normal, thrown,
// Ctrl-C, or the parent shell going away.

const launched = new Set()
let reaperInstalled = false

/** Register a child process (or a debug port for detached `open -n` launches). */
export function reapOnExit({ proc = null, port = null } = {}) {
  if (proc) launched.add({ proc })
  if (port) launched.add({ port })
  installReaper()
}

export function reapNow() {
  for (const entry of launched) {
    try {
      if (entry.proc) {
        entry.proc.kill('SIGTERM')
        setTimeout(() => {
          try {
            entry.proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, 400).unref?.()
      }
      if (entry.port) {
        // Detached launches (`open -n`) have no child handle; the debug port is
        // a precise, unique marker that cannot match the user's own copy.
        execFileSync('/usr/bin/pkill', ['-f', `remote-debugging-port=${entry.port}`])
      }
    } catch {
      /* already gone */
    }
  }
  launched.clear()
}

/**
 * A hard deadline. Without one, a suite that hangs waiting on a peer that never
 * arrives keeps its Electron windows on screen indefinitely — which is exactly
 * how blank windows end up needing a force-quit.
 */
export function deadline(ms = 240_000) {
  const timer = setTimeout(() => {
    console.error(`\nharness exceeded ${Math.round(ms / 1000)}s — cleaning up and giving up`)
    reapNow()
    process.exit(1)
  }, ms)
  timer.unref?.()
  installReaper()
  return () => clearTimeout(timer)
}

function installReaper() {
  if (reaperInstalled) return
  reaperInstalled = true
  const bye = (code) => {
    reapNow()
    if (code !== undefined) process.exit(code)
  }
  process.on('exit', () => reapNow())
  process.on('SIGINT', () => bye(130))
  process.on('SIGTERM', () => bye(143))
  process.on('SIGHUP', () => bye(129))
  process.on('uncaughtException', (err) => {
    console.error('harness error:', err?.message ?? err)
    bye(1)
  })
  process.on('unhandledRejection', (err) => {
    console.error('harness error:', err?.message ?? err)
    bye(1)
  })
}

export async function attach(port, match = (t) => t.type === 'page' && !t.url.includes('faces')) {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = list.find(match)
      if (target) return new Client(target.webSocketDebuggerUrl, target)
    } catch {
      /* not listening yet */
    }
    await sleep(500)
  }
  throw new Error(`no matching debug target on port ${port}`)
}

class Client {
  constructor(url, target) {
    this.target = target
    this.id = 0
    this.pending = new Map()
    this.logs = []
    this.ready = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
      this.ws.on('open', resolve)
      this.ws.on('error', reject)
      this.ws.on('message', (raw) => this.onMessage(JSON.parse(String(raw))))
    })
  }

  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')
      this.logs.push(`[${msg.params.type}] ${args}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      this.logs.push(`[error] ${d.text} ${d.exception?.description ?? ''}`)
    }
  }

  send(method, params = {}) {
    return this.ready.then(
      () =>
        new Promise((resolve, reject) => {
          const id = ++this.id
          this.pending.set(id, { resolve, reject })
          this.ws.send(JSON.stringify({ id, method, params }))
        }),
    )
  }

  async init() {
    await this.send('Runtime.enable')
    await this.send('Log.enable')
    return this
  }

  /** Body of an async function, evaluated in the page. Use `return`. */
  async eval(body) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    }
    return r.result.value
  }

  get errors() {
    return this.logs.filter((l) => l.startsWith('[error]'))
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

// ------------------------------------------------------------- assertions

export function reporter() {
  const results = []
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
    },
    /**
     * Something this machine genuinely cannot run — no Accessibility grant, no
     * Xcode. NOT a pass. Recording these as passes is how a suite reports full
     * marks for work it never did.
     */
    skip(name, why) {
      results.push({ name, skipped: true })
      console.log(`SKIP  ${name} — ${why}`)
    },
    finish() {
      const failed = results.filter((r) => !r.ok && !r.skipped).length
      const skipped = results.filter((r) => r.skipped).length
      const ran = results.length - skipped
      console.log(
        `\n${ran - failed}/${ran} checks passed${skipped ? ` (${skipped} skipped)` : ''}`,
      )
      process.exitCode = failed ? 1 : 0
    },
  }
}

// ---------------------------------------------------------------- windows

/** Every pid in the process trees rooted at `roots`, including the roots. */
export function descendantsOf(roots) {
  const rows = execFileSync('/bin/ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number))
  const children = new Map()
  for (const [pid, ppid] of rows) {
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const out = new Set()
  const walk = (pid) => {
    if (out.has(pid)) return
    out.add(pid)
    for (const kid of children.get(pid) ?? []) walk(kid)
  }
  roots.forEach(walk)
  return out
}

/**
 * The on-screen window list with CoreGraphics layers, scoped to the processes
 * THIS suite launched.
 *
 * Matching on owner name instead ("Cozy", "Electron") counts any other Electron
 * app the user has open and anything a previous suite is still tearing down.
 * That produced both false failures and — worse — false passes, in suites whose
 * whole point is asserting a window is or isn't floating. `node_modules/.bin/
 * electron` is a shim, so the pid we spawned is not the pid that owns the
 * window; the tree walk above bridges that.
 */
export function windowsOwnedBy(procs) {
  if (process.platform !== 'darwin') return null
  const probe = swiftHelper('windowlayers')
  try {
    if (!probe) return null
    const ours = descendantsOf(procs.map((p) => p.pid).filter(Boolean))
    return JSON.parse(execFileSync(probe, { encoding: 'utf8' }))
      .filter((w) => ours.has(w.pid))
      // The tray icon is a status-bar item owned by the same process. It is not
      // a window and must not be counted as one.
      .filter((w) => !(w.layer === 25 && /^Item-/.test(w.name ?? '')))
  } catch {
    return null
  }
}

// ------------------------------------------------------------- loading src

/**
 * Import a TypeScript module from src/ and get the REAL exports.
 *
 * Node 20 can't strip types, so tests used to re-implement the logic they were
 * meant to be checking — which means the bug they were written to catch would
 * have passed. esbuild is already here via vite; one transpile is cheaper than
 * a copy that silently drifts.
 */
export async function loadTs(relativePath) {
  const { buildSync } = await import('esbuild')
  const out = join(tmpdir(), `cozy-ts-${relativePath.replace(/[^a-z0-9]/gi, '-')}.mjs`)
  buildSync({
    entryPoints: [join(REPO, relativePath)],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  })
  // pathToFileURL, not the bare path. On Windows an absolute path starts with
  // a drive letter, and Node reads `C:` as a URL scheme:
  //   ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'c:'
  // The cache-buster keeps a rebuilt module from being served from the ESM
  // cache within one process.
  return import(`${pathToFileURL(out).href}?t=${statSync(out).mtimeMs}`)
}

/**
 * Build (or reuse) a compiled Swift probe, and REBUILD when the source is newer.
 *
 * Caching on existsSync alone bit us: a helper cached before its `read`
 * sub-command was added kept being reused, so the call threw, the suite decided
 * the cursor couldn't be moved, and took a branch that recorded a PASS. A stale
 * binary must never be able to look like a missing permission.
 */
export function swiftHelper(name) {
  const source = join(dirname(fileURLToPath(import.meta.url)), `${name}.swift`)
  const binary = join(tmpdir(), 'cozy-test', name)
  try {
    const fresh =
      existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs
    if (!fresh) {
      mkdirSync(dirname(binary), { recursive: true })
      execFileSync('/usr/bin/swiftc', ['-O', '-o', binary, source])
    }
    return binary
  } catch {
    return null
  }
}
