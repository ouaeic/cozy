/**
 * Nobody should have to name themselves before they can watch a film.
 *
 * The word lists come from the getcozy web app so the two feel like the same
 * product. Two differences, both deliberate:
 *
 *  - The web app re-rolls on every page load, so the same person shows up as
 *    SwiftFox one evening and CosmicOtter the next. Here the name is generated
 *    once and persisted, because this is an app you open every week with the
 *    same person. It stays editable.
 *  - Words are drawn from the platform CSPRNG rather than Math.random(). Not
 *    for secrecy — a display name is public — but this codebase already has
 *    crypto.getRandomValues to hand for invite codes, and one source of
 *    randomness is one fewer thing to reason about.
 *
 * 68 x 68 = 4624 combinations. Collisions inside one room of eight are rare
 * enough (~0.6%) not to be worth code, and harmless when they happen: peers are
 * keyed by id, never by name.
 */

// The web app's lists shipped `Crimson` and `Finch` twice each, which only
// skewed those two words' odds. Deduplicated here.
const ADJECTIVES = [
  'Swift', 'Brave', 'Calm', 'Wild', 'Bright',
  'Cozy', 'Warm', 'Cool', 'Bold', 'Soft',
  'Quick', 'Sly', 'Keen', 'Rare', 'Fond',
  'Glad', 'Pure', 'True', 'Free', 'Wise',
  'Noble', 'Vivid', 'Lucky', 'Misty', 'Sunny',
  'Frosty', 'Gentle', 'Sleepy', 'Cosmic', 'Mystic',
  'Silent', 'Golden', 'Silver', 'Crimson', 'Azure',
  'Mellow', 'Peppy', 'Zesty', 'Jolly', 'Merry',
  'Daring', 'Snappy', 'Witty', 'Clever', 'Nimble',
  'Lively', 'Dreamy', 'Fluffy', 'Spicy', 'Rustic',
  'Velvet', 'Amber', 'Coral', 'Jade', 'Violet',
  'Scarlet', 'Turbo', 'Stellar', 'Lunar',
  'Solar', 'Polar', 'Tropical', 'Arctic', 'Jungle',
  'Stormy', 'Cloudy', 'Breezy', 'Foggy', 'Dusty',
] as const

const NOUNS = [
  'Fox', 'Owl', 'Bear', 'Wolf', 'Deer',
  'Hawk', 'Lynx', 'Moth', 'Frog', 'Seal',
  'Crow', 'Hare', 'Pike', 'Orca', 'Koala',
  'Panda', 'Otter', 'Robin', 'Finch', 'Raven',
  'Whale', 'Tiger', 'Crane', 'Dove', 'Moose',
  'Sloth', 'Lemur', 'Gecko', 'Cobra', 'Bison',
  'Falcon', 'Badger', 'Jackal', 'Toucan', 'Parrot',
  'Salmon', 'Turtle', 'Walrus', 'Wombat', 'Coyote',
  'Ferret', 'Marmot', 'Osprey', 'Pelican', 'Condor',
  'Jaguar', 'Panther', 'Gibbon', 'Rhino', 'Hippo',
  'Puffin', 'Newt', 'Viper', 'Egret', 'Heron',
  'Stork', 'Sparrow', 'Weasel', 'Marten',
  'Ermine', 'Shrimp', 'Mantis', 'Beetle', 'Hornet',
  'Cicada', 'Marlin', 'Barracuda', 'Macaw', 'Quokka',
] as const

/** Uniform over `length`, without the modulo bias of `% length`. */
function pick<T>(list: readonly T[]): T {
  const limit = Math.floor(0x100000000 / list.length) * list.length
  const buf = new Uint32Array(1)
  let n = 0
  do {
    crypto.getRandomValues(buf)
    n = buf[0]!
  } while (n >= limit)
  return list[n % list.length]!
}

/** `SwiftFox`, `CosmicQuokka`. Run together and capitalised, as on the web. */
export function generateName(): string {
  return `${pick(ADJECTIVES)}${pick(NOUNS)}`
}

export const NAME_COMBINATIONS = ADJECTIVES.length * NOUNS.length

/**
 * Was this name handed out by us?
 *
 * Used once at startup to migrate anyone carrying a name from before names were
 * generated — an OS username, or something they typed when the field was still
 * editable. Names are not editable any more, so leaving one in place would mean
 * a person stuck with a name the app would never assign and they cannot change.
 */
export function isGeneratedName(name: string): boolean {
  return ADJECTIVES.some(
    (adj) => name.startsWith(adj) && (NOUNS as readonly string[]).includes(name.slice(adj.length)),
  )
}
