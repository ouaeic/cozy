/**
 * Turning a `cozy://` link into an invite code.
 *
 * Lives here, free of Electron imports, so the test suite can exercise the REAL
 * function. It used to sit in main/index.ts where nothing could reach it, and a
 * hardcoded length in it once silently rejected every link ever sent — which
 * looks exactly like "clicking the link does nothing".
 */

/** cozy://j/K7M2P9XR4TBWQZ3H → K7M2P9XR4TBWQZ3H */
export function inviteFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'cozy:') return null
    const code = `${u.hostname}${u.pathname}`.replace(/^j\/?/, '').replace(/[^A-Za-z0-9]/g, '')
    // Deliberately loose: the renderer's normaliseCode is the authority on what
    // a valid code is, and it also corrects the classic misreadings. Main only
    // has to decide "is this plausibly a code" — a hardcoded length here once
    // rejected every link silently after the code format changed.
    return code.length >= 4 && code.length <= 16 ? code.toUpperCase() : null
  } catch {
    return null
  }
}

export function inviteFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    if (arg.startsWith('cozy://')) return inviteFromUrl(arg)
  }
  return null
}

