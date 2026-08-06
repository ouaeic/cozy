import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { Icon } from './icons.js'

/**
 * Windows first, deliberately — sharing one app is usually what people mean,
 * and a whole screen sends your notifications along with your film.
 *
 * It is NOT because the overlay would leak: content protection keeps the
 * floating faces out of a whole-screen capture on both macOS and Windows, which
 * test/share.test.mjs measures by actually sharing a screen. Linux is the
 * exception, and the footer below says so there.
 */
const isLinux = window.cozy.platform === 'linux'

/**
 * Linux has no per-application audio tap, and — unlike macOS and Windows — no
 * way to exclude the capturing app from its own loopback either (Chromium's
 * kLoopbackWithoutChromeId is macOS/Windows/ChromeOS only). So capturing
 * "system audio" here captures Cozy playing the other person's voice, and sends
 * it back to them as part of the film. They hear themselves, delayed.
 *
 * It still has a legitimate use — a machine that isn't also playing the call —
 * so it stays available. It just isn't the default here.
 */
const AUDIO_DEFAULT = !isLinux

export function SharePicker(): JSX.Element {
  const [tab, setTab] = useState<'window' | 'screen'>('window')
  const [query, setQuery] = useState('')
  const [withAudio, setWithAudio] = useState(AUDIO_DEFAULT)

  const all = S.sources.value
  // The portal, not us, does the choosing on Wayland — capture.ts answers with
  // exactly one synthetic entry there. Derive it from that rather than from a
  // platform flag, so it can never disagree with what's on screen.
  const viaPortal = all.length === 1 && all[0]?.id === 'portal'
  const list = all
    .filter((s) => s.kind === tab)
    .filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && (S.sheet.value = null)}>
      <div class="sheet">
        <div class="sheet__head">
          <div>
            <h2>What are you watching?</h2>
            <p class="faint">
              {viaPortal
                ? 'Your desktop will ask which window — Cozy only starts it off.'
                : isLinux
                  ? 'Linux can’t capture one app’s sound on its own — see below.'
                  : 'Sound comes along with it — no extra setup.'}
            </p>
          </div>
          <div class="spacer" />
          <button class="icon" onClick={() => (S.sheet.value = null)} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>

        <div class="row">
          <div class="tabs">
            <button class={`tab ${tab === 'window' ? 'tab--on' : ''}`} onClick={() => setTab('window')}>
              A window
            </button>
            <button class={`tab ${tab === 'screen' ? 'tab--on' : ''}`} onClick={() => setTab('screen')}>
              Whole screen
            </button>
          </div>
          <div class="spacer" style={{ flex: 1 }} />
          <input
            class="field"
            style={{ maxWidth: 200 }}
            placeholder="Search"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            aria-label="Search windows"
          />
        </div>

        <div class="sheet__scroll">
          {list.length === 0 ? (
            <div class="empty-note">
              {S.busy.value ?? (query ? 'Nothing matches that.' : 'Nothing to share here.')}
            </div>
          ) : (
            <div class="grid">
              {list.map((source) => (
                <button key={source.id} class="source" onClick={() => void app.share(source.id, withAudio)}>
                  <img class="thumb" src={source.thumbnail} alt="" />
                  <span class="source__label">
                    {source.appIcon && <img src={source.appIcon} alt="" />}
                    <span title={source.name}>{source.name}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div class="sheet__foot" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <button
            class={`toggle ${withAudio ? 'toggle--on' : ''}`}
            style={{ width: 'auto', gap: 10 }}
            onClick={() => setWithAudio(!withAudio)}
            aria-pressed={withAudio}
          >
            <span class="faint">Send the sound too</span>
            <span class="toggle__track" />
          </button>
          <span class="faint" style={{ maxWidth: 340, textAlign: 'right' }}>
            {isLinux && withAudio
              ? 'Linux sends everything the speakers are playing — including this call, so the other person will hear themselves echoed.'
              : tab === 'screen'
                ? isLinux
                  ? 'Sharing a whole screen also shares your notifications, and the floating faces — Linux can’t hide them from a capture.'
                  : 'Sharing a whole screen also shares your notifications.'
                : ''}
          </span>
        </div>
      </div>
    </div>
  )
}
