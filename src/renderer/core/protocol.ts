import type { FaceSize } from '../../shared/types.js'

// Everything two Cozy clients say to each other. The first three go through the
// signaling server (sealed) until a DataChannel exists; after that everything
// goes peer-to-peer and the server never hears from us again.

export interface StreamMap {
  /** Stream ids, so the receiver can tell a face from a film. */
  webcam: string | null
  screen: string | null
}

export type Handshake =
  | { k: 'offer'; sdp: string; streams: StreamMap }
  | { k: 'answer'; sdp: string; streams: StreamMap }
  | { k: 'ice'; c: RTCIceCandidateInit }

export type PeerMessage =
  | Handshake
  /** Sent once the channel opens, so each side can name and remember the other. */
  /**
   * `pairSeed` is 16 random bytes, base64. Both ends send one and both combine
   * the pair the same way, so the long-term secret they remember each other by
   * is 256 bits — never the four-word invite, which is short by design and only
   * has to survive the minutes before you connect.
   */
  | { k: 'hello'; name: string; avatarSeed: string; pairSeed: string }
  | { k: 'media'; mic: boolean; cam: boolean }
  /** The receiver-driven quality ladder: "this is how big I'm drawing you". */
  | { k: 'want'; size: FaceSize }
  | { k: 'sharing'; on: boolean }
  /** Only one person shares at a time. Everyone else has to ask. */
  | { k: 'share-request'; name: string }
  | { k: 'share-granted' }
  | { k: 'share-denied' }
  /** Said on the way out, so the far end doesn't have to wait for ICE to time
   *  out and then diagnose a hang-up as a network fault. */
  | { k: 'bye' }
  /** Purely cosmetic: keeps the far end's speaking ring honest when their
   *  browser doesn't expose per-source audio levels. */
  | { k: 'speaking'; on: boolean }

/** What the server relays. `d` is opaque ciphertext; the server can't open it. */
export type ServerMessage =
  | { t: 'peers'; ids: string[] }
  | { t: 'join'; id: string }
  | { t: 'bye'; id: string }
  | { t: 'sig'; from: string; d: string }

/**
 * Where the introduction service lives.
 *
 * Bake your own in at build time so nobody has to paste anything:
 *
 *   COZY_SIGNAL=wss://cozy-signal.you.workers.dev/ws npm run dist
 *
 * Individual users can still override it in Settings → Connection, which is
 * what self-hosters do. There is no default that works out of the box on
 * purpose: a URL that silently points at somebody else's box is worse than one
 * that tells you it isn't set.
 */
export const DEFAULT_SIGNAL_URL =
  (import.meta.env?.VITE_COZY_SIGNAL as string | undefined) || 'wss://signal.getcozy.app/ws'

/** True when nobody has pointed the app at a server yet. */
export const SIGNAL_IS_PLACEHOLDER = DEFAULT_SIGNAL_URL.includes('signal.getcozy.app')

/** Pure STUN. No default TURN is shipped: relaying media is the one thing that
 *  would ever cost money to run, so it stays bring-your-own (Settings →
 *  Connection). See docs/LIMITATIONS.md. */
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
