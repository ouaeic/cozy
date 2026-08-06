// Two sinks and one timer.
//
// The point of the whole app is that you can hear each other over the film, so
// the voice sink sits at full volume and the film sits under it. Then, because
// a fixed balance still isn't enough to talk over a loud scene, the film ducks
// whenever the other person speaks.
//
// Deliberately no WebAudio graph: HTMLMediaElement.volume is ramped internally
// by Chromium (so it doesn't click), costs nothing, and avoids the long-standing
// gotchas around routing a remote WebRTC stream through an AudioContext.

const POLL_MS = 100
/** RFC 6464 level, 0–1. About -30 dBFS — above room tone, below a mumble. */
const SPEECH_THRESHOLD = 0.03
/** Consecutive samples before we believe it, so a cough doesn't duck a film. */
const ATTACK_SAMPLES = 2
/** Keep the film down this long after they stop, so pauses mid-sentence don't
 *  make the soundtrack surge back in. */
const HOLD_MS = 600
/** How far the film drops while they're talking. */
const DUCK_TO = 0.35
/** Per-tick smoothing. Down fast, back up gently. */
const ATTACK_COEF = 0.6
const RELEASE_COEF = 0.1

export class Mixer {
  /** One sink per person. Two is the design, but a third and fourth shouldn't
   *  silently go inaudible. */
  private voices = new Map<string, HTMLAudioElement>()
  private levels = new Map<string, () => RTCRtpReceiver | null>()
  private movie = new Audio()

  private balance = 0.55
  private autoDuck = true

  private timer: ReturnType<typeof setInterval> | null = null

  private hot = 0
  private quietSince = 0
  private ducking = false

  /** Drives the warm ring around whoever is talking. */
  onSpeaking: (peerId: string, speaking: boolean) => void = () => {}

  constructor() {
    this.movie.autoplay = true
    this.movie.style.display = 'none'
    document.body.appendChild(this.movie)
    this.movie.volume = this.balance
  }

  /** Someone's microphone. Always full volume — this is the point. */
  setVoice(peerId: string, stream: MediaStream | null): void {
    let el = this.voices.get(peerId)
    if (!stream) {
      el?.remove()
      this.voices.delete(peerId)
      this.levels.delete(peerId)
      this.onSpeaking(peerId, false)
      this.reconsiderTimer()
      return
    }
    if (!el) {
      el = new Audio()
      el.autoplay = true
      el.volume = 1
      el.style.display = 'none'
      document.body.appendChild(el)
      this.voices.set(peerId, el)
    }
    el.srcObject = stream
    void el.play().catch(() => {})
    this.reconsiderTimer()
  }

  /**
   * The film. Either the far end's shared audio, or — when you're the one
   * sharing — your own captured loopback, played back here because we asked the
   * OS to mute your speakers. Same element either way, so ducking works
   * identically for both people rather than only for the viewer.
   */
  setMovie(stream: MediaStream | null): void {
    this.movie.srcObject = stream
    this.movie.volume = this.balance
    if (stream) void this.movie.play().catch(() => {})
    this.reconsiderTimer()
  }

  get hasMovie(): boolean {
    return !!this.movie.srcObject
  }

  /** 0 = voices only, 1 = film at full volume. */
  setBalance(value: number): void {
    this.balance = Math.min(1, Math.max(0, value))
    if (!this.ducking) this.movie.volume = this.balance
  }

  setAutoDuck(on: boolean): void {
    this.autoDuck = on
    if (!on) {
      this.ducking = false
      this.movie.volume = this.balance
    }
    this.reconsiderTimer()
  }

  /** Where to read someone's speaking level from. */
  watch(peerId: string, getReceiver: () => RTCRtpReceiver | null): void {
    this.levels.set(peerId, getReceiver)
    this.reconsiderTimer()
  }

  /** Only run the timer when it can actually do something. */
  private reconsiderTimer(): void {
    const needed = this.voices.size > 0
    if (needed && !this.timer) this.timer = setInterval(() => this.tick(), POLL_MS)
    else if (!needed && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    let anySpeaking = false
    for (const [peerId, getReceiver] of this.levels) {
      const speaking = this.level(getReceiver()) > SPEECH_THRESHOLD
      this.onSpeaking(peerId, speaking)
      if (speaking) anySpeaking = true
    }

    if (anySpeaking) {
      this.hot = Math.min(this.hot + 1, ATTACK_SAMPLES)
      this.quietSince = 0
    } else if (this.hot >= ATTACK_SAMPLES) {
      if (!this.quietSince) this.quietSince = Date.now()
      if (Date.now() - this.quietSince > HOLD_MS) this.hot = 0
    } else {
      this.hot = 0
    }

    const speaking = this.hot >= ATTACK_SAMPLES
    if (!this.autoDuck || !this.movie.srcObject) return

    const target = speaking ? this.balance * DUCK_TO : this.balance
    const coef = speaking ? ATTACK_COEF : RELEASE_COEF
    const next = this.movie.volume + (target - this.movie.volume) * coef
    // Snap when we're close enough, so we stop doing arithmetic forever.
    this.movie.volume = Math.abs(next - target) < 0.005 ? target : Math.min(1, Math.max(0, next))
    this.ducking = speaking
  }

  /**
   * Per-source level straight off the receiver. No analyser node, no extra
   * decode — the number is already there because RTP carries it.
   */
  private level(receiver: RTCRtpReceiver | null): number {
    if (!receiver) return 0
    try {
      const sources = receiver.getSynchronizationSources?.() ?? []
      let peak = 0
      for (const s of sources) {
        if (typeof s.audioLevel === 'number' && s.audioLevel > peak) peak = s.audioLevel
      }
      return peak
    } catch {
      return 0
    }
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const el of [...this.voices.values(), this.movie]) {
      el.srcObject = null
      el.remove()
    }
    this.voices.clear()
    this.levels.clear()
  }
}
