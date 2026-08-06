import { powerSaveBlocker, powerMonitor } from 'electron'

// Two small jobs: don't let the screen sleep during a film, and tell the
// renderer when we're on battery so it can ease the encoder off.

let blockerId: number | null = null

/** Held only while something is actually being shared, released the moment
 *  it stops — an app that permanently blocks display sleep is a bad citizen. */
export function keepAwake(on: boolean): void {
  if (on) {
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) return
    blockerId = powerSaveBlocker.start('prevent-display-sleep')
  } else if (blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

export function onBattery(): boolean {
  try {
    return powerMonitor.onBatteryPower
  } catch {
    return false
  }
}

/** Let the renderer re-evaluate its quality ceiling when the power source flips. */
export function watchPower(notify: (onBattery: boolean) => void): void {
  powerMonitor.on('on-ac', () => notify(false))
  powerMonitor.on('on-battery', () => notify(true))
}

export function releaseAll(): void {
  keepAwake(false)
}
