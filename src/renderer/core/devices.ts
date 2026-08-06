// Opening a microphone can wreck the film's sound before it ever leaves the
// machine, and it happens on every platform.
//
// Bluetooth Classic cannot carry high-quality stereo out and a microphone back
// at the same time. The moment anything opens the mic on a pair of AirPods or
// similar, the headset abandons A2DP and drops to the hands-free profile:
// mono, and historically 8kHz — worse than AM radio. You put your headphones on
// to watch a film properly and the act of being able to talk destroys it.
//
// Nothing in the app can prevent that switch. But we can decline to use *that*
// microphone. Listening on the headset while talking through the laptop's own
// mic keeps the headset in A2DP, so the film stays in full stereo. The mic is
// slightly further from your mouth; the film sounds enormously better. That is
// the right trade for a film night, and it's a setting for anyone who disagrees.

export interface DeviceChoice {
  deviceId: string | null
  /** Why we moved away from the default, for the settings screen to explain. */
  reason: 'headset-would-downgrade-audio' | 'user-chose' | null
  label: string | null
}

interface Devices {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
}

async function enumerate(): Promise<Devices> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return {
      inputs: all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'),
      outputs: all.filter((d) => d.kind === 'audiooutput'),
    }
  } catch {
    return { inputs: [], outputs: [] }
  }
}

/**
 * A single physical headset exposes its speaker and its microphone under one
 * groupId. Built-in speakers and a built-in microphone are separate hardware and
 * carry different ones. So a shared groupId between the default output and the
 * default input means one combo device is doing both — which for anything
 * wireless is exactly the case that collapses to mono.
 */
function sharesHardwareWithOutput(input: MediaDeviceInfo, outputs: MediaDeviceInfo[]): boolean {
  if (!input.groupId) return false
  return outputs.some((out) => out.groupId === input.groupId)
}

export async function pickMicrophone(
  preferred: string | null,
  protectPlayback: boolean,
): Promise<DeviceChoice> {
  const { inputs, outputs } = await enumerate()
  if (inputs.length === 0) return { deviceId: null, reason: null, label: null }

  // An explicit choice always wins.
  if (preferred) {
    const chosen = inputs.find((d) => d.deviceId === preferred)
    if (chosen) return { deviceId: chosen.deviceId, reason: 'user-chose', label: chosen.label }
  }
  if (!protectPlayback) return { deviceId: null, reason: null, label: null }

  // Which input would we get by default? The one the browser lists first.
  const fallback = inputs[0]!
  if (!sharesHardwareWithOutput(fallback, outputs)) {
    return { deviceId: null, reason: null, label: null }
  }

  // It's a combo device. Is there a separate microphone we could use instead?
  const separate = inputs.find((d) => !sharesHardwareWithOutput(d, outputs))
  if (!separate) return { deviceId: null, reason: null, label: null }

  return {
    deviceId: separate.deviceId,
    reason: 'headset-would-downgrade-audio',
    label: separate.label || 'another microphone',
  }
}

/** For the settings screen. Labels are blank until media permission is granted. */
export async function listMicrophones(): Promise<{ deviceId: string; label: string }[]> {
  const { inputs } = await enumerate()
  return inputs.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }))
}

/** Cameras, for people with more than one. Same shape as the microphones. */
export async function listCameras(): Promise<{ deviceId: string; label: string }[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter((d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== 'default')
      .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
  } catch {
    return []
  }
}
