import { signal, computed, effect } from '@preact/signals'
import { health } from './health.js'
import { DEFAULT_SETTINGS, type Settings, type CaptureSource } from '../../shared/types.js'
import type { Status } from './session.js'

// One store, read by both windows. The Faces window is rendered by the Stage's
// own Preact runtime (same process, same module instances), so there's nothing
// to synchronise — both trees subscribe to these signals directly.

export interface PeerView {
  id: string
  name: string
  avatarSeed: string
  mic: boolean
  cam: boolean
  sharing: boolean
  stream: MediaStream | null
  speaking: boolean
}

export type Scene = 'hearth' | 'waiting' | 'call'
export type Sheet =
  | null
  | 'share'
  | 'settings'
  | 'trouble'
  | 'blank-capture'
  | 'silent-capture'
  | 'permission'
  | 'ducking'
  | 'share-request'

export const scene = signal<Scene>('hearth')
export const status = signal<Status>('idle')
export const settings = signal<Settings>({ ...DEFAULT_SETTINGS })

export const localStream = signal<MediaStream | null>(null)
export const micOn = signal(true)
export const camOn = signal(true)

export const peers = signal<PeerView[]>([])
/** Whatever is on the Stage right now: the far end's share, or nothing. */
export const stageStream = signal<MediaStream | null>(null)
/** Who put it there. Without this, ANY peer leaving clears the picture — so in
 *  a group of three, one person saying goodnight blanks the film for everyone
 *  else while it is still being shared. */
export const stageOwner = signal<string | null>(null)
export const sharing = signal(false)

export const inviteCode = signal<string | null>(null)
export const fullscreen = signal(false)
export const facesVisible = signal(true)
export const sheet = signal<Sheet>(null)
/** Which device the 'permission' sheet is complaining about. */
export const permissionKind = signal<'screen' | 'camera' | 'microphone'>('screen')
export const sources = signal<CaptureSource[]>([])
export const notice = signal<string | null>(null)
export const busy = signal<string | null>(null)

/** Someone asking to take over the screen from us. */
export const shareRequest = signal<{ peerId: string; name: string } | null>(null)
/** True while we're waiting for the current sharer to answer us. */
export const askedToShare = signal(false)

export const someoneElseSharing = computed(() => peers.value.some((p) => p.sharing))
export const partner = computed(() => peers.value[0] ?? null)
export const connected = computed(() => status.value === 'connected')
export const somethingOnStage = computed(() => stageStream.value !== null)

let noticeTimer: ReturnType<typeof setTimeout> | null = null

/** Toasts are for things that just happened, not things to decide about. */
export function say(message: string, ms = 5200): void {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = null
    noticeTimer = null
  }, ms)
}

// A toast and a sheet are two ways of saying something, and they collide badly
// — the toast floats over the sheet's own content. Opening a sheet is usually
// the user acting on whatever the toast said, so the toast has done its job.
effect(() => {
  if (sheet.value !== null && notice.peek() !== null) notice.value = null
})

export function updatePeer(id: string, patch: Partial<PeerView>): void {
  const list = peers.value
  const index = list.findIndex((p) => p.id === id)
  if (index === -1) {
    peers.value = [
      ...list,
      {
        id,
        name: 'Someone',
        avatarSeed: '',
        mic: true,
        cam: true,
        sharing: false,
        stream: null,
        speaking: false,
        ...patch,
      },
    ]
    return
  }
  const next = list.slice()
  next[index] = { ...list[index]!, ...patch }
  peers.value = next
}

export function removePeer(id: string): void {
  peers.value = peers.value.filter((p) => p.id !== id)
}

/** Re-exported so components can depend on it without a second import. */
export { health }
