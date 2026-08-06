import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { shell } from 'electron'

const run = promisify(execFile)
const isWindows = process.platform === 'win32'

// Windows quietly sabotages this entire app by default.
//
// When it detects a "communication" stream — which is what opening a microphone
// for a call looks like — Windows attenuates *every other* application's audio
// by 80%. So the moment Cozy turns your mic on, the film you're sharing drops to
// a fifth of its volume. And because loopback capture takes the endpoint mix
// *after* that attenuation, the person watching hears the quiet version too.
// Nothing errors. It just sounds wrong at both ends.
//
// An application can only opt its OWN render streams out of ducking
// (IAudioSessionControl2::SetDuckingPreference). We can't opt out on behalf of
// VLC or a browser, which is where the film is actually playing. The only thing
// that fixes it for the whole system is the user-level preference behind
// Sound → Communications, so: detect it, explain it, and offer to set it.
//
// Values, matching the four radio buttons in that control panel:
//   0 mute everything · 1 reduce by 80% (the default) · 2 reduce by 50% · 3 do nothing

const KEY = 'HKCU\\Software\\Microsoft\\Multimedia\\Audio'
const VALUE = 'UserDuckingPreference'
const DO_NOTHING = 3

export interface DuckingState {
  /** Only meaningful on Windows. */
  applies: boolean
  /** True when Windows will turn other apps down while Cozy's mic is open. */
  willDuck: boolean
  preference: number | null
}

export async function readDucking(): Promise<DuckingState> {
  if (!isWindows) return { applies: false, willDuck: false, preference: null }
  try {
    const { stdout } = await run('reg', ['query', KEY, '/v', VALUE])
    const match = stdout.match(/UserDuckingPreference\s+REG_DWORD\s+0x([0-9a-f]+)/i)
    const preference = match ? parseInt(match[1]!, 16) : null
    return {
      applies: true,
      willDuck: preference !== DO_NOTHING,
      preference,
    }
  } catch {
    // A missing value means Windows is using its default, which is to duck.
    return { applies: true, willDuck: true, preference: null }
  }
}

/** Only ever called from an explicit button. Per-user, and reversible from the
 *  same control panel we link to. */
export async function stopDucking(): Promise<boolean> {
  if (!isWindows) return false
  try {
    await run('reg', ['add', KEY, '/v', VALUE, '/t', 'REG_DWORD', '/d', String(DO_NOTHING), '/f'])
    return true
  } catch {
    return false
  }
}

/** Opens the Sound control panel on its Communications tab. */
export async function openSoundSettings(): Promise<void> {
  if (!isWindows) return
  try {
    await run('control', ['mmsys.cpl,,1'])
  } catch {
    await shell.openPath('control.exe').catch(() => {})
  }
}
