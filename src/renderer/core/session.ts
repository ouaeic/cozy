import { Signal } from './signal.js'
import { deriveKey, deriveRoomId, derivePairSecret, freshSeed } from './crypto.js'
import { peerId as makePeerId } from './invite.js'
import { pickMicrophone } from './devices.js'
import {
  DEFAULT_SIGNAL_URL,
  STUN_SERVERS,
  type Handshake,
  type PeerMessage,
  type StreamMap,
} from './protocol.js'
import {
  applyReceiverBuffering,
  tuneReceiver,
  MAX_SHARE_WIDTH,
  MAX_SHARE_HEIGHT,
  configureAudioSender,
  configureVideoSender,
  mungeSdp,
  preferVideoCodecs,
  startSenderRecoveryMonitor,
  screenCeiling,
} from './quality.js'
import type { FaceSize, Settings } from '../../shared/types.js'

export type StreamKind = 'webcam' | 'screen'
export type Status =
  | 'idle'
  | 'waiting'
  | 'connecting'
  | 'connected'
  | 'trouble'
  /** The signalling server itself is unreachable — nobody can arrive. */
  | 'unreachable'
  | 'left'

// The webcam is opened for talking, so all the speech processing stays ON. The
// captured movie audio gets the opposite treatment (see startShare) because
// noise suppression and AGC mangle music.
const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 },
  video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, facingMode: 'user' },
}

/**
 * And the exact opposite for the film. Left to itself Chromium hands back a
 * MONO track with echo cancellation, noise suppression and automatic gain all
 * switched on — three algorithms tuned for a person talking, which between them
 * flatten a soundtrack into something thin and lifeless. Every one of them off,
 * in stereo, at 48kHz.
 */
/**
 * Cap what we hand the encoder. A 4K panel, or a Mac running a scaled
 * resolution, produces four to eight million pixels per frame; squeezing that
 * into the same few megabits looks worse than 1080p does, costs far more to
 * encode, and gives congestion control much further to fall. Films are 1080p.
 */
const SCREEN_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { max: MAX_SHARE_WIDTH },
  height: { max: MAX_SHARE_HEIGHT },
  frameRate: { max: 30 },
}

const SCREEN_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
  sampleRate: 48000,
}

/** How long a socket-level `bye` is given to turn out to be nothing. */
const SOCKET_BYE_GRACE_MS = 15_000

// We used to close the signalling socket ~20s after going peer-to-peer, on the
// theory that the server had no job left. It was wrong twice over: a third
// person could never be discovered (the server only relays to *connected*
// sockets, so they'd wait forever on an empty room), and neither could someone
// rejoining after a crash. It also meant a peer leaving was invisible, because
// `bye` comes from the server.
//
// The socket stays open now. On Cloudflare that costs nothing — hibernated
// Durable Object sockets aren't billed for duration, which is the entire point
// of the hibernation API — and on the client it's a keepalive every 30s. The
// saving was never real; the bugs were.
//
// What *does* still avoid the server is the traffic that matters: once a
// DataChannel is up, renegotiation, mute state, quality hints and pairing all
// go directly peer-to-peer (see sendSignal).
/** How long a connection may stay broken before we admit there's a problem and
 *  offer the user the TURN conversation. */
const TROUBLE_AFTER_MS = 12_000

interface Peer {
  id: string
  pc: RTCPeerConnection
  dc: RTCDataChannel | null
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  settingAnswer: boolean
  remote: StreamMap
  pending: RTCIceCandidateInit[]
  camSender: RTCRtpSender | null
  micSender: RTCRtpSender | null
  screenVideoSender: RTCRtpSender | null
  screenAudioSender: RTCRtpSender | null
  stopRecovery: (() => void) | null
  /** The size this peer says it's drawing us at — drives our encoder. */
  wants: FaceSize
  /** Which incoming audio track is their microphone, as opposed to the film. */
  voiceTrackId: string | null
  name: string
  troubleTimer: ReturnType<typeof setTimeout> | null
  /** Set while a server-side `bye` is being treated as advisory. */
  byeTimer: ReturnType<typeof setTimeout> | null
}

export interface SessionEvents {
  onStatus: (status: Status) => void
  onRemoteStream: (peerId: string, stream: MediaStream, kind: StreamKind) => void
  onRemoteStreamGone: (peerId: string, kind: StreamKind) => void
  onPeerHello: (
    peerId: string,
    info: { name: string; avatarSeed: string; pairSecret: string },
  ) => void
  onPeerMedia: (peerId: string, media: { mic: boolean; cam: boolean }) => void
  onPeerSharing: (peerId: string, sharing: boolean) => void
  onPeerGone: (peerId: string) => void
  /** Someone wants to take over the screen. Only ever fires on the sharer. */
  onShareRequest: (peerId: string, name: string) => void
  /** The current sharer stood aside; the screen is ours. */
  onShareGranted: () => void
  onShareDenied: (name: string) => void
  /** Two shares started at once and we lost the tie-break. */
  onShareTakenOver: () => void
  /** Direct connection is not happening. The UI offers BYO TURN. */
  onConnectionTrouble: () => void
  onLocalShareEnded: () => void
  /** The captured surface is producing black frames — almost always DRM. */
  onShareLooksBlank: () => void
  /** The captured audio track is alive but every sample is digital zero. */
  onShareIsSilent: () => void
  onNotice: (message: string) => void
}

export class Session {
  private signal: Signal | null = null
  private peers = new Map<string, Peer>()
  private selfId = makePeerId()
  private emitted = new Map<string, string>()

  private camera: MediaStream | null = null
  private screen: MediaStream | null = null

  private name = ''
  private avatarSeed = ''
  private micOn = true
  private camOn = true
  private onBattery = false
  private left = false
  /** Our half of the durable pair secret, regenerated per call. */
  private pairSeed = freshSeed()

  constructor(private events: SessionEvents) {}

  // ------------------------------------------------------------- lifecycle

  async join(secret: string, settings: Settings): Promise<void> {
    // Joining a second room without closing the first leaves a live socket
    // behind, still relaying us into a room we've walked out of.
    this.signal?.close()
    this.signal = null
    this.left = false
    this.pairSeed = freshSeed()
    this.name = settings.name || 'Someone'
    this.avatarSeed = settings.partner?.avatarSeed ?? ''
    this.onBattery = await window.cozy.onBatteryPower().catch(() => false)

    const [roomId, key] = await Promise.all([deriveRoomId(secret), deriveKey(secret)])
    const signal = new Signal(settings.signalUrl || DEFAULT_SIGNAL_URL, roomId, this.selfId, key)
    this.signal = signal
    this.iceServers = settings.turn
      ? [...STUN_SERVERS, { urls: settings.turn.urls, username: settings.turn.username, credential: settings.turn.credential }]
      : STUN_SERVERS

    signal.onPeers = (ids) => {
      // Nobody here yet is the normal case — you got here first. But only say
      // so if we genuinely have no one: this also fires when the socket
      // reconnects mid-call, and reporting 'waiting' then would put a working
      // call into "Reconnecting…" with the controls disabled.
      if (this.peers.size === 0) this.events.onStatus(ids.length ? 'connecting' : 'waiting')
      for (const id of ids) this.ensurePeer(id)
    }
    signal.onJoin = (id) => {
      this.events.onStatus('connecting')
      this.ensurePeer(id)
    }
    signal.onBye = (id) => this.onSignalBye(id)
    signal.onHandshake = (from, msg) => void this.onHandshake(from, msg)
    signal.onStatus = (s, failures) => {
      if (this.peers.size > 0) return // a live call doesn't care; media is direct
      if (s === 'connecting') this.events.onStatus('connecting')
      // Two failures in a row is no longer "the network hiccuped". Before this,
      // a wrong URL, an undeployed Worker, or no internet at all produced a
      // screen identical to a healthy wait — on BOTH machines, forever, so each
      // person concluded the other one was doing it wrong.
      if (s === 'closed' && failures >= 2) this.events.onStatus('unreachable')
    }
    signal.onRejected = (reason) => this.events.onNotice(reason)

    signal.open()
  }

  private iceServers: RTCIceServer[] = STUN_SERVERS

  leave(): void {
    this.left = true
    // Say goodbye directly first. The server's `bye` would arrive too, but this
    // is instant and survives the server being unreachable.
    this.broadcast({ k: 'bye' })
    for (const peer of this.peers.values()) this.teardownPeer(peer)
    this.peers.clear()
    this.emitted.clear()
    this.signal?.close()
    this.signal = null
    this.camera?.getTracks().forEach((t) => t.stop())
    this.screen?.getTracks().forEach((t) => t.stop())
    this.camera = null
    this.screen = null
    this.events.onStatus('left')
  }

  // ----------------------------------------------------------------- media

  /** Set when we moved off the default mic to protect playback quality. */
  micNotice: string | null = null

  /** True when the OS let us mute local playback, so Cozy owns the film's
   *  sound for the sharer too (and can duck it for them). False on Windows. */
  filmPlaysThroughMixer = false

  async openCamera(
    mic: boolean,
    cam: boolean,
    options: {
      preferredMic?: string | null
      preferredCamera?: string | null
      protectPlayback?: boolean
    } = {},
  ): Promise<MediaStream> {
    this.micOn = mic
    this.camOn = cam
    this.micNotice = null
    // Reopening (changing microphone mid-call, or coming back from a leave)
    // without stopping the old capture leaves the camera light on and another
    // live device handle behind, every time.
    const previous = this.camera
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: CAMERA_CONSTRAINTS.audio,
        video: options.preferredCamera
          ? {
              ...(CAMERA_CONSTRAINTS.video as MediaTrackConstraints),
              deviceId: { exact: options.preferredCamera },
            }
          : CAMERA_CONSTRAINTS.video,
      })
      this.camera = stream

      // Device labels and groupIds only become readable once permission has been
      // granted, which the call above just did — so the choice has to happen
      // after the first open, not before it.
      const choice = await pickMicrophone(
        options.preferredMic ?? null,
        options.protectPlayback ?? true,
      )
      if (choice.deviceId) {
        const swapped = await this.swapMicrophone(stream, choice.deviceId)
        if (swapped && choice.reason === 'headset-would-downgrade-audio') {
          this.micNotice = `Using ${choice.label} so your headphones stay in full stereo.`
        }
      }

      stream.getAudioTracks().forEach((t) => (t.enabled = mic))
      stream.getVideoTracks().forEach((t) => (t.enabled = cam))

      // Hand the new tracks to anyone already connected — unconditionally, not
      // only when a specific device was chosen. Going back to "choose
      // automatically" used to leave every peer on the previously selected
      // microphone while the settings screen said otherwise.
      //
      // And not only when there WAS a previous stream. Someone whose camera
      // failed at startup joins with null senders, because ensurePeer only adds
      // tracks `if (this.camera)`. replaceTrack on a null sender does nothing,
      // so closing FaceTime and picking your camera again fixed your own
      // preview and left the other person looking at a still avatar all
      // evening. addTrack is the only thing that recovers it, and it fires
      // onnegotiationneeded so the far end actually finds out.
      const video = stream.getVideoTracks()[0] ?? null
      const audio = stream.getAudioTracks()[0] ?? null
      for (const peer of this.peers.values()) {
        if (video) {
          if (peer.camSender) await peer.camSender.replaceTrack(video).catch(() => {})
          else peer.camSender = peer.pc.addTrack(video, stream)
        }
        if (audio) {
          if (peer.micSender) await peer.micSender.replaceTrack(audio).catch(() => {})
          else peer.micSender = peer.pc.addTrack(audio, stream)
        }
      }
      if (previous && previous !== stream) {
        previous.getTracks().forEach((t) => t.stop())
      }
      return stream
    } catch (err) {
      throw friendlyMediaError(err)
    }
  }

  /** Replace the audio track in place, keeping the same stream identity. */
  private async swapMicrophone(stream: MediaStream, deviceId: string): Promise<boolean> {
    try {
      const fresh = await navigator.mediaDevices.getUserMedia({
        audio: { ...(CAMERA_CONSTRAINTS.audio as MediaTrackConstraints), deviceId: { exact: deviceId } },
      })
      const next = fresh.getAudioTracks()[0]
      if (!next) return false
      for (const old of stream.getAudioTracks()) {
        stream.removeTrack(old)
        old.stop()
      }
      stream.addTrack(next)
      for (const peer of this.peers.values()) {
        if (peer.micSender) await peer.micSender.replaceTrack(next).catch(() => {})
      }
      return true
    } catch {
      return false // the preferred device vanished; the default is still fine
    }
  }

  /** Adopt the stream the home screen already opened for its preview, rather
   *  than stopping and reopening the device (which races on Windows). */
  adoptCamera(stream: MediaStream): void {
    this.camera = stream
  }

  getCamera(): MediaStream | null {
    return this.camera
  }

  setMic(on: boolean): void {
    this.micOn = on
    this.camera?.getAudioTracks().forEach((t) => (t.enabled = on))
    this.broadcast({ k: 'media', mic: on, cam: this.camOn })
  }

  setCam(on: boolean): void {
    this.camOn = on
    this.camera?.getVideoTracks().forEach((t) => (t.enabled = on))
    this.broadcast({ k: 'media', mic: this.micOn, cam: on })
  }

  setOnBattery(onBattery: boolean): void {
    if (this.onBattery === onBattery) return
    this.onBattery = onBattery
    for (const peer of this.peers.values()) void this.applyEncodings(peer)
  }

  /** Tell the far end how big we're drawing them, so they can stop encoding
   *  pixels we'll only throw away. */
  requestFaceSize(size: FaceSize): void {
    this.broadcast({ k: 'want', size })
  }

  // ----------------------------------------------------------------- share

  async startShare(sourceId: string, withAudio: boolean): Promise<MediaStream> {
    // Ask main to answer the next getDisplayMedia with this source, and with
    // system loopback audio. 'muteLocal' silences our own speakers so Cozy can
    // be the thing mixing the film back in — that's what lets ducking work for
    // the person sharing, not just the person watching.
    // Comes back false where muting local playback isn't safe (Windows mutes
    // the whole endpoint), in which case the sharer keeps hearing the film from
    // their own speakers and we must NOT also play it — see main/capture.ts.
    this.filmPlaysThroughMixer = await window.cozy.armCapture(sourceId, withAudio, withAudio)

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_VIDEO_CONSTRAINTS,
        // Audio must be requested here even though main decides the routing —
        // on macOS this is what triggers the OS audio permission path.
        audio: withAudio ? SCREEN_AUDIO_CONSTRAINTS : false,
      })
    } catch (err) {
      throw friendlyMediaError(err)
    }

    // If loopbackWithMute produced a silent track we'd have muted the user's
    // speakers for nothing. Re-arm without the mute and try once more.
    //
    // Only worth doing if we actually asked for the mute. Where we didn't —
    // Windows, and the browser build — a missing audio track was never caused
    // by muting, so re-arming cannot fix it and the second getDisplayMedia
    // would just put the picker in front of the user again for nothing.
    if (withAudio && stream.getAudioTracks().length === 0 && this.filmPlaysThroughMixer) {
      stream.getTracks().forEach((t) => t.stop())
      this.filmPlaysThroughMixer = false
      await window.cozy.armCapture(sourceId, true, false)
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: SCREEN_VIDEO_CONSTRAINTS,
        audio: SCREEN_AUDIO_CONSTRAINTS,
      })
      if (stream.getAudioTracks().length === 0) {
        this.events.onNotice(
          "Couldn't capture the sound from that window. The picture will still go through.",
        )
      }
    } else if (withAudio && stream.getAudioTracks().length === 0) {
      this.events.onNotice(
        "Couldn't capture the sound from that window. The picture will still go through.",
      )
    }

    this.screen = stream
    const video = stream.getVideoTracks()[0]
    if (video) {
      video.contentHint = 'motion'
      video.addEventListener('ended', () => {
        void this.stopShare()
        this.events.onLocalShareEnded()
      })
    }

    for (const peer of this.peers.values()) this.addScreenTracks(peer)
    this.broadcast({ k: 'sharing', on: true })
    window.cozy.setCallState({ connected: this.peers.size > 0, sharing: true, micOn: this.micOn })

    void this.checkForBlankCapture(stream)
    void this.checkForSilentCapture(stream)
    return stream
  }

  async stopShare(): Promise<void> {
    if (!this.screen) return
    this.screen.getTracks().forEach((t) => t.stop())
    this.screen = null

    for (const peer of this.peers.values()) {
      peer.stopRecovery?.()
      peer.stopRecovery = null
      for (const sender of [peer.screenVideoSender, peer.screenAudioSender]) {
        if (!sender) continue
        try {
          peer.pc.removeTrack(sender)
        } catch {
          /* already gone */
        }
      }
      peer.screenVideoSender = null
      peer.screenAudioSender = null
    }

    this.broadcast({ k: 'sharing', on: false })
    window.cozy.setCallState({ connected: this.peers.size > 0, sharing: false, micOn: this.micOn })
  }

  getScreen(): MediaStream | null {
    return this.screen
  }

  private peerName(id: string): string {
    return this.peers.get(id)?.name ?? 'They'
  }

  /** Ask whoever is sharing to stand aside. */
  requestShare(myName: string): void {
    this.broadcast({ k: 'share-request', name: myName })
  }

  /** Stop sharing and hand the screen to whoever asked. Order matters: our
   *  share has to be down before theirs comes up, or both are briefly live.
   *  Returns false if they're no longer here, in which case we keep ours. */
  async grantShare(peerId: string): Promise<boolean> {
    // Check BEFORE stopping. Otherwise a requester who left in the meantime
    // costs everyone else the film for nothing.
    const peer = this.peers.get(peerId)
    if (!peer) return false
    await this.stopShare()
    this.send(peer, { k: 'share-granted' })
    return true
  }

  denyShare(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) this.send(peer, { k: 'share-denied' })
  }

  /**
   * Netflix, Disney+ and friends deliberately hand a black picture to any
   * screen recorder. Rather than let two people stare at a black rectangle
   * wondering whose internet is broken, sample a frame and say so.
   */
  private async checkForBlankCapture(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0]
    if (!track) return
    const video = document.createElement('video')
    video.srcObject = new MediaStream([track])
    video.muted = true
    try {
      await video.play()
      // Two samples: one early, one after the source has had time to settle.
      for (const delay of [1500, 4000]) {
        await new Promise((r) => setTimeout(r, delay))
        if (this.screen !== stream) return // share already stopped
        if (!isBlank(video)) return
      }
      this.events.onShareLooksBlank()
    } catch {
      /* can't sample it; assume it's fine rather than nag */
    } finally {
      video.pause()
      video.srcObject = null
    }
  }

  /**
   * System audio capture fails in the nastiest possible way: you get a live
   * track, at the right sample rate, delivering frames on schedule, and every
   * single sample is zero. No error, no warning — the film just arrives silent
   * at the other end and neither of you knows why. (On macOS the usual cause is
   * the OS not having granted audio recording to the app.)
   *
   * So: watch the first few seconds of real frames. Exact digital zero
   * throughout means the tap is dead, not that the room is quiet — genuinely
   * quiet audio still dithers above zero.
   */
  private async checkForSilentCapture(stream: MediaStream): Promise<void> {
    const track = stream.getAudioTracks()[0]
    if (!track || typeof MediaStreamTrackProcessor === 'undefined') return

    const deadline = Date.now() + 9000
    try {
      const reader = new MediaStreamTrackProcessor({ track }).readable.getReader()
      let frames = 0
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done || !value) break
        frames++
        const samples = new Float32Array(value.numberOfFrames)
        try {
          value.copyTo(samples, { planeIndex: 0, format: 'f32-planar' })
        } catch {
          value.close()
          continue
        }
        value.close()
        for (const sample of samples) {
          if (sample !== 0) {
            void reader.cancel()
            return // sound is flowing; nothing to say
          }
        }
      }
      void reader.cancel()
      // Only speak up if the track was actually running. Few frames means the
      // share ended before we could tell.
      if (frames > 40 && this.screen === stream) this.events.onShareIsSilent()
    } catch {
      /* unable to sample — better to say nothing than to cry wolf */
    }
  }

  // ------------------------------------------------------------------ peers

  private ensurePeer(id: string): Peer {
    const existing = this.peers.get(id)
    if (existing) {
      // A dead connection cannot be renegotiated back to life — its m-lines no
      // longer match what the other side is about to offer, and the failure is
      // silent. Start again instead of handing back a corpse.
      const dead = existing.pc.connectionState === 'failed' || existing.pc.connectionState === 'closed'
      if (!dead) {
        // They're back before the grace period expired.
        if (existing.byeTimer) {
          clearTimeout(existing.byeTimer)
          existing.byeTimer = null
        }
        return existing
      }
      this.dropPeer(id)
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers, iceCandidatePoolSize: 4 })
    const peer: Peer = {
      id,
      pc,
      dc: null,
      // Deterministic and symmetric: exactly one side is impolite.
      polite: this.selfId > id,
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      remote: { webcam: null, screen: null },
      pending: [],
      camSender: null,
      micSender: null,
      screenVideoSender: null,
      screenAudioSender: null,
      stopRecovery: null,
      wants: 'M',
      voiceTrackId: null,
      name: 'Someone',
      troubleTimer: null,
      byeTimer: null,
    }
    this.peers.set(id, peer)

    // Pre-negotiated channel: both sides open the same id, so there's no
    // in-band handshake and it's usable the moment the transport is up.
    peer.dc = pc.createDataChannel('cozy', { negotiated: true, id: 0, ordered: true })
    peer.dc.onopen = () => this.onChannelOpen(peer)
    peer.dc.onmessage = (event) => void this.onPeerMessage(peer, String(event.data))

    if (this.camera) {
      for (const track of this.camera.getTracks()) {
        const sender = pc.addTrack(track, this.camera)
        if (track.kind === 'video') peer.camSender = sender
        else peer.micSender = sender
      }
    }
    if (this.screen) this.addScreenTracks(peer)

    preferVideoCodecs(pc)

    // The screen ceiling is divided between viewers, so an arrival changes what
    // everyone else should be sending.
    this.reapplyAll()

    pc.onnegotiationneeded = () => void this.makeOffer(peer)
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) void this.sendSignal(peer, { k: 'ice', c: candidate.toJSON() })
    }
    pc.ontrack = (event) => this.onTrack(peer, event)
    pc.onconnectionstatechange = () => this.onConnectionState(peer)
    pc.oniceconnectionstatechange = () => this.onIceState(peer)

    return peer
  }

  private onChannelOpen(peer: Peer): void {
    this.events.onStatus('connected')
    this.send(peer, {
      k: 'hello',
      name: this.name,
      avatarSeed: this.avatarSeed,
      pairSeed: this.pairSeed,
    })
    this.send(peer, { k: 'media', mic: this.micOn, cam: this.camOn })
    if (this.screen) this.send(peer, { k: 'sharing', on: true })
    window.cozy.setCallState({ connected: true, sharing: !!this.screen, micOn: this.micOn })
  }

  private async onPeerMessage(peer: Peer, raw: string): Promise<void> {
    let msg: PeerMessage
    try {
      msg = JSON.parse(raw) as PeerMessage
    } catch {
      return
    }

    switch (msg.k) {
      case 'offer':
      case 'answer':
      case 'ice':
        await this.onHandshake(peer.id, msg)
        break
      case 'hello': {
        peer.name = msg.name
        // Combine both halves into the secret we'll remember them by. Falls
        // back to our own seed if an older build sends no half, which still
        // beats reusing the short invite.
        const pairSecret = await derivePairSecret(this.pairSeed, msg.pairSeed ?? this.pairSeed)
        this.events.onPeerHello(peer.id, {
          name: msg.name,
          avatarSeed: msg.avatarSeed,
          pairSecret,
        })
        break
      }
      case 'media':
        this.events.onPeerMedia(peer.id, { mic: msg.mic, cam: msg.cam })
        break
      case 'sharing':
        this.events.onPeerSharing(peer.id, msg.on)
        // Backstop for a race the request/accept flow shouldn't allow: if two
        // shares ever overlap, the higher peer id yields. Deterministic and
        // symmetric, so exactly one of us stops and we can't deadlock.
        if (msg.on && this.screen && this.selfId > peer.id) {
          // Route through the app rather than stopping here: the UI owns the
          // "sharing" flag, the local film playback and the wake lock, and
          // tearing the share down behind its back desyncs all three.
          this.events.onShareTakenOver()
        }
        break
      case 'bye':
        this.dropPeer(peer.id)
        break
      case 'share-request':
        // Only the person actually sharing can answer — but ALWAYS answer.
        // Staying silent leaves the asker's Share button disabled forever.
        if (this.screen) this.events.onShareRequest(peer.id, msg.name)
        else this.send(peer, { k: 'share-denied' })
        break
      case 'share-granted':
        this.events.onShareGranted()
        break
      case 'share-denied':
        this.events.onShareDenied(this.peerName(peer.id))
        break
      case 'want':
        if (peer.wants !== msg.size) {
          peer.wants = msg.size
          void this.applyEncodings(peer)
        }
        break
      case 'speaking':
        break
    }
  }

  /** Prefer the direct channel; fall back to the server only while it's down. */
  private async sendSignal(peer: Peer, msg: Handshake): Promise<void> {
    if (peer.dc?.readyState === 'open') {
      peer.dc.send(JSON.stringify(msg))
      return
    }
    if (!this.signal?.isOpen) this.signal?.open()
    await this.signal?.send(peer.id, msg)
  }

  private send(peer: Peer, msg: PeerMessage): void {
    if (peer.dc?.readyState === 'open') peer.dc.send(JSON.stringify(msg))
  }

  private broadcast(msg: PeerMessage): void {
    for (const peer of this.peers.values()) this.safeSend(peer, msg)
  }

  /** A channel can go from open to closing between the check and the send. */
  private safeSend(peer: Peer, msg: PeerMessage): void {
    try {
      this.send(peer, msg)
    } catch {
      /* that peer is on its way out; the others still get the message */
    }
  }

  // ---------------------------------------------------------- negotiation

  private streams(): StreamMap {
    return { webcam: this.camera?.id ?? null, screen: this.screen?.id ?? null }
  }

  private async makeOffer(peer: Peer): Promise<void> {
    if (peer.makingOffer) return
    try {
      peer.makingOffer = true
      const offer = await peer.pc.createOffer()
      // Checking signalingState here is necessary but not sufficient: the peer
      // connection has its own internal operations queue, so a remote offer can
      // already be queued ahead of us and will have moved the state on by the
      // time setLocalDescription actually runs. Hence the catch below.
      if (peer.pc.signalingState !== 'stable') return
      offer.sdp = mungeSdp(offer.sdp)
      await peer.pc.setLocalDescription(offer)
      await this.sendSignal(peer, {
        k: 'offer',
        sdp: peer.pc.localDescription!.sdp,
        streams: this.streams(),
      })
      void this.applyEncodings(peer)
    } catch (err) {
      // Glare: their offer reached the queue first. That's not a failure —
      // Perfect Negotiation resolves it, we answer theirs instead, and because
      // addTrack has already created our m-lines our own new tracks are
      // negotiated in that answer anyway. Nothing is lost by dropping this one.
      if (!(err instanceof DOMException && err.name === 'InvalidStateError')) {
        console.error('[session] offer failed', err)
      }
    } finally {
      peer.makingOffer = false
    }
  }

  private async onHandshake(from: string, msg: Handshake): Promise<void> {
    if (this.left) return
    const peer = this.ensurePeer(from)

    if (msg.k === 'ice') {
      try {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.c)
        else peer.pending.push(msg.c)
      } catch (err) {
        if (!peer.ignoreOffer) console.warn('[session] addIceCandidate', err)
      }
      return
    }

    // Perfect Negotiation: the polite peer rolls back on a collision, the
    // impolite one ignores the incoming offer. Nobody deadlocks.
    const description: RTCSessionDescriptionInit = { type: msg.k, sdp: msg.sdp }
    const readyForOffer =
      !peer.makingOffer && (peer.pc.signalingState === 'stable' || peer.settingAnswer)
    const collision = description.type === 'offer' && !readyForOffer
    peer.ignoreOffer = !peer.polite && collision
    if (peer.ignoreOffer) return

    // Set BEFORE setRemoteDescription so ontrack can tell a face from a film.
    peer.remote = msg.streams

    try {
      if (description.type === 'answer') peer.settingAnswer = true
      await peer.pc.setRemoteDescription(description)

      const pending = peer.pending
      peer.pending = []
      for (const candidate of pending) {
        try {
          await peer.pc.addIceCandidate(candidate)
        } catch {
          /* stale candidate */
        }
      }

      if (description.type === 'offer') {
        applyReceiverBuffering(peer.pc)
        const answer = await peer.pc.createAnswer()
        answer.sdp = mungeSdp(answer.sdp)
        await peer.pc.setLocalDescription(answer)
        await this.sendSignal(peer, {
          k: 'answer',
          sdp: peer.pc.localDescription!.sdp,
          streams: this.streams(),
        })
      } else {
        applyReceiverBuffering(peer.pc)
      }
      void this.applyEncodings(peer)
    } catch (err) {
      console.error('[session] handshake failed', err)
    } finally {
      // Must clear on the failure path too. Left true, `readyForOffer` is
      // permanently true, so the impolite side stops ignoring colliding offers
      // and both ends ping-pong rollbacks at each other.
      peer.settingAnswer = false
    }
  }

  private onTrack(peer: Peer, event: RTCTrackEvent): void {
    const track = event.track
    const stream = event.streams[0] ?? new MediaStream([track])
    const kind: StreamKind =
      peer.remote.screen && stream.id === peer.remote.screen ? 'screen' : 'webcam'

    // Remember which audio track is their voice so the mixer meters the right
    // one — see voiceReceiver().
    if (kind === 'webcam' && track.kind === 'audio') peer.voiceTrackId = track.id

    // Now that we know whether this is the film or a face, give it the right
    // buffer: deep for a film, short for a conversation.
    if (event.receiver) tuneReceiver(event.receiver, kind)

    this.emit(peer.id, stream, kind)
    track.onunmute = () => this.emit(peer.id, stream, kind, true)
    track.onended = () => {
      if (stream.getTracks().every((t) => t.readyState === 'ended')) {
        this.emitted.delete(`${peer.id}:${kind}`)
        this.events.onRemoteStreamGone(peer.id, kind)
      }
    }
  }

  private emit(peerId: string, stream: MediaStream, kind: StreamKind, force = false): void {
    const key = `${peerId}:${kind}`
    if (!force && this.emitted.get(key) === stream.id) return
    this.emitted.set(key, stream.id)
    this.events.onRemoteStream(peerId, stream, kind)
  }

  // ---------------------------------------------------------- connectivity

  private onConnectionState(peer: Peer): void {
    const state = peer.pc.connectionState
    if (state === 'connected') {
      this.clearTrouble(peer)
      this.events.onStatus('connected')
    } else if (state === 'failed' || state === 'disconnected') {
      // Direct path is gone: we need the introduction service again to
      // exchange fresh candidates.
      this.signal?.open()
      this.startTrouble(peer)
    }
  }

  private onIceState(peer: Peer): void {
    const state = peer.pc.iceConnectionState
    if (state === 'failed') {
      this.signal?.open()
      try {
        peer.pc.restartIce()
      } catch {
        /* unsupported */
      }
      this.startTrouble(peer)
    } else if (state === 'connected' || state === 'completed') {
      this.clearTrouble(peer)
      // An ICE restart's renegotiation drops senders back to WebRTC defaults
      // (~2.5 Mbps, no degradation preference), so re-assert ours.
      void this.applyEncodings(peer)
    }
  }

  private startTrouble(peer: Peer): void {
    if (peer.troubleTimer) return
    peer.troubleTimer = setTimeout(() => {
      peer.troubleTimer = null
      if (peer.pc.connectionState === 'connected') return
      this.events.onStatus('trouble')
      this.events.onConnectionTrouble()
    }, TROUBLE_AFTER_MS)
  }

  private clearTrouble(peer: Peer): void {
    if (peer.troubleTimer) clearTimeout(peer.troubleTimer)
    peer.troubleTimer = null
  }

  // -------------------------------------------------------------- encoders

  private addScreenTracks(peer: Peer): void {
    if (!this.screen) return
    const video = this.screen.getVideoTracks()[0]
    const audio = this.screen.getAudioTracks()[0]
    if (video) {
      peer.screenVideoSender = peer.pc.addTrack(video, this.screen)
      peer.stopRecovery?.()
      peer.stopRecovery = startSenderRecoveryMonitor(
        () => peer.screenVideoSender,
        () => screenCeiling(this.peers.size),
      )
    }
    if (audio) peer.screenAudioSender = peer.pc.addTrack(audio, this.screen)
    // addTrack just created new transceivers. Codec preferences are per
    // transceiver, so without this the film — the one stream the H.264-first
    // policy exists for — would negotiate on Chromium's defaults in the normal
    // join-then-share order.
    preferVideoCodecs(peer.pc)
  }

  /** Someone joined or left: everyone's share of the uplink just changed. */
  private reapplyAll(): void {
    for (const peer of this.peers.values()) void this.applyEncodings(peer)
  }

  /**
   * The biggest tile anyone is drawing us at.
   *
   * There is one camera track, shared by every peer connection, so
   * `applyConstraints` on it is global — but `wants` is per peer. Applying each
   * peer's request in turn means the last one processed wins, and someone who
   * asked for a large tile silently gets whatever the person after them asked
   * for. Capture at the largest anyone needs; the per-peer `maxBitrate` in
   * setParameters is what actually tailors each stream.
   */
  private largestWanted(): FaceSize {
    let best: FaceSize = 'S'
    for (const peer of this.peers.values()) {
      if (peer.wants === 'L') return 'L'
      if (peer.wants === 'M') best = 'M'
    }
    return best
  }

  private async applyEncodings(peer: Peer): Promise<void> {
    const captureSize = this.largestWanted()
    for (const sender of peer.pc.getSenders()) {
      if (!sender.track) continue
      if (sender.track.kind === 'video') {
        const isScreen = sender === peer.screenVideoSender
        await configureVideoSender(sender, {
          kind: isScreen ? 'screen' : 'webcam',
          faceSize: peer.wants,
          captureSize,
          onBattery: this.onBattery,
          viewers: this.peers.size,
        })
      } else {
        await configureAudioSender(sender, sender === peer.screenAudioSender)
      }
    }
  }

  // -------------------------------------------------------------- teardown

  /**
   * The server says a socket closed. That is not the same as a person leaving.
   *
   * A laptop lid, a Wi-Fi handover, a captive portal, or the signalling server
   * itself restarting all close sockets while the peer connection carries on
   * perfectly well — media flows directly and never touched the server. Acting
   * on it immediately tore down a healthy call, and left the two ends
   * mismatched: the side that blipped never received a `bye`, so it kept its
   * RTCPeerConnection, and the fresh offer from the other side then failed
   * setRemoteDescription on m-line order and was swallowed.
   *
   * A real goodbye comes over the data channel (see `leave`), and is acted on
   * at once. This one waits to see whether the connection actually dies.
   */
  private onSignalBye(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return

    const state = peer.pc.connectionState
    if (state !== 'connected' && state !== 'connecting') return this.dropPeer(id)
    if (peer.byeTimer) return

    peer.byeTimer = setTimeout(() => {
      peer.byeTimer = null
      if (!this.peers.has(id)) return
      if (peer.pc.connectionState !== 'connected') this.dropPeer(id)
    }, SOCKET_BYE_GRACE_MS)
  }

  private dropPeer(id: string): void {
    const peer = this.peers.get(id)
    if (!peer) return
    this.teardownPeer(peer)
    this.peers.delete(id)
    this.emitted.delete(`${id}:webcam`)
    this.emitted.delete(`${id}:screen`)
    this.events.onRemoteStreamGone(id, 'webcam')
    this.events.onRemoteStreamGone(id, 'screen')
    this.events.onPeerGone(id)
    this.reapplyAll() // fewer viewers, so more bitrate each
    if (this.peers.size === 0) {
      // Alone again — we need the server back to hear about a return.
      this.signal?.open()
      this.events.onStatus('waiting')
      window.cozy.setCallState({ connected: false, sharing: !!this.screen, micOn: this.micOn })
    }
  }

  private teardownPeer(peer: Peer): void {
    if (peer.troubleTimer) clearTimeout(peer.troubleTimer)
    if (peer.byeTimer) clearTimeout(peer.byeTimer)
    peer.stopRecovery?.()
    try {
      peer.dc?.close()
      peer.pc.close()
    } catch {
      /* already gone */
    }
  }

  /**
   * The receiver carrying this person's *microphone*, for the mixer's level
   * metering. Picking "the first live audio receiver" would grab the shared
   * film's audio whenever someone is sharing — and then the film would duck
   * itself every time it got loud.
   */
  /** Live peer connections, for the health readout. */
  connections(): RTCPeerConnection[] {
    return [...this.peers.values()].map((p) => p.pc)
  }

  voiceReceiver(peerId: string): RTCRtpReceiver | null {
    const peer = this.peers.get(peerId)
    if (!peer?.voiceTrackId) return null
    return peer.pc.getReceivers().find((r) => r.track?.id === peer.voiceTrackId) ?? null
  }
}

// ------------------------------------------------------------------ helpers

function friendlyMediaError(err: unknown): Error {
  if (err instanceof Error) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
      return new Error('Cozy needs permission to use your camera and microphone.')
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')
      return new Error("Couldn't find a camera or microphone.")
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError')
      return new Error('Another app is using your camera. Close it and try again.')
  }
  return err instanceof Error ? err : new Error('Something went wrong reaching your devices.')
}

/** One 32×18 sample, twice. Cheap enough to be worth the certainty. */
function isBlank(video: HTMLVideoElement): boolean {
  if (!video.videoWidth) return false
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 18
  const ctx = canvas.getContext('2d', { willReadFrequently: false })
  if (!ctx) return false
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let brightest = 0
  for (let i = 0; i < data.length; i += 4) {
    const luma = data[i]! * 0.299 + data[i + 1]! * 0.587 + data[i + 2]! * 0.114
    if (luma > brightest) brightest = luma
  }
  return brightest < 8
}
