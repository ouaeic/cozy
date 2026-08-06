import type { FaceSize } from '../../shared/types.js'

// ---------------------------------------------------------------------------
// Codec choice, Opus tuning, encoder ceilings, and receive-buffer posture.
//
// Mostly carried over from the web version, whose reasoning holds: set a high
// CEILING and let congestion control adapt DOWN. Never set a floor — a floor
// forces the encoder to overshoot a slow pipe, which is exactly what produces
// the freezes and crackle that read as "it falls apart at her end".
//
// The new part is the webcam ladder. The old version encoded 720p30 at 2.5 Mbps
// and then drew it into a 200-pixel box. That was most of the power budget,
// spent on pixels nobody could see.
// ---------------------------------------------------------------------------

// Ceilings in bits/sec. Live-updatable via setParameters().
export const SCREEN_VIDEO_MAX_BITRATE = 6_000_000 // 1080p30 movie content
export const SCREEN_AUDIO_MAX_BITRATE = 320_000 // high-fidelity stereo music

/** Below this a film stops being worth watching, so we'd rather drop viewers
 *  than keep dividing. */
const SCREEN_VIDEO_FLOOR = 1_200_000

/** What a face tile actually needs, by how big it's being drawn. The receiver
 *  asks; the sender obeys. An order of magnitude less encode work than 720p,
 *  and indistinguishable at these sizes. */
export const FACE_PROFILES: Record<FaceSize, { width: number; height: number; fps: number; bitrate: number }> = {
  S: { width: 320, height: 180, fps: 15, bitrate: 150_000 },
  M: { width: 480, height: 270, fps: 20, bitrate: 300_000 },
  L: { width: 640, height: 360, fps: 24, bitrate: 500_000 },
}

/**
 * The one SDP bitrate hint worth keeping: it stops the estimator starting from
 * ~300kbps on the first negotiation. It applies ONLY when the send codec
 * changes, so it helps once, at the beginning, and never again — don't count on
 * it for recovery.
 *
 * There is deliberately no `x-google-min-bitrate` here. It reads like a gentle
 * hint and is nothing of the sort: Chromium feeds it into the congestion
 * controller as `min_bitrate_configured_`, and the target rate is then clamped
 * so it can never fall below it. On a link that can only carry 900kbps, a
 * 1.5Mbps floor means we keep pushing 1.5Mbps into it — filling queues, driving
 * up delay, and causing exactly the freezing and audio crackle it was meant to
 * prevent. It is the same footgun this file's header warns about, and it was
 * sitting three lines below the warning.
 */
const VIDEO_START_KBPS = 4000

/**
 * Films are 1080p. Sharing a 4K or a scaled-up display means handing the
 * encoder four to eight million pixels and asking it to fit them in the same
 * few megabits — which looks like mush, and is a lot of encoding to do badly.
 * Cap the capture; the picture is better and the laptop is cooler.
 */
export const MAX_SHARE_WIDTH = 1920
export const MAX_SHARE_HEIGHT = 1080

// H.264 first, deliberately. On macOS (VideoToolbox) and Windows (Media
// Foundation) that means HARDWARE encode, so the CPU never becomes the
// bottleneck. NOT on Linux: Chromium's kAcceleratedVideoEncodeLinux is still
// DISABLED_BY_DEFAULT, so VA-API encode never initialises and 1080p is encoded
// in software by OpenH264 — see docs/LIMITATIONS.md. H.264 is still the right
// first choice there, because software H.264 is cheaper than software VP9. Software VP9/AV1 at 1080p30 saturates a laptop, trips
// libwebrtc's overuse detector, and pins resolution low for ~40 seconds; that's
// the single biggest cause of "it dropped to potato and never came back". It's
// also the difference between a warm laptop and a cool one.
const VIDEO_CODEC_ORDER = ['video/h264', 'video/vp9', 'video/vp8']

const codecRank = (mime: string) => {
  const i = VIDEO_CODEC_ORDER.indexOf(mime.toLowerCase())
  return i === -1 ? VIDEO_CODEC_ORDER.length : i
}

/** Bias every video transceiver toward hardware-friendly codecs. Best effort. */
export function preferVideoCodecs(pc: RTCPeerConnection): void {
  try {
    if (typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) return
    const caps = RTCRtpReceiver.getCapabilities('video')
    if (!caps?.codecs?.length) return
    const ranked = [...caps.codecs].sort((a, b) => codecRank(a.mimeType) - codecRank(b.mimeType))
    for (const t of pc.getTransceivers()) {
      const kind = t.sender.track?.kind ?? t.receiver.track?.kind
      if (kind === 'video' && typeof t.setCodecPreferences === 'function') {
        try {
          t.setCodecPreferences(ranked)
        } catch {
          /* not every transceiver accepts preferences at every moment */
        }
      }
    }
  } catch {
    /* capability querying unsupported */
  }
}

// ------------------------------------------------------------------ SDP

export const mungeSdp = (sdp: string | undefined) =>
  sdp ? mungeVideoBitrate(mungeOpusForMusic(sdp)) : sdp

function mergeFmtp(existing: string, additions: Record<string, string>): string {
  const params = new Map<string, string>()
  for (const part of existing.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq === -1) params.set(part, '')
    else params.set(part.slice(0, eq), part.slice(eq + 1))
  }
  for (const [k, v] of Object.entries(additions)) params.set(k, v)
  return [...params.entries()].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')
}

/**
 * Split an SDP into the session block and each m= section, transform, rejoin.
 *
 * This matters more than it looks. A call carries several media sections — the
 * microphone, the camera, the shared picture, the shared sound — and they
 * routinely share a payload type. A plain `sdp.replace(/a=fmtp:111 …/)` is not
 * global, so it rewrites exactly one of them: the first, which is the
 * microphone. The film's audio line is left on Opus's default mono speech
 * profile and the soundtrack arrives thin and centre-panned, with nothing in
 * the logs to suggest why.
 */
function mapMediaSections(sdp: string, fn: (section: string) => string): string {
  const parts = sdp.split(/(?=^m=)/m)
  return parts.map((part, i) => (i === 0 ? part : fn(part))).join('')
}

const OPUS_MUSIC = {
  minptime: '10',
  useinbandfec: '1',
  // `stereo` says "I can receive stereo"; `sprop-stereo` says "I may send it".
  // Both ends need both, or one direction quietly collapses to mono.
  stereo: '1',
  'sprop-stereo': '1',
  maxaveragebitrate: String(SCREEN_AUDIO_MAX_BITRATE),
  maxplaybackrate: '48000',
  cbr: '0',
  usedtx: '0',
}

/**
 * Put Opus into stereo MUSIC mode instead of the mono speech profile WebRTC
 * negotiates by default. Without this a soundtrack arrives flat and thin —
 * dialogue survives, the score doesn't. Applied to every Opus section, and
 * always against the negotiated payload type; never hardcode 111.
 */
export function mungeOpusForMusic(sdp: string): string {
  return mapMediaSections(sdp, (section) => {
    const rtpmap = section.match(/a=rtpmap:(\d+)\s+opus\/48000\/2/i)
    if (!rtpmap) return section
    const pt = rtpmap[1]!
    const fmtpRe = new RegExp(`a=fmtp:${pt} (.*)`)
    if (fmtpRe.test(section)) {
      return section.replace(
        fmtpRe,
        (_m, existing: string) => `a=fmtp:${pt} ${mergeFmtp(existing, OPUS_MUSIC)}`,
      )
    }
    return section.replace(rtpmap[0], `${rtpmap[0]}\r\na=fmtp:${pt} ${mergeFmtp('', OPUS_MUSIC)}`)
  })
}

/**
 * Anchor the bandwidth estimator high on (re)negotiation so it doesn't crawl up
 * from nothing every time someone starts sharing. Chromium-only; other stacks
 * ignore these harmlessly. Must be applied to BOTH offer and answer.
 */
export function mungeVideoBitrate(sdp: string): string {
  const additions = {
    'x-google-start-bitrate': String(VIDEO_START_KBPS),
  }
  // Per section, for the same reason as the Opus munge above: the camera and
  // the shared screen are separate m-lines that usually share payload types.
  return mapMediaSections(sdp, (section) => {
    const pts = new Set<string>()
    const re = /a=rtpmap:(\d+)\s+(VP9|H264|VP8)\/90000/gi
    for (let m; (m = re.exec(section)); ) pts.add(m[1]!)
    let out = section
    for (const pt of pts) {
      const fmtpRe = new RegExp(`a=fmtp:${pt} (.*)`)
      if (fmtpRe.test(out)) {
        out = out.replace(
          fmtpRe,
          (_m, existing: string) => `a=fmtp:${pt} ${mergeFmtp(existing, additions)}`,
        )
      } else {
        const rtpmapRe = new RegExp(`(a=rtpmap:${pt}\\s+(?:VP9|H264|VP8)/90000)`, 'i')
        out = out.replace(rtpmapRe, (line) => `${line}\r\na=fmtp:${pt} ${mergeFmtp('', additions)}`)
      }
    }
    return out
  })
}

// -------------------------------------------------------------- encoders

export interface VideoPolicy {
  kind: 'screen' | 'webcam'
  /** For webcams: the size THIS peer is drawing us at — sets their bitrate. */
  faceSize?: FaceSize
  /** The largest size anyone is drawing us at — sets the shared capture. */
  captureSize?: FaceSize
  /** Ease off when the machine is unplugged. */
  onBattery?: boolean
  /**
   * How many people we're sending this to. There's no media server here, so a
   * shared film is uploaded once per viewer — three viewers at the full ceiling
   * would ask for 18 Mbit/s of upstream, which almost no home connection has.
   * Congestion control would eventually find the truth, but only after everyone
   * has watched it fall apart, so divide the ceiling up front.
   */
  viewers?: number
}

/** Ceiling, no floor, and a degradation preference that suits the content. */
export async function configureVideoSender(sender: RTCRtpSender, policy: VideoPolicy): Promise<void> {
  if (!sender.track || sender.track.kind !== 'video') return

  const isScreen = policy.kind === 'screen'
  const face = FACE_PROFILES[policy.faceSize ?? 'M']
  const viewers = Math.max(1, policy.viewers ?? 1)
  const maxBitrate = isScreen ? screenCeiling(viewers) : face.bitrate
  // 24fps is plenty for film and noticeably kinder to a battery than 30.
  const maxFramerate = isScreen ? (policy.onBattery ? 24 : 30) : face.fps

  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
    const e = params.encodings[0] as RTCRtpEncodingParameters & {
      networkPriority?: RTCPriorityType
      minBitrate?: number
    }
    e.maxBitrate = maxBitrate
    delete e.minBitrate // the soft guard lives in the SDP; never a hard floor here
    e.scaleResolutionDownBy = 1
    e.maxFramerate = maxFramerate
    // Voice must survive when the film cannot. Marking everything 'high' is the
    // same as marking nothing: `priority` decides how spare bitrate is shared
    // out, so identical values across the film and the microphone means no
    // ordering at all. The film sits a rung below on purpose.
    e.priority = isScreen ? 'medium' : 'high'
    e.networkPriority = isScreen ? 'medium' : 'high'
    // Film: under pressure drop FRAMERATE (recovers instantly) rather than
    // RESOLUTION (whose recovery is gated by a slow QP hysteresis). Paired with
    // the deep receive buffer below, this is what keeps a movie sharp.
    // 'balanced', not 'maintain-resolution'. Maintain-resolution sounds like
    // the quality-preserving choice and is the opposite: it switches OFF
    // libwebrtc's quality scaler entirely, so the encoder may never reduce
    // resolution and instead grinds framerate down towards a slideshow while
    // holding a picture it cannot afford. Balanced gives up a little of each,
    // keeps the quality scaler running, and — because it is allowed to scale
    // down — is also what makes scaling back UP possible when the link
    // recovers. Paired with the 1080p capture cap, the floor is bounded.
    ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
      'balanced'
    await sender.setParameters(params)
  } catch {
    /* setParameters rejects transiently mid-negotiation; harmless */
  }

  // scalabilityMode goes in a SEPARATE call: an unsupported value rejects the
  // whole setParameters, which would silently discard everything above.
  try {
    const p = sender.getParameters()
    if (p.encodings?.[0]) {
      // Two peers, no SFU, so there's nobody to strip temporal layers. L1T1.
      ;(p.encodings[0] as { scalabilityMode?: string }).scalabilityMode = 'L1T1'
      await sender.setParameters(p)
    }
  } catch {
    /* unsupported for this codec */
  }

  // Also constrain the capture itself — encoding 720p and scaling down still
  // costs the camera pipeline and the encoder. This is where the real saving is.
  if (!isScreen) {
    // Constrain to the LARGEST request, not this peer's. One camera track is
    // shared by every peer connection, so this call is global; using the
    // per-peer size would mean the last peer processed decides what everyone
    // else receives. Per-peer tailoring is the maxBitrate above.
    const capture = FACE_PROFILES[policy.captureSize ?? policy.faceSize ?? 'M']
    const current = sender.track.getSettings()
    // applyConstraints on a live camera visibly reconfigures it, so only when
    // it would actually change something.
    if (current.width !== capture.width || current.height !== capture.height) {
      try {
        await sender.track.applyConstraints({
          width: { ideal: capture.width, max: capture.width },
          height: { ideal: capture.height, max: capture.height },
          frameRate: { ideal: capture.fps, max: capture.fps },
        })
      } catch {
        /* some cameras refuse odd sizes; the encoder ceiling still applies */
      }
    }
  }
}

/** Voice is worth about 64 kbps; a soundtrack is worth twenty times that. */
export const VOICE_AUDIO_MAX_BITRATE = 64_000

/**
 * Give music headroom on the shared audio, and explicitly hold the microphone
 * down. The SDP raises the Opus ceiling on *every* audio section (it has to —
 * see mungeOpusForMusic), so without this the mic would happily spend
 * bandwidth it has no use for.
 */
export async function configureAudioSender(sender: RTCRtpSender, isScreen: boolean): Promise<void> {
  if (!sender.track || sender.track.kind !== 'audio') return
  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
    params.encodings[0]!.maxBitrate = isScreen ? SCREEN_AUDIO_MAX_BITRATE : VOICE_AUDIO_MAX_BITRATE
    // Voice is the thing you must not lose, so it outranks the film on the wire.
    ;(params.encodings[0] as { networkPriority?: RTCPriorityType }).networkPriority = 'high'
    params.encodings[0]!.priority = 'high'
    await sender.setParameters(params)
  } catch {
    /* harmless */
  }
}

/**
 * Deepen the receive buffer. WebRTC defaults to interactive-call latency and
 * sacrifices quality to stay low-delay — backwards for a film, where 400ms of
 * buffering is invisible and a stutter is not. The SAME value on audio and
 * video, or lip-sync breaks.
 */
/**
 * How long a receiver may buffer before playing, per kind.
 *
 * A film wants a deep buffer: 400ms of it is invisible, and it's the difference
 * between riding out a hiccup and stuttering. A conversation wants the
 * opposite — 400ms added to every sentence is the difference between talking to
 * someone and taking turns at them, and it stacks on top of the network delay
 * you already have.
 *
 * The old code set 400ms on every receiver, on the theory that mismatched
 * targets break lip-sync. That rule is real but narrower than it was applied:
 * it concerns a *synchronised pair* — one stream's audio against its own video.
 * The film's audio and picture share a stream and still both get 400ms. The
 * webcam is a different stream entirely, so giving it a short buffer can't
 * desynchronise anything, and stops the film's needs from taxing the chat.
 */
const BUFFER_MS = { screen: 400, webcam: 60 } as const

/** Set the target for one receiver, knowing which stream it belongs to. */
export function tuneReceiver(receiver: RTCRtpReceiver, kind: 'screen' | 'webcam'): void {
  try {
    const rx = receiver as unknown as Record<string, unknown>
    const ms = BUFFER_MS[kind]
    // Foot-gun: jitterBufferTarget is MILLISECONDS, the legacy playoutDelayHint
    // is SECONDS. Passing 400 to the latter would ask for 400 seconds.
    if ('jitterBufferTarget' in rx) rx.jitterBufferTarget = ms
    else if ('playoutDelayHint' in rx) rx.playoutDelayHint = ms / 1000
  } catch {
    /* unsupported — the default adaptive buffer is fine */
  }
}

/**
 * Fallback for receivers we haven't classified yet (they arrive before the
 * stream ids are known). Conservative: assume conversation, so nobody gets a
 * surprise 400ms of latency on their voice. onTrack re-tunes with the real
 * answer the moment it knows.
 */
export function applyReceiverBuffering(pc: RTCPeerConnection): void {
  for (const r of pc.getReceivers()) {
    if (r.track) tuneReceiver(r, 'webcam')
  }
}

/**
 * Getting quality back after a bad minute.
 *
 * WebRTC is good at falling and slow at climbing. Once congestion has forced the
 * encoder down, the estimator creeps back up over tens of seconds, and if the
 * encoder has dropped resolution it can stay there long after the network is
 * fine — the quality-parameter hysteresis that decides when to scale back up is
 * deliberately sluggish. The result people actually experience is: the film goes
 * bad for ten seconds and stays bad for the rest of the evening.
 *
 * Two settings do most of the work before this monitor is needed:
 * `degradationPreference: 'maintain-resolution'` makes pressure cost framerate,
 * which comes back the instant the pressure does; and no bitrate floor, so
 * congestion control is never fighting us.
 *
 * This is the safety net for the rest. It watches for a sender that is sending
 * a smaller picture than its source while the link plainly has room, and pokes
 * it back up. A `cpu` limitation is left alone — you cannot probe your way out
 * of a busy processor, which is what the H.264-first codec order is for.
 *
 * Returns a stop function.
 */
export function startSenderRecoveryMonitor(
  getSender: () => RTCRtpSender | null | undefined,
  getCeiling: () => number,
  intervalMs = 1500,
): () => void {
  // Two samples at 1.5s, then a 5s cooldown: quick enough that a viewer barely
  // registers the dip, slow enough that it can never oscillate.
  const STUCK_SAMPLES = 2
  const COOLDOWN_MS = 5000
  let stuck = 0
  let lastNudge = 0

  const timer = setInterval(async () => {
    const sender = getSender()
    if (!sender?.track) return
    let stats: RTCStatsReport
    try {
      stats = await sender.getStats()
    } catch {
      return
    }
    let out: Record<string, number | string> | undefined
    let pair: Record<string, number> | undefined
    stats.forEach((r) => {
      const rec = r as unknown as Record<string, never>
      if (r.type === 'outbound-rtp' && (rec as { kind?: string }).kind === 'video') out = rec
      if (r.type === 'candidate-pair' && (rec as { nominated?: boolean }).nominated) pair = rec
    })
    if (!out) return

    const settings = sender.track.getSettings()
    const sourcePixels = (settings.width ?? 1920) * (settings.height ?? 1080)
    const sentPixels = Number(out.frameWidth ?? 0) * Number(out.frameHeight ?? 0)
    const target = Number(out.targetBitrate ?? 0)
    const avail = Number(pair?.availableOutgoingBitrate ?? 0)
    const reason = String(out.qualityLimitationReason ?? 'none')

    const degraded = sentPixels > 0 && sentPixels < sourcePixels * 0.75
    const headroom = avail > 0 && target > 0 && avail > target * 1.25
    // Bandwidth-limited but the link has recovered, OR nothing is limiting it at
    // all and it simply hasn't climbed back — the sluggish-hysteresis case.
    const recoverable = degraded && ((reason === 'bandwidth' && headroom) || reason === 'none')

    stuck = recoverable ? stuck + 1 : 0
    if (stuck < STUCK_SAMPLES || Date.now() - lastNudge < COOLDOWN_MS) return

    stuck = 0
    lastNudge = Date.now()
    const ceiling = getCeiling()
    try {
      const p = sender.getParameters()
      const e = p.encodings?.[0]
      if (!e) return
      e.scaleResolutionDownBy = 1
      // Changing the value is what provokes a fresh bandwidth probe; setting it
      // to the same number is a no-op as far as the encoder is concerned.
      e.maxBitrate = ceiling - 1
      await sender.setParameters(p)
      const again = sender.getParameters()
      if (again.encodings?.[0]) {
        again.encodings[0].maxBitrate = ceiling
        again.encodings[0].scaleResolutionDownBy = 1
        await sender.setParameters(again)
      }
    } catch {
      /* transient — retried on the next eligible tick */
    }
  }, intervalMs)

  return () => clearInterval(timer)
}

/**
 * The ceiling a screen sender should aim at, given who's watching.
 *
 * A full mesh uploads the film once per viewer, so the budget divides. But the
 * film's video is not the only thing on the wire: each viewer also costs a
 * stereo audio stream for the film, a voice stream, and a camera. Dividing only
 * the video ceiling quietly oversubscribes the uplink by around 10% per viewer,
 * which is exactly the margin that decides whether congestion control is
 * comfortable or fighting.
 */
const PER_VIEWER_OVERHEAD =
  SCREEN_AUDIO_MAX_BITRATE + // the film's sound
  64_000 + // their voice coming back is not our upload, but ours going out is
  FACE_PROFILES.M.bitrate // our camera, at the usual size

export const screenCeiling = (viewers: number) => {
  const n = Math.max(1, viewers)
  const forVideo = SCREEN_VIDEO_MAX_BITRATE - PER_VIEWER_OVERHEAD * n
  return Math.max(SCREEN_VIDEO_FLOOR, Math.round(forVideo / n))
}
