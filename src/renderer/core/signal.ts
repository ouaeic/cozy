import { seal, unseal } from './crypto.js'
import type { Handshake, ServerMessage } from './protocol.js'

// The connection to the introduction service. It stays open for the life of the
// call: it's how anyone else finds the room, and how everyone learns that
// someone left. The traffic that matters — renegotiation, mute state, quality
// hints — goes peer-to-peer over a DataChannel instead (see session.ts).

type Status = 'idle' | 'connecting' | 'open' | 'closed'

export class Signal {
  private ws: WebSocket | null = null
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false
  /**
   * Anything produced while the socket is still opening. Without this, an
   * ICE-restart offer made in the milliseconds after `open()` is silently
   * dropped — and since nothing retries it, a routine Wi-Fi change turns into
   * "we can't find a direct path between you" a dozen seconds later.
   */
  private outbox: { to: string; message: Handshake }[] = []

  onPeers: (ids: string[]) => void = () => {}
  onJoin: (id: string) => void = () => {}
  onBye: (id: string) => void = () => {}
  onHandshake: (from: string, msg: Handshake) => void = () => {}
  onStatus: (status: Status, consecutiveFailures: number) => void = () => {}
  /** The server turned us away for a reason retrying won't fix. */
  onRejected: (reason: string) => void = () => {}

  constructor(
    private url: string,
    private roomId: string,
    private selfId: string,
    private key: CryptoKey,
  ) {}

  open(): void {
    if (this.closed || this.ws) return
    this.onStatus('connecting', this.retries)

    const endpoint = `${this.url}?r=${encodeURIComponent(this.roomId)}&id=${encodeURIComponent(this.selfId)}`
    let ws: WebSocket
    try {
      ws = new WebSocket(endpoint)
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.retries = 0
      this.retries = 0
      this.onStatus('open', 0)
      void this.flush()
    }

    ws.onmessage = (event) => {
      void this.receive(String(event.data))
    }

    ws.onclose = (event) => {
      this.ws = null
      this.onStatus('closed', this.retries)
      // 1013 is the server saying the room is full. Retrying would just keep
      // bouncing off it, so stop and let the UI say something useful.
      if (event.code === 1013) {
        this.closed = true
        this.onRejected('That room is full.')
        return
      }
      if (!this.closed) this.scheduleRetry()
    }

    ws.onerror = () => {
      /* onclose follows and drives the retry */
    }
  }

  private async receive(raw: string): Promise<void> {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }

    switch (msg.t) {
      case 'peers':
        this.onPeers(msg.ids)
        break
      case 'join':
        this.onJoin(msg.id)
        break
      case 'bye':
        this.onBye(msg.id)
        break
      case 'sig': {
        const payload = await unseal<Handshake>(this.key, msg.d)
        // A payload we can't open wasn't sealed with our invite code — someone
        // in the wrong room, or the server making things up. Ignore it.
        if (payload) this.onHandshake(msg.from, payload)
        break
      }
    }
  }

  async send(to: string, message: Handshake): Promise<void> {
    if (this.closed) return
    // Hold it rather than drop it if we're mid-handshake; flushed on open.
    if (this.ws?.readyState !== WebSocket.OPEN) {
      if (this.outbox.length < 64) this.outbox.push({ to, message })
      this.open() // no-op if a socket already exists
      return
    }
    const d = await seal(this.key, message)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ t: 'sig', to, d }))
    } else if (this.outbox.length < 64) {
      // It closed while we were sealing.
      this.outbox.push({ to, message })
    }
  }

  private async flush(): Promise<void> {
    const pending = this.outbox
    this.outbox = []
    for (const item of pending) await this.send(item.to, item.message)
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  close(): void {
    this.closed = true
    this.outbox = []
    this.clearRetry()
    try {
      this.ws?.close(1000, 'bye')
    } catch {
      /* already gone */
    }
    this.ws = null
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) return
    this.retries++
    // Capped exponential backoff with jitter. Media keeps flowing peer-to-peer
    // throughout, so there's no rush.
    const base = Math.min(20_000, 2 ** Math.min(this.retries, 5) * 500)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.open()
    }, base + Math.random() * 750)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }
}
