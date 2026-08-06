import { useState } from 'preact/hooks'
import type { JSX } from 'preact'
import * as S from '../core/state.js'
import * as app from '../core/app.js'
import { formatCode, inviteMessage, CODE_LENGTH } from '../core/invite.js'
import { Icon } from './icons.js'

/** The only screen where a code is ever visible. After the first connection the
 *  app remembers the pairing and nobody sees this again. */
export function Waiting(): JSX.Element {
  const [copied, setCopied] = useState<'code' | 'invite' | null>(null)
  const code = S.inviteCode.value
  const partnerName = S.settings.value.partner?.name

  // Nobody can arrive if we can't reach the server that introduces people, and
  // that used to look exactly like a healthy wait. Checked before everything
  // else, because it's true on both the invite and the reconnect path.
  if (S.status.value === 'unreachable') return <Unreachable />

  // Reconnecting with someone you've already paired with needs no code at all —
  // that's the whole point of pairing. Showing this screen's code box would mean
  // showing the pairing secret, which is key material, next to a Copy button.
  if (!code) {
    return (
      <div class="waiting">
        <h1>{partnerName ? `Waiting for ${partnerName}…` : 'Waiting…'}</h1>
        <p>
          {partnerName
            ? `As soon as ${partnerName} opens Cozy, you'll be connected. No code needed.`
            : 'You’ll be connected as soon as they arrive.'}
        </p>
        <p class="pulse-line">
          <span class="pulse" /> Waiting for them to arrive…
        </p>
        <button class="btn btn--quiet" onClick={() => app.leave()}>
          Cancel
        </button>
      </div>
    )
  }

  const copy = async (what: 'code' | 'invite') => {
    try {
      await navigator.clipboard.writeText(
        what === 'code' ? formatCode(code) : inviteMessage(code, S.settings.value.name),
      )
      setCopied(what)
      setTimeout(() => setCopied(null), 1800)
    } catch {
      S.say('Could not reach the clipboard.')
    }
  }

  return (
    <div class="waiting">
      <h1>Send this over</h1>
      <p>
        {partnerName
          ? `${partnerName} needs this once. After you connect, it'll just be one button.`
          : `${CODE_LENGTH} characters — read them out or send them. You’ll only do this once; after tonight it’s one button.`}
      </p>

      <div class="code">
        {formatCode(code)}
        <button class="icon icon--sm" onClick={() => void copy('code')} title="Copy code" aria-label="Copy code">
          <Icon name={copied === 'code' ? 'check' : 'copy'} size={15} />
        </button>
      </div>

      <div class="row">
        <button class="btn btn--primary" onClick={() => void copy('invite')}>
          <Icon name={copied === 'invite' ? 'check' : 'copy'} size={16} />
          {copied === 'invite' ? 'Copied — paste it to them' : 'Copy an invite to send'}
        </button>
        <button class="btn btn--quiet btn--danger" onClick={() => app.leave()}>
          Cancel
        </button>
      </div>

      <p class="faint">
        <span class="pulse" /> Waiting for {partnerName ?? 'them'} to arrive…
      </p>
    </div>
  )
}

/**
 * The failure that used to be invisible.
 *
 * Cozy cannot introduce two people without a signalling server, and every way
 * of not having one — wrong URL, nothing deployed, no internet, a captive
 * portal — used to render as "Waiting for them to arrive…" on both machines
 * indefinitely. Naming it is most of the fix; the button is the rest.
 */
function Unreachable(): JSX.Element {
  return (
    <div class="waiting">
      <h1>Can’t reach the signalling server</h1>
      <p>
        That’s the small service that introduces the two of you. Cozy keeps trying in the
        background, so if this is a connection blip it will sort itself out.
      </p>
      <p class="faint">
        If it doesn’t, the address is probably wrong or nothing is deployed there yet — the README
        walks through it.
      </p>
      <div class="hearth__actions">
        <button class="btn btn--primary" onClick={() => (S.sheet.value = 'settings')}>
          Open Connection settings
        </button>
        <button class="btn btn--quiet" onClick={() => app.leave()}>
          Cancel
        </button>
      </div>
    </div>
  )
}
