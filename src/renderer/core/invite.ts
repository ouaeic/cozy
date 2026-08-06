/**
 * The invite code.
 *
 * This gets read out loud over a bad connection more often than it gets typed
 * from a screenshot, so the alphabet is chosen for the EAR first and the eye
 * second. Both matter, and they exclude different things.
 *
 * Sound-alike families, one survivor each:
 *   B C D E G P T V Z 3 all rhyme with "ee" ......... kept 3 and P
 *                                                     (once the rest are gone,
 *                                                      "three" and "pee" are
 *                                                      unmistakable)
 *   F L M N S X share the "eh-" opening ............. kept F, N, X
 *   A J K 8 collapse into "ay" ...................... kept K
 *   Q U W 2 collapse into "you" ..................... kept W and 2
 *   "six" and "ex" ................................... kept X, dropped 6
 *   "eight" and "aitch" .............................. kept H, dropped 8
 *
 * Look-alike pairs, one survivor each:
 *   0 O · 1 I L · 2 Z · 5 S · 6 G · 8 B
 *
 * What is left is 15 characters that are hard to confuse in either channel:
 *
 *   2 3 4 5 7 9   F H K N P R W X Y
 *
 * Seven of them is 27 bits. That is fewer bits per character than the 32-symbol
 * alphabet this replaced, which is exactly the trade: a code you can say once
 * and have understood beats a shorter one you have to spell twice. The seventh
 * character buys most of the entropy back, and the server's rate limit is what
 * actually makes guessing hopeless — see server/worker.ts.
 */

const ALPHABET = '2345 79FHKNPRWXY'.replace(/ /g, '')
const CODE_LENGTH = 7
export { CODE_LENGTH, ALPHABET }

/** For error copy. Spelled out rather than generated so it never drifts from
 *  the alphabet above — and asserted against it in test/codes.test.mjs. */
export const EXAMPLE_CODE = 'K4RWH7N'

export function generateCode(): string {
  // Rejection sampling, so every character is equally likely. The alphabet is
  // not a power of two, so taking a byte mod 15 would quietly favour the first
  // character — this does not.
  const out: string[] = []
  const limit = 256 - (256 % ALPHABET.length)
  while (out.length < CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(CODE_LENGTH * 2))) {
      if (byte >= limit) continue
      out.push(ALPHABET[byte % ALPHABET.length]!)
      if (out.length === CODE_LENGTH) break
    }
  }
  return out.join('')
}

/**
 * Whatever they typed, heard, or pasted, back to the canonical code — or null.
 *
 * The substitutions run in the direction people actually make the mistake: a
 * character we deliberately excluded is almost always a mishearing or misread
 * of the one we kept, so it is corrected rather than rejected. Characters with
 * no plausible target (0, 1, I, L, O, and the "ee" family) simply fail, and the
 * caller tells them so.
 */
export function normaliseCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/^\s*COZY:\/\/(?:J\/)?/, '')
    .replace(/[^0-9A-Z]/g, '') // spaces, dashes, stray punctuation
    // Misheard, not mistyped: "ess"->5, "zed"->2, "em"->N, "jay"->K,
    // "six"->X, "eight"->H.
    .replace(/S/g, '5')
    .replace(/Z/g, '2')
    .replace(/M/g, 'N')
    .replace(/J/g, 'K')
    .replace(/6/g, 'X')
    .replace(/8/g, 'H')

  if (cleaned.length !== CODE_LENGTH) return null
  if (![...cleaned].every((c) => ALPHABET.includes(c))) return null
  return cleaned
}

/** Shown exactly as it is stored. Six characters is short enough to read out
 *  in one breath, so grouping them only invites someone to type the separator
 *  back in. `normaliseCode` still forgives dashes and spaces on the way in. */
export const formatCode = (code: string) => code

export const inviteLink = (code: string) => `cozy://j/${code}`

/**
 * What actually goes in the message.
 *
 * A bare `cozy://` link is meaningless to anyone who hasn't installed Cozy yet —
 * it does nothing, with no explanation. Most first invites are sent to exactly
 * that person. So send a sentence, the code they can type, and somewhere to get
 * the app; the link still works for everyone who already has it.
 */
export const inviteMessage = (code: string, from: string): string =>
  [
    from ? `${from} wants to watch something with you on Cozy.` : 'Watch something together on Cozy?',
    ``,
    `Your code: ${code}`,
    `Open it directly: ${inviteLink(code)}`,
    ``,
    `Don't have Cozy yet? https://github.com/ouaeic/cozy/releases`,
  ].join('\n')

/** A stable, name-independent colour for someone's avatar. */
export function avatarSeed(): string {
  return crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)
}

/** A short, unguessable id for this connection. Matches the server's
 *  `^[A-Za-z0-9_-]{8,64}$` and is meaningless outside the room. */
export function peerId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
