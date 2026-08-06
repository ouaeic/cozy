/**
 * Cozy signaling — the entire server.
 *
 * It introduces people to each other and then gets out of the way. Once a peer
 * connection is up, the clients open a DataChannel and do all further signaling
 * (renegotiation, mute state, quality hints, pairing) directly between
 * themselves. A whole movie night costs about six messages through here.
 *
 * The socket stays open for the life of the call rather than hanging up once
 * the peers are talking. It has to: closing it seals the room, so nobody could
 * join a group later, nobody could rejoin after a network drop, and a departure
 * would go unannounced. An idle hibernated WebSocket bills nothing, so the only
 * thing the old behaviour bought was a bug.
 *
 * It also can't read any of them. The room id it sees is derived from a secret
 * it never receives — a million rounds of PBKDF2, because the invite code
 * behind it is short — and every payload is AES-GCM sealed with a key derived
 * from that same secret. So this server cannot read the IP addresses carried in
 * your session descriptions, join your room, or impersonate either side.
 *
 * It does see the address you connect FROM, as every server does, and uses it
 * for the rate limit below and nothing else. That matters when the thing routing two
 * people's private movie nights is a box neither of them owns.
 *
 * Deploy: npx wrangler deploy --config server/wrangler.toml
 *
 * Rate limiting is in the code below, bound in wrangler.toml — 30 attempts a
 * minute per IP. Invite codes are seven characters from a
 * 15-symbol alphabet — 27 bits — chosen so they survive being read out loud,
 * which is plenty against guessing only while guessing stays expensive. A room lives only as long as somebody is waiting in
 * it, so a limit turns "one in a few thousand per room" into "one in a few
 * million". The self-hosted server in serve.mjs does this in code; on Workers
 * it belongs in the platform, which does it better than we could.
 */

export interface Env {
  ROOMS: DurableObjectNamespace
  /**
   * Cloudflare's rate limiter, bound in wrangler.toml. Optional on purpose: a
   * fork that removes the binding should still run, it just loses this defence.
   */
  ROOM_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> }
}

const ROOM_ID = /^[0-9a-f]{16,64}$/
// Full mesh, so everyone sends to everyone. Cameras are cheap at these sizes;
// the real ceiling is the sharer's upload, which the client scales down as the
// room fills (see quality.ts).
const MAX_PEERS = 8
const MAX_MESSAGE_BYTES = 64 * 1024

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return new Response('ok', { headers: { 'content-type': 'text/plain' } })
    }

    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 })
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }

    // The room is already a hash. We never see what produced it.
    const room = url.searchParams.get('r') ?? ''
    if (!ROOM_ID.test(room)) return new Response('Bad room', { status: 400 })

    // The limit is not a nicety — it is the thing standing between a 27-bit
    // invite code and somebody enumerating rooms. This used to live only in a
    // README instruction telling operators to add a dashboard rule, which meant
    // the defence the docs describe did not exist in any deployment where
    // someone skipped that step.
    //
    // CF-Connecting-IP is set by Cloudflare and overwrites anything the client
    // sends, so unlike an X-Forwarded-For it cannot be chosen by the attacker.
    if (env.ROOM_LIMIT) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
      const { success } = await env.ROOM_LIMIT.limit({ key: ip })
      if (!success) {
        return new Response('Too many attempts', { status: 429, headers: { 'retry-after': '60' } })
      }
    }

    const id = env.ROOMS.idFromName(room)
    return env.ROOMS.get(id).fetch(request)
  },
}

interface Attachment {
  id: string
  /** Set when this socket is being replaced by a reconnect, so its close
   *  doesn't get reported as the person leaving. */
  superseded?: boolean
}

export class Room {
  private state: DurableObjectState

  constructor(state: DurableObjectState) {
    this.state = state
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const id = url.searchParams.get('id') ?? ''
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return new Response('Bad id', { status: 400 })

    const live = this.state.getWebSockets()
    // Retire a same-id socket BEFORE counting, so someone whose connection
    // dropped can always get back into their own room rather than being told
    // it is full by their own ghost.
    for (const ws of live) {
      if (this.idOf(ws) === id) {
        // Mark it superseded first: webSocketClose fires after the new socket
        // has already announced itself, and would otherwise tell everyone this
        // person left immediately after telling them they arrived.
        try {
          ws.serializeAttachment({ id, superseded: true } satisfies Attachment)
          ws.close(1000, 'replaced')
        } catch {
          /* already gone */
        }
      }
    }

    if (this.state.getWebSockets().filter((ws) => this.idOf(ws) !== id).length >= MAX_PEERS) {
      // Accept and then close with a code, rather than refusing the upgrade.
      // A rejected upgrade reaches the client as a generic 1006, which is
      // indistinguishable from a flaky network — so it would retry forever
      // instead of saying "this room is full".
      const full = new WebSocketPair()
      full[1].accept()
      full[1].close(1013, 'room full')
      return new Response(null, { status: 101, webSocket: full[0] })
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]

    // Hibernation: the Durable Object can be evicted from memory while these
    // sockets stay open, and is only woken by an actual message. That's what
    // keeps an idle room effectively free.
    this.state.acceptWebSocket(server)
    server.serializeAttachment({ id } satisfies Attachment)

    const others = this.state
      .getWebSockets()
      .map((ws) => this.idOf(ws))
      .filter((other): other is string => !!other && other !== id)

    server.send(JSON.stringify({ t: 'peers', ids: others }))
    this.broadcast({ t: 'join', id }, id)

    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return
    const from = this.idOf(ws)
    if (!from) return

    let msg: { t?: string; to?: string; d?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    // 'sig' is the only thing worth forwarding, and `d` is opaque ciphertext.
    if (msg.t !== 'sig' || typeof msg.to !== 'string' || typeof msg.d !== 'string') return

    const target = this.state.getWebSockets().find((s) => this.idOf(s) === msg.to)
    if (!target) return
    try {
      target.send(JSON.stringify({ t: 'sig', from, d: msg.d }))
    } catch {
      /* peer vanished mid-send */
    }
  }

  webSocketClose(ws: WebSocket): void {
    let attachment: Attachment | null = null
    try {
      attachment = ws.deserializeAttachment() as Attachment | null
    } catch {
      return
    }
    if (!attachment?.id || attachment.superseded) return
    this.broadcast({ t: 'bye', id: attachment.id }, attachment.id)
  }

  webSocketError(ws: WebSocket): void {
    this.webSocketClose(ws)
  }

  private idOf(ws: WebSocket): string | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null)?.id ?? null
    } catch {
      return null
    }
  }

  private broadcast(message: object, except: string): void {
    const body = JSON.stringify(message)
    for (const ws of this.state.getWebSockets()) {
      if (this.idOf(ws) === except) continue
      try {
        ws.send(body)
      } catch {
        /* closing */
      }
    }
  }
}
