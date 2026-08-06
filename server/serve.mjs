#!/usr/bin/env node
/**
 * The same signaling protocol as worker.ts, for anyone who would rather run it
 * themselves than trust a hosted box. No dependencies beyond `ws`.
 *
 *   npm i ws && node server/serve.mjs        # ws://localhost:8787/ws
 *
 * Then point the app at it: Settings → Advanced → Signaling server.
 *
 * Like the Worker, it only ever sees a room *hash* and sealed payloads. There
 * is nothing in here worth reading.
 */

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8787)
const ROOM_ID = /^[0-9a-f]{16,64}$/
const PEER_ID = /^[A-Za-z0-9_-]{8,64}$/
const MAX_PEERS = 8
const MAX_MESSAGE_BYTES = 64 * 1024
const PING_INTERVAL_MS = 30_000

/** @type {Map<string, Map<string, import('ws').WebSocket>>} room -> id -> socket */
const rooms = new Map()

// Invite codes are seven characters from a 15-symbol alphabet — 27 bits —
// chosen so that they survive being said out loud.
// That is plenty against someone guessing, but only if guessing is expensive.
// A room exists only while somebody is waiting in it, so an attacker has a few
// minutes to find one combination in four billion; at the rate below that is
// about a thousand attempts per window, or odds of roughly one in four million
// per room. Without a limit it would be one in a few thousand.
const JOIN_WINDOW_MS = 60_000
const JOIN_MAX_PER_WINDOW = 30
/** @type {Map<string, {count: number, resetAt: number}>} */
const attempts = new Map()

function tooManyAttempts(ip) {
  const now = Date.now()
  const seen = attempts.get(ip)
  if (!seen || now > seen.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + JOIN_WINDOW_MS })
    return false
  }
  seen.count++
  return seen.count > JOIN_MAX_PER_WINDOW
}

// Keep the table from growing without bound on a long-lived process.
setInterval(() => {
  const now = Date.now()
  for (const [ip, seen] of attempts) if (now > seen.resetAt) attempts.delete(ip)
}, JOIN_WINDOW_MS).unref?.()

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: MAX_MESSAGE_BYTES })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const room = url.searchParams.get('r') ?? ''
  const id = url.searchParams.get('id') ?? ''

  if (!ROOM_ID.test(room) || !PEER_ID.test(id)) return ws.close(1008, 'bad request')

  // The rate limit is the thing standing between a 27-bit invite code and an
  // attacker, so the address it keys on must not be one the attacker chooses.
  //
  // X-Forwarded-For is a REQUEST HEADER: anyone can send it, and reading it
  // unconditionally meant one extra header per attempt bought an unlimited
  // number of guesses. It is only meaningful when something in front of us set
  // it, so it is trusted only when TRUST_PROXY says there is such a thing.
  // CF-Connecting-IP is likewise only trustworthy behind Cloudflare, which
  // overwrites it.
  const behindProxy = process.env.TRUST_PROXY === '1'
  const forwarded = behindProxy
    ? req.headers['cf-connecting-ip'] ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    : null
  const ip = forwarded || req.socket.remoteAddress || 'unknown'
  if (tooManyAttempts(ip)) return ws.close(1013, 'too many attempts')

  let peers = rooms.get(room)
  if (!peers) rooms.set(room, (peers = new Map()))

  // A reconnect with the same id replaces the old socket instead of appearing
  // as a second ghost peer.
  peers.get(id)?.close(1000, 'replaced')
  if (peers.size >= MAX_PEERS) return ws.close(1013, 'room full')

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
    // Only relayed message type; `d` is opaque ciphertext.
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
      /* closing */
    }
  }
}, PING_INTERVAL_MS)
heartbeat.unref()

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message))
}

function broadcast(room, message, except) {
  for (const [peerId, ws] of rooms.get(room) ?? []) {
    if (peerId !== except) send(ws, message)
  }
}

http.listen(PORT, () => console.log(`cozy signaling on ws://localhost:${PORT}/ws`))
