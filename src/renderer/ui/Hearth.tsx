import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { generateName } from '../core/names.js'
import { normaliseCode, CODE_LENGTH, EXAMPLE_CODE } from '../core/invite.js'
import { Icon, initial, tint } from './icons.js'
import { Video } from './Video.js'
import { MicLevel } from './MicLevel.js'

/** Home. One button if you've paired, two fields if you haven't. */
export function Hearth(): JSX.Element {
  const [code, setCode] = useState('')
  const [starting, setStarting] = useState<'host' | 'join' | 'reconnect' | null>(null)
  const partner = S.settings.value.partner
  const name = S.settings.value.name

  const start = async (mode: 'host' | 'join' | 'reconnect', raw = code) => {
    setStarting(mode)
    try {
      if (mode === 'host') await app.host()
      else if (mode === 'reconnect') await app.reconnect()
      else if (!(await app.joinWithCode(raw))) {
        S.say(`That doesn’t look right — it should be ${CODE_LENGTH} characters, like ${EXAMPLE_CODE}.`)
      }
    } finally {
      setStarting(null)
    }
  }

  return (
    <div class="hearth">
      <div class="preview">
        <Video stream={S.camOn.value ? S.localStream.value : null} />
        {!S.camOn.value && <div class="preview__off">Camera off</div>}
        <MicLevel stream={S.localStream.value} muted={!S.micOn.value} />
        <div class="preview__controls">
          <button
            class={`icon ${S.micOn.value ? '' : 'icon--off'}`}
            onClick={() => app.toggleMic()}
            title={S.micOn.value ? 'Mute' : 'Unmute'}
            aria-label={S.micOn.value ? 'Mute microphone' : 'Unmute microphone'}
          >
            <Icon name={S.micOn.value ? 'mic' : 'micOff'} />
          </button>
          <button
            class={`icon ${S.camOn.value ? '' : 'icon--off'}`}
            onClick={() => app.toggleCam()}
            title={S.camOn.value ? 'Turn camera off' : 'Turn camera on'}
            aria-label={S.camOn.value ? 'Turn camera off' : 'Turn camera on'}
          >
            <Icon name={S.camOn.value ? 'cam' : 'camOff'} />
          </button>
        </div>
      </div>

      {/* Given, never typed. Everyone gets two words and an avatar colour
          derived from them, so a room reads consistently and nobody has to
          introduce themselves before they can watch something. */}
      <div class="hearth__name">
        <span class="avatar" style={{ background: tint(name) }}>
          {initial(name)}
        </span>
        <b class="hearth__name-text">{name}</b>
        <button
          class="icon icon--sm"
          onClick={() => void app.saveSettings({ name: generateName() })}
          title="Pick another name"
          aria-label="Pick another name"
        >
          <Icon name="shuffle" size={16} />
        </button>
      </div>

      <div class="hearth__actions">
        {partner ? (
          <>
            <button class="reconnect" onClick={() => void start('reconnect')} disabled={!!starting}>
              <span class="avatar" style={{ background: tint(partner.avatarSeed || partner.name) }}>
                {initial(partner.name)}
              </span>
              <span class="reconnect__text">
                <b>{starting === 'reconnect' ? 'Connecting…' : `Reconnect with ${partner.name}`}</b>
                <span>No code needed</span>
              </span>
              <Icon name="leave" />
            </button>
            <div class="rule">or</div>
          </>
        ) : null}

        <button
          class="btn btn--primary btn--lg"
          style={{ width: '100%' }}
          onClick={() => void start('host')}
          disabled={!!starting}
        >
          {starting === 'host' ? 'Getting a code…' : 'Start something'}
        </button>

        <div class="hearth__join">
          <input
            class="field"
            value={code}
            placeholder="Or type their code"
            spellcheck={false}
            autocomplete="off"
            autocapitalize="characters"
            // The fewest clicks is none. A complete code joins the moment it is
            // finished — typed, pasted, or dropped in by the invite link — so
            // the button below is only there for anyone who pauses.
            onInput={(e) => {
              const raw = (e.target as HTMLInputElement).value
              setCode(raw)
              if (!starting && normaliseCode(raw)) void start('join', raw)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && code.trim()) void start('join')
            }}
            aria-label="Invite code"
          />
          <button class="btn" onClick={() => void start('join')} disabled={!code.trim() || !!starting}>
            {starting === 'join' ? 'Joining…' : 'Join'}
          </button>
        </div>

        {partner && (
          <button class="btn btn--quiet" onClick={() => void app.forgetPartner()}>
            Forget {partner.name}
          </button>
        )}
      </div>
    </div>
  )
}
