/**
 * Cozy signalling, as a module you mount on the server you already have.
 *
 * The Cozy desktop app connects two people directly, peer to peer. Before it
 * can, the two computers have to find each other — that is all this does. It
 * holds a room open, relays about six small messages, and then the video and
 * audio flow straight between the two machines and never touch this server
 * again. No media passes through here, ever.
 *
 * It also cannot read what it relays. The room id it receives is derived from a
 * secret it is never given (a million rounds of PBKDF2 over the invite code),
 * and every payload is sealed with AES-GCM using a key derived from that same
 * secret. So this server cannot read session descriptions — which carry IP
 * addresses — join a room, or impersonate either side. There is genuinely
 * nothing in here worth reading.
 *
 * ---------------------------------------------------------------------------
 * MOUNTING IT
 *
 *   import { mountCozySignalling } from './cozy-signal.mjs'
 *
 *   const httpServer = app.listen(PORT)          // or createServer(app)
 *   mountCozySignalling(httpServer, { path: '/cozy/ws', trustProxy: true })
 *
 * MOUNT IT AFTER the web app's own WebSocket server exists. It claims one path
 * and hands every other upgrade to whoever was already listening — which it has
 * to do, because a `WebSocketServer({ server })` aborts any upgrade whose path
 * doesn't match with a 400 before anyone else gets a look. See the note on the
 * routing below; this was verified failing before it was written.
 *
 * `trustProxy: true` is correct on Replit, Fly, Render, Heroku, or behind any
 * reverse proxy or CDN — see the note on the rate limit.
 *
 * Requires `ws`, which the web app already depends on. Nothing else.
 * ---------------------------------------------------------------------------
 */

import { WebSocketServer } from 'ws'

const ROOM_ID = /^[0-9a-f]{16,64}$/
const PEER_ID = /^[A-Za-z0-9_-]{8,64}$/

/** Full mesh, so everyone sends to everyone; the sharer's upload is the real
 *  ceiling long before this is. */
const MAX_PEERS = 8
const MAX_MESSAGE_BYTES = 64 * 1024
const PING_INTERVAL_MS = 30_000

/**
 * Invite codes are seven characters from a 15-symbol alphabet — about 27 bits —
 * chosen so they survive being read aloud over a bad connection. That is plenty
 * against guessing, but ONLY while guessing stays expensive.
 *
 * A room exists only while somebody is sitting in it, usually a few minutes. At
 * the rate below an attacker gets a few thousand attempts inside that window
 * against 171 million combinations. Without a limit it would be a few thousand
 * against a few thousand, which is a different thing entirely.
 */
const JOIN_WINDOW_MS = 60_000
const JOIN_MAX_PER_WINDOW = 30

/**
 * @param {import('node:http').Server} httpServer  the server Express is on
 * @param {{ path?: string, trustProxy?: boolean, maxPeers?: number }} [options]
 * @returns {{ close(): void, stats(): { rooms: number, peers: number } }}
 */
export function mountCozySignalling(httpServer, options = {}) {
  const path = options.path ?? '/cozy/ws'
  const trustProxy = options.trustProxy ?? false
  const maxPeers = options.maxPeers ?? MAX_PEERS

  /** @type {Map<string, Map<string, import('ws').WebSocket>>} room -> id -> socket */
  const rooms = new Map()
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const attempts = new Map()

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES })

  function tooManyAttempts(ip) {
    const now = Date.now()
    const seen = attempts.get(ip)
    if (!seen || now > seen.resetAt) {
      attempts.set(ip, { count: 1, resetAt: now + JOIN_WINDOW_MS })
      return false
    }
    seen.count += 1
    return seen.count > JOIN_MAX_PER_WINDOW
  }

  // Unbounded growth otherwise: one entry per address, forever.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [ip, seen] of attempts) if (now > seen.resetAt) attempts.delete(ip)
  }, JOIN_WINDOW_MS)
  sweep.unref?.()

  function addressOf(req) {
    // The rate limit is what stands between a 27-bit code and an attacker, so
    // the address it keys on must not be one the attacker can choose.
    // X-Forwarded-For is a REQUEST HEADER — anybody can send it. Reading it
    // unconditionally would mean one extra header per attempt buys unlimited
    // guesses. It is only meaningful when something in front of us set it.
    if (trustProxy) {
      const forwarded =
        req.headers['cf-connecting-ip'] ||
        String(req.headers['x-forwarded-for'] || '')
          .split(',')[0]
          .trim()
      if (forwarded) return forwarded
    }
    return req.socket.remoteAddress || 'unknown'
  }

  // Take over upgrade routing, then hand anything that isn't ours to whoever
  // was already listening.
  //
  // This is not politeness, it is necessary. A `new WebSocketServer({ server })`
  // — which is how the existing /ws server is created — installs an upgrade
  // listener that ABORTS any request whose path doesn't match, with a 400,
  // before we ever see it. Simply adding a second listener therefore fails:
  // every Cozy connection is killed by the other server. (Verified: without
  // this, the client gets "Unexpected server response: 400".)
  //
  // So we lift the existing listeners off, put a router in front, and call them
  // ourselves for every path but ours. Their behaviour is unchanged; they just
  // stop seeing upgrades that were never for them.
  //
  // Mount this AFTER the other WebSocket server is created, or there will be
  // nothing to lift.
  const inherited = httpServer.listeners('upgrade').slice()
  httpServer.removeAllListeners('upgrade')

  const onUpgrade = (req, socket, head) => {
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      pathname = null
    }

    if (pathname === path) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
      return
    }

    if (inherited.length === 0) {
      // Nobody else wants it, and an unanswered upgrade leaks the socket.
      socket.destroy()
      return
    }
    for (const listener of inherited) listener.call(httpServer, req, socket, head)
  }
  httpServer.on('upgrade', onUpgrade)

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const room = url.searchParams.get('r') ?? ''
    const id = url.searchParams.get('id') ?? ''

    if (!ROOM_ID.test(room) || !PEER_ID.test(id)) return ws.close(1008, 'bad request')
    if (tooManyAttempts(addressOf(req))) return ws.close(1013, 'too many attempts')

    let peers = rooms.get(room)
    if (!peers) rooms.set(room, (peers = new Map()))

    // A reconnect with the same id replaces the old socket rather than showing
    // up as a second ghost peer.
    peers.get(id)?.close(1000, 'replaced')
    if (peers.size >= maxPeers) return ws.close(1013, 'room full')

    peers.set(id, ws)
    ws.isAlive = true
    ws.on('pong', () => (ws.isAlive = true))

    send(ws, { t: 'peers', ids: [...peers.keys()].filter((k) => k !== id) })
    broadcast(room, { t: 'join', id }, id)

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      // The only relayed message type. `d` is opaque ciphertext — this server
      // has no key and no way to get one.
      if (msg?.t !== 'sig' || typeof msg.to !== 'string' || typeof msg.d !== 'string') return
      const target = rooms.get(room)?.get(msg.to)
      if (target) send(target, { t: 'sig', from: id, d: msg.d })
    })

    const drop = () => {
      const current = rooms.get(room)
      if (current?.get(id) !== ws) return // already replaced by a reconnect
      current.delete(id)
      if (current.size === 0) rooms.delete(room)
      broadcast(room, { t: 'bye', id }, id)
    }
    ws.on('close', drop)
    ws.on('error', drop)
  })

  // Proxies and load balancers drop idle WebSockets. This keeps them open for
  // the length of a film without the client having to say anything.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      try {
        ws.ping()
      } catch {
        /* already closing */
      }
    }
  }, PING_INTERVAL_MS)
  heartbeat.unref?.()

  function send(ws, message) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
  }

  function broadcast(room, message, except) {
    for (const [peerId, socket] of rooms.get(room) ?? []) {
      if (peerId !== except) send(socket, message)
    }
  }

  return {
    close() {
      clearInterval(heartbeat)
      clearInterval(sweep)
      httpServer.off('upgrade', onUpgrade)
      for (const listener of inherited) httpServer.on('upgrade', listener)
      for (const ws of wss.clients) ws.close(1001, 'server shutting down')
      wss.close()
    },
    stats() {
      let peers = 0
      for (const room of rooms.values()) peers += room.size
      return { rooms: rooms.size, peers }
    },
  }
}
