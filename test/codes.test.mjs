// The invite alphabet, the code round-trip, and the generated display names.
//
// Needs no Electron, but it does run the REAL functions — `invite.ts`,
// `names.ts` and `shared/deeplink.ts` are transpiled and imported (see
// `loadTs`). That matters: this file used to re-implement `normaliseCode`,
// `generateCode` and main's `inviteFromUrl` inline, which meant the one bug its
// own header claims it exists to catch — a hardcoded length in main silently
// rejecting every deep link — would have passed cleanly.
//
// The alphabet is chosen for the EAR as well as the eye, so the confusion
// tables below encode both: pairs that look alike, and letter names that sound
// alike over a bad connection. Either one getting back in is a real defect —
// it turns "read me the code" into "no, N as in November".
//
//   npm run test:codes

import { reporter, loadTs } from './cdp.mjs'

const { check, finish } = reporter()

const invite = await loadTs('src/renderer/core/invite.ts')
const names = await loadTs('src/renderer/core/names.ts')
const deeplink = await loadTs('src/shared/deeplink.ts')

const { ALPHABET, CODE_LENGTH: LENGTH, EXAMPLE_CODE: EXAMPLE, generateCode, normaliseCode } = invite

// ---- the alphabet ----

check('seven characters long', LENGTH === 7, `${LENGTH}`)
check(
  'no duplicate characters',
  new Set(ALPHABET).size === ALPHABET.length,
  `${ALPHABET.length} characters: ${ALPHABET}`,
)

// Pairs that are hard to tell apart ON SCREEN. At most one of each may appear.
const LOOK_ALIKE = [
  ['0', 'O'],
  ['1', 'I'],
  ['1', 'L'],
  ['I', 'L'],
  ['2', 'Z'],
  ['5', 'S'],
  ['6', 'G'],
  ['8', 'B'],
]
const lookClashes = LOOK_ALIKE.filter(([a, b]) => ALPHABET.includes(a) && ALPHABET.includes(b))
check(
  'no pair that looks alike on screen',
  lookClashes.length === 0,
  lookClashes.length ? lookClashes.map((p) => p.join('/')).join(', ') : 'all distinct',
)

// Groups whose spoken names collapse into each other on a bad line. This is the
// part the old Crockford alphabet got wrong: it kept both M and N.
const SOUND_ALIKE = [
  { name: 'the "ee" family', chars: 'BCDEGPTVZ3', allowed: 2 },
  { name: 'the "eh-" family', chars: 'FLMNSX', allowed: 3 },
  { name: '"ay" / "jay" / "kay" / "eight"', chars: 'AJK8', allowed: 1 },
  { name: '"you" / "cue" / "two"', chars: 'QUW2', allowed: 2 },
  { name: '"six" / "ex"', chars: '6X', allowed: 1 },
  { name: '"eight" / "aitch"', chars: '8H', allowed: 1 },
  { name: '"eye" / "why"', chars: 'IY', allowed: 1 },
]
const soundClashes = SOUND_ALIKE.map((g) => ({
  ...g,
  present: [...g.chars].filter((c) => ALPHABET.includes(c)),
})).filter((g) => g.present.length > g.allowed)
check(
  'no group of characters that sound alike when read out',
  soundClashes.length === 0,
  soundClashes.length
    ? soundClashes.map((g) => `${g.name}: ${g.present.join(', ')}`).join(' | ')
    : 'every spoken family within its survivor budget',
)

check(
  'the example code shown in error copy is itself valid',
  EXAMPLE.length === LENGTH && [...EXAMPLE].every((c) => ALPHABET.includes(c)),
  EXAMPLE,
)

// ---- generateCode really produces what it claims ----

const SAMPLES = 5000
const drawn = Array.from({ length: SAMPLES }, () => generateCode())
check(
  'every generated code is the right length and alphabet',
  drawn.every((c) => c.length === LENGTH && [...c].every((ch) => ALPHABET.includes(ch))),
  drawn.find((c) => c.length !== LENGTH || [...c].some((ch) => !ALPHABET.includes(ch))) ?? 'all valid',
)

// Rejection sampling should leave no character meaningfully favoured. With
// 35,000 draws the expected count per symbol is 2333; a modulo bias would show
// up as a systematic skew far outside this band.
const counts = new Map([...ALPHABET].map((c) => [c, 0]))
for (const code of drawn) for (const ch of code) counts.set(ch, counts.get(ch) + 1)
const expected = (SAMPLES * LENGTH) / ALPHABET.length
const worst = [...counts.entries()].reduce((a, b) =>
  Math.abs(b[1] - expected) > Math.abs(a[1] - expected) ? b : a,
)
check(
  'characters are drawn evenly, with no modulo bias',
  Math.abs(worst[1] - expected) < expected * 0.15,
  `worst symbol '${worst[0]}' seen ${worst[1]}x vs ${Math.round(expected)} expected`,
)

// ---- the round trip ----

let survived = 0
for (const code of drawn) {
  const dashed = `${code.slice(0, 3)}-${code.slice(3)}`
  if (
    normaliseCode(code) === code &&
    normaliseCode(dashed) === code &&
    normaliseCode(dashed.toLowerCase()) === code &&
    normaliseCode(`cozy://j/${code}`) === code &&
    normaliseCode(`  ${code.split('').join(' ')}  `) === code
  ) {
    survived++
  }
}
check(
  'every code survives spacing, case, dashes and a link',
  survived === SAMPLES,
  `${survived}/${SAMPLES} round-tripped`,
)

// Someone typing what they MISHEARD should still get in. These are the
// substitutions invite.ts makes, in the direction the mistake actually happens.
const HEARD = [
  ['S', '5', 'ess'],
  ['Z', '2', 'zed'],
  ['M', 'N', 'em'],
  ['J', 'K', 'jay'],
  ['6', 'X', 'six'],
  ['8', 'H', 'eight'],
]
for (const [typed, meant, spoken] of HEARD) {
  const code = meant.repeat(LENGTH)
  const withMistake = typed + meant.repeat(LENGTH - 1)
  check(
    `"${spoken}" typed as ${typed} is understood as ${meant}`,
    normaliseCode(withMistake) === code,
    `${withMistake} -> ${normaliseCode(withMistake)}`,
  )
}

check('the wrong length is rejected', normaliseCode(EXAMPLE.slice(0, -1)) === null)
check('nonsense is rejected', normaliseCode('!'.repeat(LENGTH)) === null)
// O has no twin left in the alphabet, so there is nothing to correct it to.
check('a character with no valid reading is rejected', normaliseCode('O'.repeat(LENGTH)) === null)

// ---- the strength claim ----
const bits = Math.log2(Math.pow(ALPHABET.length, LENGTH))
check(
  'at least 27 bits of entropy',
  bits >= 27,
  `${bits.toFixed(1)} bits (${Math.pow(ALPHABET.length, LENGTH).toLocaleString()} combinations)`,
)

// ---- the deep link path, against the function main actually calls ----
// A hardcoded length in main silently rejected every link once, which looks
// exactly like "clicking the link does nothing". Now that this imports the real
// inviteFromUrl, changing the code length without changing main fails here.
let links = 0
for (const code of drawn.slice(0, 1000)) {
  const viaMain = deeplink.inviteFromUrl(`cozy://j/${code}`)
  if (viaMain && normaliseCode(viaMain) === code) links++
}
check('cozy:// links reach the app as the right code', links === 1000, `${links}/1000`)
check('a non-cozy url is ignored', deeplink.inviteFromUrl('https://example.com/j/ABC123') === null)
check(
  'a code is found among real argv',
  deeplink.inviteFromArgv(['/path/to/Cozy', '--foo', `cozy://j/${EXAMPLE}`]) === EXAMPLE,
)

// ---- interop: the numbers a desktop app and a browser must agree on ----
//
// The web client at getcozy.app runs THESE modules, copied in. Two people in the
// same room — one in the app, one in a tab — only meet because both derive the
// same room id from the same seven characters, and seal with the same key.
//
// So these are golden vectors, not a re-derivation: they were captured from a
// working build and are asserted literally. Changing the PBKDF2 rounds, the
// salt, or either label would still "work" in isolation while silently
// partitioning every existing client from every new one, and nothing else in
// this suite would notice.
//
// If you change the derivation ON PURPOSE, these values change with it — and
// that is a breaking protocol change that needs both sides shipped together.
const crypto_ = await loadTs('src/renderer/core/crypto.ts')

const VECTORS = [
  ['K4RWH7N', '7a3b30becdc14d00d4be58c801af0329'],
  ['2222222', '3b93649c7ff3679b125f5875fc7dcd48'],
  ['YYYYYYY', '6f14214bb1b8723d140decc49afb6823'],
  ['7YR9RP4', '764ab1e525cdce71f8147543bd9f42d1'],
  ['F5H3NPW', '4a93153a8cbeb4c17dafcd5c89391a30'],
]

for (const [code, expected] of VECTORS) {
  const actual = await crypto_.deriveRoomId(code)
  check(`${code} still opens room ${expected.slice(0, 8)}…`, actual === expected, actual)
}

// A sealed payload has to survive the round trip, and a wrong code must not
// open it — the room id being right is only half of meeting someone.
const key = await crypto_.deriveKey('K4RWH7N')
const sealed = await crypto_.seal(key, { hello: 'interop' })
check(
  'a sealed message opens with the same code',
  JSON.stringify(await crypto_.unseal(key, sealed)) === JSON.stringify({ hello: 'interop' }),
)
check(
  'and does not open with a different one',
  (await crypto_.unseal(await crypto_.deriveKey('K4RWH7X'), sealed)) === null,
)

// ---- generated display names ----
// Ported from the getcozy web app so the two feel like one product. Nobody
// types a name any more, so these lists are the entire naming surface.
const sampleNames = Array.from({ length: 2000 }, () => names.generateName())

check(
  'every generated name is two capitalised words run together',
  sampleNames.every((n) => /^[A-Z][a-z]+[A-Z][a-z]+$/.test(n)),
  sampleNames.find((n) => !/^[A-Z][a-z]+[A-Z][a-z]+$/.test(n)) ?? 'all clean',
)
check(
  'and nothing separates them — no dash, space or underscore',
  sampleNames.every((n) => !/[-_\s]/.test(n)),
  sampleNames.find((n) => /[-_\s]/.test(n)) ?? 'all clean',
)
check(
  'the app recognises its own names',
  sampleNames.every((n) => names.isGeneratedName(n)),
  sampleNames.find((n) => !names.isGeneratedName(n)) ?? 'all recognised',
)
// The migration at startup replaces anything that isn't one of ours, so a false
// positive here would let a typed name or an OS username survive forever.
check(
  'and rejects names it did not hand out',
  ['Dan', 'alex.doe', '', 'Swift', 'Fox', 'SwiftFoxx', 'swiftfox'].every(
    (n) => !names.isGeneratedName(n),
  ),
  ['Dan', 'alex.doe', '', 'Swift', 'Fox', 'SwiftFoxx', 'swiftfox'].find((n) =>
    names.isGeneratedName(n),
  ) ?? 'all rejected',
)
check(
  'enough combinations that a room rarely doubles up',
  names.NAME_COMBINATIONS >= 4000,
  `${names.NAME_COMBINATIONS.toLocaleString()} combinations`,
)

finish()
