import { app } from 'electron'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { userInfo } from 'node:os'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types.js'

// A settings file, not a database. Whole-file read on boot, whole-file write on
// change — it's a few hundred bytes and changes a handful of times per session.

const file = () => join(app.getPath('userData'), 'cozy.json')

let cache: Settings | null = null

export function read(): Settings {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<Settings>
    cache = { ...DEFAULT_SETTINGS, ...raw }
  } catch {
    // Missing or corrupt — start fresh rather than blocking the app.
    // Name deliberately left blank: the renderer assigns a generated one.
    // This used to seed from the OS username, which meant the first thing Cozy
    // did was tell a stranger your real name.
    cache = { ...DEFAULT_SETTINGS }
  }
  return cache
}

export function write(patch: Partial<Settings>): Settings {
  const next = { ...read(), ...patch }
  cache = next
  try {
    const path = file()
    mkdirSync(dirname(path), { recursive: true })
    // Write-then-rename so a crash mid-write can't leave a half file behind.
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    console.error('[store] could not persist settings', err)
  }
  return next
}

