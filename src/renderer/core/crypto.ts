// What the signaling server is allowed to know: nothing.
//
// It sees a room id, which is a hash of a secret it never receives, and message
// payloads, which are AES-GCM sealed with a key derived from that same secret.
// So it can't read your SDP (which carries your IP addresses), can't join your
// room, and can't sit in the middle of the handshake.
//
// This costs about thirty lines. For a hosted box that strangers route their
// private evenings through, it's the difference between "trust me" and
// "there's nothing here to trust".
//
// Both derivations are STRETCHED, and that is the load-bearing part. An invite
// code is only 27 bits, and a plain SHA-256 of it enumerates in about four
// core-minutes — so a server that kept room ids and sealed payloads could
// recover the code afterwards and read the lot. A million PBKDF2 rounds turns
// that into hours of GPU time per room instead of seconds, while costing the
// two people involved a fraction of a second on a screen where they are
// already waiting for each other.
//
// Hours, not centuries. Being precise about that matters, because the honest
// defence is the other half: a code is used once, and the room exists only
// while somebody is sitting in it. Stretching buys enough time for that to be
// the true statement.

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Deliberately expensive. See the note above — this is what a 27-bit code
 *  needs to survive being hashed into something a server gets to keep. */
const PBKDF2_ROUNDS = 1_000_000

/** Both derivations run through the same stretch, then split by `info`. */
async function stretch(secret: string, label: string, bits: number): Promise<ArrayBuffer> {
  const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, [
    'deriveBits',
  ])
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      // A per-code salt is impossible: both ends must arrive at the same room
      // id knowing only the code. A constant salt means one rainbow table could
      // in principle be built for the whole app — but at 600k iterations that
      // table costs GPU-months per entry, which is the point.
      salt: enc.encode(`cozy-v2|${label}`),
      iterations: PBKDF2_ROUNDS,
    },
    material,
    bits,
  )
}

/**
 * The room id the server sees. Derived, one-way, and useless on its own.
 *
 * Cached because it is the slow part and `join` can be called more than once
 * per evening (a rejoin, a third person arriving) with the same secret.
 */
const roomIds = new Map<string, string>()

export async function deriveRoomId(secret: string): Promise<string> {
  const hit = roomIds.get(secret)
  if (hit) return hit
  const bits = await stretch(secret, 'room', 128)
  const id = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('')
  roomIds.set(secret, id)
  return id
}

/** The AES-GCM key both ends derive from the invite code. */
const keys = new Map<string, CryptoKey>()

export async function deriveKey(secret: string): Promise<CryptoKey> {
  const hit = keys.get(secret)
  if (hit) return hit
  const bits = await stretch(secret, 'signal', 256)
  const key = await crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
  keys.set(secret, key)
  return key
}

export async function seal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(payload)),
  )
  const out = new Uint8Array(iv.length + body.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(body), iv.length)
  return toBase64(out)
}

/** Returns null rather than throwing — a payload we can't open is a payload
 *  that wasn't meant for us, and that's not an error worth crashing on. */
export async function unseal<T>(key: CryptoKey, sealed: string): Promise<T | null> {
  try {
    const bytes = fromBase64(sealed)
    if (bytes.length <= 12) return null
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    )
    return JSON.parse(dec.decode(plain)) as T
  } catch {
    return null
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * The secret two people remember each other by, once they've actually met.
 *
 * Both ends contribute 16 random bytes and both combine them identically —
 * sorted, so neither order nor who-spoke-first matters — giving a 256-bit
 * secret that neither side chose alone. This is what replaces the four-word
 * invite for every future evening: the invite is short so it can be said out
 * loud, this is long because it lasts.
 */
export async function derivePairSecret(ourSeed: string, theirSeed: string): Promise<string> {
  const [a, b] = [ourSeed, theirSeed].sort()
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`cozy-pair-v1|${a}|${b}`))
  return toBase64(new Uint8Array(digest))
}

/** 16 random bytes, base64 — our half of the above. */
export function freshSeed(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)))
}
