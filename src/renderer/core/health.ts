import { signal } from '@preact/signals'

// When a film goes blocky, the first thing anyone wants to know is whose fault
// it is. Without an answer people blame the app, or each other, and there is
// nothing to act on. WebRTC already knows — it just never says.
//
// This turns getStats into one plain-English sentence. It runs only while a film
// is actually moving, at half the rate of a heartbeat, and stops the moment
// nothing is being shared.

export type Health = 'good' | 'limited-bandwidth' | 'limited-cpu' | 'poor-network'

export interface HealthReport {
  state: Health
  /** What we're sending, when we're the one sharing. */
  sending: { width: number; height: number; fps: number; kbps: number } | null
  /** What we're receiving, when someone else is. */
  receiving: { width: number; height: number; fps: number; kbps: number } | null
  /** Round trip, milliseconds. */
  rtt: number | null
  /** Whether the encoder is the hardware one. Software H.264 at 1080p is the
   *  difference between a warm laptop and a hot one. */
  hardwareEncode: boolean | null
}

export const health = signal<HealthReport | null>(null)

const POLL_MS = 2000
let timer: ReturnType<typeof setInterval> | null = null
let getConnections: () => RTCPeerConnection[] = () => []

export function watchHealth(source: () => RTCPeerConnection[]): void {
  getConnections = source
}

export function startHealth(): void {
  if (timer) return
  timer = setInterval(() => void sample(), POLL_MS)
}

export function stopHealth(): void {
  if (timer) clearInterval(timer)
  timer = null
  health.value = null
}

/** Bytes seen last time, so we can turn counters into a rate. */
const previous = new Map<string, { bytes: number; at: number }>()

async function sample(): Promise<void> {
  const connections = getConnections()
  if (!connections.length) return health.value && (health.value = null), undefined

  let limitation: string | null = null
  let sending: HealthReport['sending'] = null
  let receiving: HealthReport['receiving'] = null
  let rtt: number | null = null
  let hardwareEncode: boolean | null = null
  let lost = 0
  let total = 0

  for (const pc of connections) {
    let report: RTCStatsReport
    try {
      report = await pc.getStats()
    } catch {
      continue
    }

    report.forEach((entry) => {
      const stat = entry as unknown as Record<string, number | string | undefined>
      const kind = stat.kind

      if (entry.type === 'outbound-rtp' && kind === 'video') {
        const w = Number(stat.frameWidth ?? 0)
        // Ignore the camera; only the film is worth reporting on.
        if (w < 640) return
        const reason = String(stat.qualityLimitationReason ?? 'none')
        if (reason !== 'none') limitation = reason
        const impl = String(stat.encoderImplementation ?? '')
        if (impl) hardwareEncode = !/openh264|libvpx|libaom|software/i.test(impl)
        sending = {
          width: w,
          height: Number(stat.frameHeight ?? 0),
          fps: Math.round(Number(stat.framesPerSecond ?? 0)),
          kbps: rate(`out:${entry.id}`, Number(stat.bytesSent ?? 0)),
        }
      }

      if (entry.type === 'inbound-rtp' && kind === 'video') {
        const w = Number(stat.frameWidth ?? 0)
        if (w < 640) return
        receiving = {
          width: w,
          height: Number(stat.frameHeight ?? 0),
          fps: Math.round(Number(stat.framesPerSecond ?? 0)),
          kbps: rate(`in:${entry.id}`, Number(stat.bytesReceived ?? 0)),
        }
        lost += Number(stat.packetsLost ?? 0)
        total += Number(stat.packetsReceived ?? 0) + Number(stat.packetsLost ?? 0)
      }

      if (entry.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated) {
        const seconds = Number(stat.currentRoundTripTime ?? 0)
        if (seconds > 0) rtt = Math.round(seconds * 1000)
      }
    })
  }

  if (!sending && !receiving) {
    health.value = null
    return
  }

  const lossRatio = total > 0 ? lost / total : 0
  const state: Health =
    limitation === 'cpu'
      ? 'limited-cpu'
      : lossRatio > 0.03 || (rtt !== null && rtt > 400)
        ? 'poor-network'
        : limitation === 'bandwidth'
          ? 'limited-bandwidth'
          : 'good'

  health.value = { state, sending, receiving, rtt, hardwareEncode }
}

/** Counter → kbit/s, from the delta since the previous sample. */
function rate(key: string, bytes: number): number {
  const now = Date.now()
  const last = previous.get(key)
  previous.set(key, { bytes, at: now })
  if (!last || now <= last.at) return 0
  return Math.max(0, Math.round(((bytes - last.bytes) * 8) / (now - last.at)))
}

/** One sentence, for a person rather than an engineer. */
export function describe(report: HealthReport): string {
  switch (report.state) {
    case 'limited-cpu':
      return 'This computer is struggling to keep up with the encoding.'
    case 'limited-bandwidth':
      return 'Your connection is the limit right now — the picture is softer to keep it moving.'
    case 'poor-network':
      return 'The network is dropping packets. Expect the odd stutter.'
    default:
      return 'Everything looks healthy.'
  }
}
