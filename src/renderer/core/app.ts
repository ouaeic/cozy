import { Session } from './session.js'
import { Mixer } from './mix.js'
import { generateCode, normaliseCode, avatarSeed as newAvatarSeed } from './invite.js'
import { generateName, isGeneratedName } from './names.js'
import * as S from './state.js'
import { watchHealth, startHealth, stopHealth } from './health.js'
import type { FaceSize, Settings } from '../../shared/types.js'

// The glue. Everything imperative lives here so the components stay declarative
// and the core modules stay unaware of the UI.

export const mixer = new Mixer()

/** Kept out of state.ts because it's the secret, not view data. */
let secret: string | null = null

/** Whether the remembered partner was created during this call — see onPeerHello. */
let pairedThisSession = false
/** Whether a partner was already stored when this call started. If so, a third
 *  arrival must not be allowed to undo it. */
let hadPartnerBeforeCall = false

export const session = new Session({
  onStatus: (status) => {
    S.status.value = status
    if (status === 'connected' && S.scene.value !== 'call') S.scene.value = 'call'
    // Everybody has gone and we're still looking at the Stage, which renders
    // any non-connected state as "Reconnecting…" — a lie, because nobody is
    // coming back to this room.
    if (status === 'waiting' && S.scene.value === 'call') void onEveryoneLeft()
  },

  onRemoteStream: (id, stream, kind) => {
    if (kind === 'webcam') {
      S.updatePeer(id, { stream })
      // The voice sink takes the mic; the tile only renders video.
      mixer.setVoice(id, stream)
      mixer.watch(id, () => session.voiceReceiver(id))
    } else {
      S.stageStream.value = stream
      S.stageOwner.value = id
      mixer.setMovie(stream)
      S.scene.value = 'call'
      startHealth()
    }
  },

  onRemoteStreamGone: (id, kind) => {
    if (kind === 'webcam') {
      S.updatePeer(id, { stream: null })
      mixer.setVoice(id, null)
    } else if (S.stageOwner.value === id) {
      clearStage()
    }
  },

  onPeerHello: (id, info) => {
    S.updatePeer(id, { name: info.name, avatarSeed: info.avatarSeed })

    // Pairing only means something in a call of two. But people arrive one at a
    // time, so a group of four looks exactly like a pair for the first few
    // seconds — hence the pairing is provisional, and a third arrival undoes it.
    //
    // `pairedThisSession` alone was not the guard it looked like: pairSeed is
    // regenerated on every join, so every evening derives a NEW pairSecret, the
    // early return in rememberPartner never fires, and the flag was therefore
    // always true. An established couple who invited a friend over lost each
    // other — next evening the Reconnect button was gone and they needed a
    // fresh code. So remember whether they were already paired when the call
    // began, and never undo that.
    if (S.peers.value.length === 1) {
      void rememberPartner(info.name, info.avatarSeed, info.pairSecret)
    } else if (pairedThisSession && !hadPartnerBeforeCall) {
      pairedThisSession = false
      void saveSettings({ partner: null })
    }
    // Now they know how big we're drawing them, they can stop over-encoding.
    session.requestFaceSize(S.settings.value.faceSize)
  },

  onPeerMedia: (id, media) => S.updatePeer(id, { mic: media.mic, cam: media.cam }),

  onPeerSharing: (id, isSharing) => {
    S.updatePeer(id, { sharing: isSharing })
    // Only the person who put the picture up can take it down.
    if (!isSharing && S.stageOwner.value === id) clearStage()
  },

  onPeerGone: (id) => {
    S.removePeer(id)
    mixer.setVoice(id, null)
    if (S.stageOwner.value === id) clearStage()
    // If they were the one we asked, or the one asking, stop waiting on them —
    // otherwise the Share button stays disabled for the rest of the evening.
    if (S.shareRequest.value?.peerId === id) {
      S.shareRequest.value = null
      if (S.sheet.value === 'share-request') S.sheet.value = null
    }
    if (S.askedToShare.value && !S.someoneElseSharing.value) S.askedToShare.value = false
  },

  onShareRequest: (peerId, name) => {
    S.shareRequest.value = { peerId, name }
    S.sheet.value = 'share-request'
  },

  onShareGranted: () => {
    S.askedToShare.value = false
    S.say('They stopped sharing — your turn.')
    void openPicker()
  },

  onShareDenied: (name) => {
    S.askedToShare.value = false
    S.say(`${name} would rather keep sharing for now.`)
  },

  // We started sharing at the same instant as someone else and lost the
  // deterministic tie-break. Tear ours down through the normal path so the
  // sharing flag, the local film playback and the wake lock all come with it.
  onShareTakenOver: () => {
    void stopSharing()
    S.say('Someone else started sharing, so yours stopped.')
  },

  onConnectionTrouble: () => {
    if (S.sheet.value === null) S.sheet.value = 'trouble'
  },

  onLocalShareEnded: () => {
    S.sharing.value = false
    void window.cozy.keepAwake(false)
    mixer.setMovie(null)
  },

  onShareLooksBlank: () => {
    S.sheet.value = 'blank-capture'
  },

  onShareIsSilent: () => {
    S.sheet.value = 'silent-capture'
  },

  onNotice: (message) => S.say(message),
})

/** Take the picture down and stop the film's sound with it. */
function clearStage(): void {
  S.stageStream.value = null
  S.stageOwner.value = null
  mixer.setMovie(null)
  if (!S.sharing.value) stopHealth()
}

mixer.onSpeaking = (peerId, speaking) => {
  const person = S.peers.value.find((p) => p.id === peerId)
  if (person && person.speaking !== speaking) S.updatePeer(peerId, { speaking })
}

// ------------------------------------------------------------------ startup

export async function boot(): Promise<void> {
  watchHealth(() => session.connections())
  const loaded = await window.cozy.readSettings()

  // Nobody should have to introduce themselves before they can watch a film.
  // Generated once and kept, not re-rolled per launch — the person on the other
  // end learns your name, and it changing every week would be strange.
  //
  // Anything that isn't one of ours is replaced: early builds seeded this from
  // the OS username and later let people type into it, and neither can be
  // edited away now that the field is read-only.
  if (!isGeneratedName(loaded.name)) {
    loaded.name = generateName()
    void window.cozy.writeSettings({ name: loaded.name })
  }

  S.settings.value = loaded
  mixer.onAudioBlocked = (blocked) => (S.audioBlocked.value = blocked)
  mixer.setBalance(loaded.balance)
  mixer.setAutoDuck(loaded.autoDuck)

  await openPreview()
  wireNativeEvents()
}

/** The home-screen camera preview. We hand this same stream to the session
 *  rather than reopening the device, which races on Windows. */
export async function openPreview(): Promise<void> {
  try {
    const stream = await session.openCamera(S.micOn.value, S.camOn.value, {
      preferredMic: S.settings.value.micDeviceId,
      preferredCamera: S.settings.value.camDeviceId,
      protectPlayback: S.settings.value.protectPlayback,
    })
    S.localStream.value = stream
    if (session.micNotice) S.say(session.micNotice, 7000)
  } catch (err) {
    // A five-second toast used to be the whole story here, and it was gone
    // before anyone could act on it — leaving someone connected with no camera,
    // no microphone, and no route back except restarting the app.
    const denied = err instanceof DOMException && /NotAllowed|Permission/.test(err.name)
    const perms = await window.cozy.getPermissions().catch(() => null)
    const blocked =
      perms && (perms.camera === 'denied' || perms.microphone === 'denied')
        ? perms.camera === 'denied'
          ? ('camera' as const)
          : ('microphone' as const)
        : null

    if (denied || blocked) {
      S.permissionKind.value = blocked ?? 'camera'
      S.sheet.value = 'permission'
      return
    }
    // In use by another app, unplugged, or a driver problem — nothing to grant,
    // so say what happened and leave Try again within reach in Settings.
    S.say(err instanceof Error ? err.message : 'Could not reach your camera.', 9000)
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  S.settings.value = await window.cozy.writeSettings(patch)
}

// -------------------------------------------------------------------- call

export async function host(): Promise<void> {
  hadPartnerBeforeCall = !!S.settings.value.partner
  const code = generateCode()
  secret = code
  S.inviteCode.value = code
  S.scene.value = 'waiting'
  await session.join(code, S.settings.value)
}

export async function joinWithCode(input: string): Promise<boolean> {
  const code = normaliseCode(input)
  if (!code) return false
  hadPartnerBeforeCall = !!S.settings.value.partner
  secret = code
  S.inviteCode.value = code
  S.scene.value = 'waiting'
  await session.join(code, S.settings.value)
  return true
}

/**
 * The last person left a call we are still sitting in.
 *
 * If we have paired with them, move to the room derived from the pair secret,
 * because that is the room their "Reconnect" button opens. Staying put meant
 * that on the FIRST evening the two of them provably could not find each other
 * again: one waiting in the room derived from the invite code, the other
 * arriving in the room derived from the pair secret — and the code was no
 * longer on screen, and had never been saved.
 *
 * Unpaired, the invite room and its code are both still good, so just show them
 * again.
 */
async function onEveryoneLeft(): Promise<void> {
  const partner = S.settings.value.partner
  S.say(partner ? `${partner.name} left.` : 'They left.')

  if (partner && secret !== partner.secret) {
    await reconnect()
    return
  }
  S.scene.value = 'waiting'
}

/** The whole point of pairing: no code, one button, every time after the first. */
export async function reconnect(): Promise<boolean> {
  const saved = S.settings.value.partner
  if (!saved) return false
  hadPartnerBeforeCall = true
  secret = saved.secret
  // Emphatically NOT the invite code. This is the 256-bit pairing secret, and
  // the Waiting screen's job is to put the code on screen with Copy buttons
  // next to it — which would have handed someone the key material and produced
  // an "invite" no client would accept anyway.
  S.inviteCode.value = null
  S.scene.value = 'waiting'
  await session.join(saved.secret, S.settings.value)
  return true
}

export function leave(): void {
  session.leave()
  for (const person of S.peers.value) mixer.setVoice(person.id, null)
  mixer.setMovie(null)
  S.peers.value = []
  S.stageStream.value = null
  S.stageOwner.value = null
  S.sharing.value = false
  S.shareRequest.value = null
  S.askedToShare.value = false
  S.inviteCode.value = null
  S.scene.value = 'hearth'
  S.status.value = 'idle'
  S.sheet.value = null
  secret = null
  pairedThisSession = false
  stopHealth()
  void window.cozy.keepAwake(false)
  window.cozy.setCallState({ connected: false, sharing: false, micOn: S.micOn.value })
  void openPreview()
}

/** After the first successful connection there's no reason to ever type a code
 *  again — the two of you now share a secret neither of you had to say. */
async function rememberPartner(name: string, seed: string, pairSecret: string): Promise<void> {
  if (!pairSecret) return
  const current = S.settings.value.partner
  if (current?.secret === pairSecret && current.name === name) return
  pairedThisSession = true
  // Deliberately NOT the invite code. That is seven characters — short so it can be
  // read out loud — and it only has to survive the minutes before you connect.
  // What gets kept is the 256-bit secret the two of you just derived together.
  await saveSettings({
    partner: { name, secret: pairSecret, avatarSeed: seed || newAvatarSeed() },
  })
}

export function forgetPartner(): Promise<void> {
  return saveSettings({ partner: null })
}

// ------------------------------------------------------------------- media

export function toggleMic(): void {
  S.micOn.value = !S.micOn.value
  session.setMic(S.micOn.value)
  window.cozy.setCallState({
    connected: S.connected.value,
    sharing: S.sharing.value,
    micOn: S.micOn.value,
  })
}

export function toggleCam(): void {
  S.camOn.value = !S.camOn.value
  session.setCam(S.camOn.value)
}

/** Settings is a full sheet, so it belongs in the Stage — and the Stage may be
 *  behind a fullscreen film, so bring it forward with it. */
export function openSettings(): void {
  window.cozy.window.show()
  S.sheet.value = 'settings'
}

export async function openSharePicker(): Promise<void> {
  // Checked BEFORE the hand-over request below, not after. Asking to take over
  // stops the other person's film the moment they accept — so discovering
  // afterwards that this device can't capture anything would have interrupted
  // their evening for nothing. No phone browser implements getDisplayMedia.
  if (!window.cozy.canShare) {
    S.say('This device can’t share a screen — but you can still watch someone else’s.', 7000)
    return
  }

  // One screen at a time. If someone already has it, ask rather than fight —
  // two films at once helps nobody, and silently stealing it is worse.
  if (S.someoneElseSharing.value) {
    const holder = S.peers.value.find((p) => p.sharing)
    S.askedToShare.value = true
    session.requestShare(S.settings.value.name || 'Someone')
    S.say(`Asked ${holder?.name ?? 'them'} if you can take over…`)
    return
  }

  // Only stand in the way when the answer is a definite no.
  //
  // getMediaAccessStatus('screen') is CGPreflightScreenCaptureAccess: it never
  // prompts, and it reports 'not-determined' — the state EVERY new install is
  // in — the same as a refusal. Gating on `!== 'granted'` therefore sent people
  // to System Settings to switch on an app that had never asked for the
  // permission, so it wasn't in the list yet and couldn't be added by hand.
  //
  // desktopCapturer.getSources() is the call that actually triggers the macOS
  // prompt, so for 'not-determined' we let it through; openPicker() already
  // turns a refusal into this same sheet.
  const permissions = await window.cozy.getPermissions().catch(() => null)
  if (permissions && (permissions.screen === 'denied' || permissions.screen === 'restricted')) {
    S.permissionKind.value = 'screen'
    S.sheet.value = 'permission'
    return
  }

  // Windows turns every other app's audio down by 80% while a microphone is
  // open, and loopback captures the result — so the film would go out quiet to
  // everyone. Say so once, before the first share rather than after it.
  if (!S.settings.value.duckingNoticeSeen) {
    const ducking = await window.cozy.getDucking().catch(() => null)
    if (ducking?.applies && ducking.willDuck) {
      S.sheet.value = 'ducking'
      return
    }
  }

  await openPicker()
}

async function openPicker(): Promise<void> {
  S.sheet.value = 'share'
  S.busy.value = 'Looking for windows…'
  try {
    S.sources.value = await window.cozy.getSources()
  } catch {
    S.permissionKind.value = 'screen'
    S.sheet.value = 'permission'
  } finally {
    S.busy.value = null
  }
}

/** The sharer said yes: drop ours and let them have it. */
export async function grantShare(): Promise<void> {
  const request = S.shareRequest.value
  S.shareRequest.value = null
  S.sheet.value = null
  if (!request) return
  await session.grantShare(request.peerId)
  S.sharing.value = false
  mixer.setMovie(null)
  void window.cozy.keepAwake(false)
}

export function denyShare(): void {
  const request = S.shareRequest.value
  S.shareRequest.value = null
  S.sheet.value = null
  if (request) session.denyShare(request.peerId)
}

export async function share(sourceId: string, withAudio: boolean): Promise<void> {
  S.sheet.value = null
  S.busy.value = 'Starting…'
  try {
    const stream = await session.startShare(sourceId, withAudio)
    S.sharing.value = true
    startHealth()
    // Only play the film back ourselves where the OS actually muted local
    // playback for us. Where it didn't (Windows), the sharer is already hearing
    // it from their own speakers and a second copy would be an echo.
    const audio = stream.getAudioTracks()
    mixer.setMovie(session.filmPlaysThroughMixer && audio.length ? new MediaStream(audio) : null)
    void window.cozy.keepAwake(true)
  } catch (err) {
    if (!(err instanceof Error && /Permission|denied|Abort/i.test(err.message))) {
      S.say(err instanceof Error ? err.message : 'Could not start sharing.')
    }
  } finally {
    S.busy.value = null
  }
}

export async function stopSharing(): Promise<void> {
  // If someone was waiting to take over, stopping is an answer in itself.
  const waiting = S.shareRequest.value
  await session.stopShare()
  S.sharing.value = false
  if (!S.stageStream.value) stopHealth()
  mixer.setMovie(null)
  void window.cozy.keepAwake(false)
  if (waiting) {
    S.shareRequest.value = null
    if (S.sheet.value === 'share-request') S.sheet.value = null
    await session.grantShare(waiting.peerId)
  }
}

export async function setFaceSize(size: FaceSize): Promise<void> {
  await saveSettings({ faceSize: size })
  session.requestFaceSize(size)
}

export async function setBalance(value: number): Promise<void> {
  mixer.setBalance(value)
  await saveSettings({ balance: value })
}

export async function setAutoDuck(on: boolean): Promise<void> {
  mixer.setAutoDuck(on)
  await saveSettings({ autoDuck: on })
}

// -------------------------------------------------------- native plumbing

function wireNativeEvents(): void {
  window.cozy.onToggleMic(() => toggleMic())
  window.cozy.onLeave(() => leave())
  window.cozy.onInvite((code) => {
    if (S.scene.value === 'hearth') void joinWithCode(code)
    else S.say('Already in a call — leave first to join a different one.')
  })

  window.cozy.window.onFullscreenChange((on) => (S.fullscreen.value = on))
  void window.cozy.window.isFullscreen().then((on) => (S.fullscreen.value = on))

  window.addEventListener('cozy:toggle-cam', () => toggleCam())
  window.addEventListener('cozy:share', () => {
    if (S.sharing.value) void stopSharing()
    else void openSharePicker()
  })
  window.addEventListener('cozy:faces:toggle', () => {
    S.facesVisible.value = !S.facesVisible.value
  })
  window.addEventListener('cozy:power:battery', (event) => {
    session.setOnBattery(!!(event as CustomEvent<boolean>).detail)
  })

  // Local shortcuts, so the app responds even when the menu isn't reachable
  // (fullscreen on Windows, for instance).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && S.sheet.value) {
      // Dismissing the share request is an ANSWER, not a shrug. Without this
      // the asker sat with a greyed-out Share button and "Waiting for them to
      // answer…" until one of them gave up — and the stale request was then
      // treated as a deferred yes the next time the sharer stopped, which is
      // its own small horror. session.ts promises this is always answered.
      if (S.sheet.value === 'share-request') denyShare()
      S.sheet.value = null
      return
    }
    if (e.key === 'Escape' && S.fullscreen.value) {
      window.cozy.window.setFullscreen(false)
      return
    }
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'f' && !e.metaKey && !e.ctrlKey && S.scene.value === 'call') {
      window.cozy.window.setFullscreen(!S.fullscreen.value)
    }
  })
}
