import { useState, useEffect } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { Icon } from './icons.js'
import { DEFAULT_SIGNAL_URL } from '../core/protocol.js'
import { listMicrophones, listCameras } from '../core/devices.js'
import { health, describe } from '../core/health.js'
import type { FaceSize } from '../../shared/types.js'

const close = () => (S.sheet.value = null)
const isMac = window.cozy.platform === 'darwin'

/** Shown when ICE has clearly given up. The honest version of "it didn't work". */
export function Trouble(): JSX.Element {
  return (
    <div class="scrim">
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="warn" size={22} />
          </span>
          <div>
            <h2>We can’t find a direct path between you</h2>
          </div>
        </div>
        <p>
          Cozy connects the two of you straight to each other, which is why it’s fast and costs
          nothing to run. Some networks — office and campus Wi-Fi, a few mobile carriers — block the
          kind of traffic that needs.
        </p>
        <p class="faint">
          Two things usually fix it, both free. Put both computers on the same private network with
          something like Tailscale, and the direct path works again. Or try a different network — a
          phone hotspot instead of office Wi-Fi is often enough, and it’s usually only one end
          causing it.
        </p>
        <div class="sheet__foot">
          <button class="btn btn--quiet" onClick={close}>
            Keep trying
          </button>
          <button
            class="btn btn--primary"
            onClick={() => {
              S.sheet.value = 'settings'
            }}
          >
            Add a relay
          </button>
        </div>
      </div>
    </div>
  )
}

/** The DRM wall. Better to name it than let two people stare at a black square. */
export function BlankCapture(): JSX.Element {
  return (
    <div class="scrim">
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="warn" size={22} />
          </span>
          <h2>That window is coming through black</h2>
        </div>
        <p>
          Netflix, Disney+, Prime and most other streaming services deliberately blank themselves out
          for any screen recorder. It isn’t your connection, and no app can get around it without
          breaking their copy protection — which Cozy won’t do.
        </p>
        <p class="faint">
          What does work: a local video file, a DVD or Blu-ray player app, YouTube, and most things
          that aren’t a paid subscription service. Some services also have their own watch-together
          feature worth a look.
        </p>
        <div class="sheet__foot">
          <button class="btn btn--quiet" onClick={() => void app.stopSharing().then(close)}>
            Stop sharing
          </button>
          <button class="btn" onClick={close}>
            Share it anyway
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * macOS hands back a perfectly healthy-looking audio track full of zeros when
 * it hasn't granted audio recording. Nothing in the UI would otherwise show it
 * — the film would just arrive silent and both people would blame the network.
 */
export function SilentCapture(): JSX.Element {
  const mac = window.cozy.platform === 'darwin'
  return (
    <div class="scrim">
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="warn" size={22} />
          </span>
          <h2>No sound is coming through</h2>
        </div>
        <p>
          The picture is going out fine, but your computer isn’t giving Cozy any audio — we’re
          receiving perfect silence rather than a quiet film.
        </p>
        {mac ? (
          <p class="faint">
            macOS keeps system audio behind its own permission. Open{' '}
            <b>System Settings → Privacy &amp; Security → Screen &amp; System Audio Recording</b>,
            switch Cozy on, then quit and reopen Cozy — the permission only takes effect on a fresh
            launch.
          </p>
        ) : (
          <p class="faint">
            Check that something is actually playing, and that your system output isn’t muted.
          </p>
        )}
        <div class="sheet__foot">
          {mac && (
            <button
              class="btn btn--quiet"
              onClick={() => void window.cozy.openPermissionSettings('screen')}
            >
              Open System Settings
            </button>
          )}
          <button class="btn" onClick={close}>
            Carry on without sound
          </button>
        </div>
      </div>
    </div>
  )
}

/** First-run on macOS lands here. Screen recording is off until granted, and
 *  the OS gives us a bare failure rather than anything a person could act on. */
export function PermissionNeeded(): JSX.Element {
  const mac = window.cozy.platform === 'darwin'
  const kind = S.permissionKind.value
  const screen = kind === 'screen'

  const title = screen
    ? 'Cozy needs permission to see your screen'
    : kind === 'camera'
      ? 'Cozy can’t reach your camera'
      : 'Cozy can’t reach your microphone'

  const pane = screen
    ? 'Screen & System Audio Recording'
    : kind === 'camera'
      ? 'Camera'
      : 'Microphone'

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="warn" size={22} />
          </span>
          <h2>{title}</h2>
        </div>
        {mac ? (
          <>
            <p>
              Open <b>System Settings → Privacy &amp; Security → {pane}</b> and switch Cozy on.
              {screen ? (
                <>
                  {' '}
                  Turn it on for <i>system audio</i> too, or the film will arrive silent.
                </>
              ) : null}
            </p>
            {screen && (
              <p class="faint">
                macOS only applies this on a fresh launch, so quit Cozy completely and open it again
                afterwards.
              </p>
            )}
          </>
        ) : screen ? (
          <p>
            Your desktop needs to allow screen capture for Cozy. On Wayland this is handled by
            <code> xdg-desktop-portal</code>; check it&rsquo;s installed for your desktop
            environment.
          </p>
        ) : (
          <p>
            Something else is holding your {kind}, or the system is blocking it. Close anything else
            that might be using it, then try again.
          </p>
        )}
        <div class="sheet__foot">
          <button class="btn btn--quiet" onClick={close}>
            Not now
          </button>
          {/* The way out. Without this, granting the permission left the person
              connected but silent and invisible until they restarted the app —
              the senders are only attached when a camera actually opens. */}
          {!screen && (
            <button
              class="btn"
              onClick={() => {
                close()
                void app.openPreview()
              }}
            >
              Try again
            </button>
          )}
          {mac && (
            <button
              class="btn btn--primary"
              onClick={() => void window.cozy.openPermissionSettings(kind)}
            >
              Open System Settings
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Windows' single most destructive default for an app like this: while a
 * microphone is open it turns every *other* application down by 80%, and since
 * loopback captures the mix after that, the film goes out quiet to everyone.
 */
export function Ducking(): JSX.Element {
  const [fixing, setFixing] = useState(false)

  const proceed = async () => {
    await app.saveSettings({ duckingNoticeSeen: true })
    close()
    void app.openSharePicker()
  }

  return (
    <div class="scrim">
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <span style={{ color: 'var(--warn)' }}>
            <Icon name="warn" size={22} />
          </span>
          <h2>Windows will turn your film down</h2>
        </div>
        <p>
          While any app is using your microphone, Windows quietly reduces every other application's
          volume by 80% — it assumes you're on a call and wants you to hear it. Cozy captures your
          computer's sound <i>after</i> that happens, so the film would reach the other person very
          quiet, and sound quiet to you too.
        </p>
        <p class="faint">
          The setting lives in Sound → Communications → “Do nothing”. It's per-user, and you can put
          it back the same way whenever you like.
        </p>
        <div class="sheet__foot">
          <button class="btn btn--quiet" onClick={() => void proceed()}>
            Share anyway
          </button>
          <button class="btn" onClick={() => void window.cozy.openSoundSettings()}>
            Show me the setting
          </button>
          <button
            class="btn btn--primary"
            disabled={fixing}
            onClick={async () => {
              setFixing(true)
              const ok = await window.cozy.stopDucking()
              setFixing(false)
              S.say(
                ok
                  ? 'Done — Windows will leave your other apps alone now.'
                  : 'Could not change it. Sound → Communications → “Do nothing” does the same thing.',
              )
              if (ok) void proceed()
            }}
          >
            {fixing ? 'Changing…' : 'Fix it for me'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Only one screen at a time, so taking over is a request, not a grab. */
export function ShareRequest(): JSX.Element {
  const asking = S.shareRequest.value
  return (
    <div class="scrim">
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <h2>{asking?.name ?? 'Someone'} would like to share</h2>
        </div>
        <p>
          Only one screen goes out at a time. If you say yes, yours stops and they can put something
          on instead.
        </p>
        <div class="sheet__foot">
          <button class="btn btn--quiet" onClick={() => app.denyShare()}>
            Not right now
          </button>
          <button class="btn btn--primary" onClick={() => void app.grantShare()}>
            Let them share
          </button>
        </div>
      </div>
    </div>
  )
}

export function SettingsSheet(): JSX.Element {
  const s = S.settings.value
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([])
  const [cams, setCams] = useState<{ deviceId: string; label: string }[]>([])
  useEffect(() => {
    void listMicrophones().then(setMics)
    void listCameras().then(setCams)
  }, [])
  const [turnUrls, setTurnUrls] = useState(s.turn?.urls ?? '')
  const [turnUser, setTurnUser] = useState(s.turn?.username ?? '')
  const [turnPass, setTurnPass] = useState(s.turn?.credential ?? '')
  const [signalUrl, setSignalUrl] = useState(s.signalUrl ?? '')

  const saveTurn = () => {
    const urls = turnUrls.trim()
    void app.saveSettings({
      turn: urls ? { urls, username: turnUser.trim(), credential: turnPass.trim() } : null,
      signalUrl: signalUrl.trim() || null,
    })
    S.say('Saved. It’ll take effect the next time you connect.')
  }

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="sheet sheet--narrow">
        <div class="sheet__head">
          <h2>Settings</h2>
          <div class="spacer" />
          <button class="icon" onClick={close} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div class="sheet__scroll stack">
          <div class="stack">
            <b>Faces</b>
            <div class="row">
              {(['S', 'M', 'L'] as FaceSize[]).map((size) => (
                <button
                  key={size}
                  class={`btn ${s.faceSize === size ? 'btn--primary' : ''}`}
                  onClick={() => void app.setFaceSize(size)}
                >
                  {{ S: 'Small', M: 'Medium', L: 'Large' }[size]}
                </button>
              ))}
            </div>
            <span class="faint">
              Bigger tiles ask the other end for a sharper picture. Smaller ones are kinder to both
              batteries.
            </span>

            <button
              class={`toggle ${s.selfView ? 'toggle--on' : ''}`}
              onClick={() => void app.saveSettings({ selfView: !s.selfView })}
              aria-pressed={s.selfView}
            >
              <span>
                Show my own camera
                <br />
                <span class="faint">So you can see how you’re framed</span>
              </span>
              <span class="toggle__track" />
            </button>

            <button class="btn btn--quiet" onClick={() => window.cozy.faces.resetPosition()}>
              Move faces back to the corner
            </button>
          </div>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          <div class="stack">
            <b>Camera</b>
            <select
              class="field"
              value={s.camDeviceId ?? ''}
              onChange={(e) => {
                const value = (e.target as HTMLSelectElement).value
                void app.saveSettings({ camDeviceId: value || null }).then(() => app.openPreview())
              }}
              aria-label="Camera"
            >
              <option value="">System default</option>
              {cams.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label}
                </option>
              ))}
            </select>

            <b style={{ marginTop: 8 }}>Microphone</b>
            <select
              class="field"
              value={s.micDeviceId ?? ''}
              onChange={(e) => {
                const value = (e.target as HTMLSelectElement).value
                void app.saveSettings({ micDeviceId: value || null }).then(() => app.openPreview())
              }}
              aria-label="Microphone"
            >
              <option value="">Choose automatically</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>

            <button
              class={`toggle ${s.protectPlayback ? 'toggle--on' : ''}`}
              onClick={() =>
                void app
                  .saveSettings({ protectPlayback: !s.protectPlayback })
                  .then(() => app.openPreview())
              }
              aria-pressed={s.protectPlayback}
            >
              <span>
                Keep my headphones in full stereo
                <br />
                <span class="faint">
                  Bluetooth headsets drop to mono the moment anything uses their microphone. Cozy
                  uses a different mic instead, so the film keeps its sound.
                </span>
              </span>
              <span class="toggle__track" />
            </button>
          </div>

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          {/* The only thing Cozy does without being asked, so it gets a switch
              rather than just a line in the privacy doc. Shown on every
              platform even where it does nothing — somebody wondering "does
              this phone home?" should find the answer here, not an absence. */}
          <div class="stack">
            <b>Updates</b>
            <button
              class={`toggle ${s.autoUpdate ? 'toggle--on' : ''}`}
              onClick={() => void app.saveSettings({ autoUpdate: !s.autoUpdate })}
              aria-pressed={s.autoUpdate}
            >
              <span>
                Check for new versions
                <br />
                <span class="faint">
                  Asks GitHub for release information shortly after launch and once a day. Nothing
                  about you is sent, and a new version installs when you next quit — never during a
                  film. Turn it off and Cozy never contacts GitHub at all.
                </span>
              </span>
              <span class="toggle__track" />
            </button>
            {isMac && (
              <span class="faint">
                On macOS this does nothing either way: an unsigned build can&rsquo;t replace itself,
                so Cozy never checks. Update by downloading a new copy.
              </span>
            )}
          </div>

          {health.value && (
            <div class="stack">
              <b>How it's going</b>
              <p class="faint" style={{ margin: 0 }}>
                {describe(health.value)}
              </p>
              <div class="faint" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {health.value.sending && (
                  <div>
                    Sending {health.value.sending.width}×{health.value.sending.height} at{' '}
                    {health.value.sending.fps} fps, {Math.round(health.value.sending.kbps / 100) / 10}{' '}
                    Mbit/s
                    {health.value.hardwareEncode === false && ' · software encoder'}
                  </div>
                )}
                {health.value.receiving && (
                  <div>
                    Receiving {health.value.receiving.width}×{health.value.receiving.height} at{' '}
                    {health.value.receiving.fps} fps,{' '}
                    {Math.round(health.value.receiving.kbps / 100) / 10} Mbit/s
                  </div>
                )}
                {health.value.rtt !== null && <div>Round trip {health.value.rtt} ms</div>}
              </div>
            </div>
          )}

          <hr style={{ border: 0, borderTop: '1px solid var(--line)', margin: '4px 0' }} />

          <div class="stack">
            <b>Connection</b>
            <span class="faint">
              For people who already run a relay of their own. Nothing here is required, and nothing
              about Cozy costs anything — if you don’t know what a TURN relay is, you don’t need one.
            </span>
            <input
              class="field"
              placeholder="turn:relay.example.com:3478"
              value={turnUrls}
              spellcheck={false}
              onInput={(e) => setTurnUrls((e.target as HTMLInputElement).value)}
              aria-label="TURN server URL"
            />
            <div class="row">
              <input
                class="field"
                placeholder="Username"
                value={turnUser}
                spellcheck={false}
                onInput={(e) => setTurnUser((e.target as HTMLInputElement).value)}
                aria-label="TURN username"
              />
              <input
                class="field"
                type="password"
                placeholder="Password"
                value={turnPass}
                onInput={(e) => setTurnPass((e.target as HTMLInputElement).value)}
                aria-label="TURN password"
              />
            </div>

            <span class="faint" style={{ marginTop: 6 }}>
              Signalling server — leave blank. Cozy uses ours unless you run your own.
            </span>
            <input
              class="field"
              placeholder={DEFAULT_SIGNAL_URL}
              value={signalUrl}
              spellcheck={false}
              onInput={(e) => setSignalUrl((e.target as HTMLInputElement).value)}
              aria-label="Signalling server URL"
            />
          </div>
        </div>

        <div class="sheet__foot">
          <button class="btn btn--primary" onClick={saveTurn}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
