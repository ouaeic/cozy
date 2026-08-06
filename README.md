<div align="center">

# Cozy

**Watch things together, from far apart.**

</div>

Cozy puts the people you're watching with in a small window that floats over everything you do, and
lets any of you share a screen or a single app — with its sound, in stereo — straight to the others.
Their voices sit above the film, and the film gets out of the way when someone speaks.

It's for people who live in different places and want to watch something at the same time. Two is
what it's built around; up to eight fit. There are no accounts, no rooms to configure, no
subscription. After the first time two of you connect, the home screen is one button with their
name on it.

---

## What makes it different

**The faces float above everything.** They're a real, frameless, always-on-top window — not a box
inside the app. Above your desktop, above other apps, and above any app someone has put into
fullscreen, on every Space. (Measured, not hoped for: the overlay sits on window layer 1001 while a
fullscreen app sits on layer 0.) They also never appear in a screen you share, so nobody watches a
copy of themselves in the corner of the film. A browser tab can do none of this, which is most of
why Cozy is a desktop app.

You see your own camera alongside everyone else's, so you know how you're framed.

**The sound actually works.** In a browser, sharing a single *window* captures no audio at all, and
whole-screen audio is only available on some platforms. Cozy captures your computer's audio
properly, so you can share a video player and the other person hears it — in stereo.

**The controls are on the screen, not in the window.** When you're sharing you're
in a video player, not in Cozy — so the controls are their own floating panel
that hides at the top of the screen and comes down when you push the pointer up
there, from whatever app you're in. Muting yourself never means going to find
the app again.

**Voices sit over the film, and the film ducks.** Their microphone plays at full volume; the film
plays under it. When they start talking, the film dips for a moment and comes back — so you can say
something without reaching for pause.

**It costs almost nothing to run.** The server introduces you and then has almost nothing left to do.
Everything after that — starting a share, changing quality, remembering each other — goes directly
between your two computers. A whole evening costs about six small messages. And the server can't
read any of them (see [PRIVACY.md](docs/PRIVACY.md)).

**It tries not to cook your laptop.** Hardware H.264 encoding, a webcam quality ladder driven by
how large the *other* end is actually drawing you, no animation loops, no polling when idle, and the
display is only kept awake while something is genuinely playing.

---

## Installing

Builds for macOS, Windows and Linux are on the [releases page](https://github.com/ouaeic/cozy/releases).

They are **not code-signed** — certificates cost a few hundred dollars a year and this is a free
project. So the first launch takes one extra step:

- **macOS** — right-click Cozy in Applications, choose **Open**, then **Open** again. Once only.
- **Windows** — SmartScreen will warn you. Click **More info → Run anyway**. Once only.
- **Linux** — prefer the `.deb` if your distribution takes one: it registers `cozy://` invite links,
  sets up Chromium's sandbox for Ubuntu 24.04+, and leaves updates to your package manager. The
  AppImage (`chmod +x Cozy-*.AppImage`) runs anywhere but can't register invite links.
  **Read [LIMITATIONS.md](docs/LIMITATIONS.md) first** — sending the film's *sound* behaves
  differently on Linux and is off by default, and on Wayland the overlays are drawn inside the
  window rather than floating.

### Permissions it will ask for

| | Why |
|---|---|
| Camera & Microphone | So the other person can see and hear you |
| Screen Recording | To share a screen or a window |
| **Screen & System Audio Recording** (macOS) | To send the film's sound. **Cozy must be restarted after granting this** — macOS only applies it on a fresh launch. |

If the sound doesn't come through, Cozy will notice and tell you exactly what to do. See
[LIMITATIONS.md](docs/LIMITATIONS.md).

---

## Using it

1. Open Cozy. Type your name once.
2. Press **Start something**. You get seven characters — `K4RWH7N`. Read them out, or press Copy.
   The alphabet has no two characters that look or sound alike, so there is no “N as in November”.
3. They type them and press Join.
4. Either of you presses **Share** and picks a window.

That's it. From then on, the home screen just says **Reconnect with \<their name\>**.

Move your pointer to the top of the *screen* — from any app — and the controls come down. They
retract when you move away. Drag the floating faces wherever you like; they'll remember.

**Keyboard:** `⌘/Ctrl+D` microphone · `⌘/Ctrl+E` camera · `⌘/Ctrl+S` share · `⌘/Ctrl+F` show/hide
faces · `F` fullscreen · `⌥⇧A` mute from anywhere, even in another app.

On Linux that last one depends on your desktop — Wayland doesn't let apps grab keys, and portal
support varies. `cozy --toggle-mute` works everywhere; bind it to a key in your own keyboard
settings. See [LIMITATIONS.md](docs/LIMITATIONS.md).

---

## There is nothing to set up

No accounts, no sign-up, no server for you to run, and nothing to pay — not a subscription, not a
trial, not a "free tier" you might exceed. Install it, and it works.

Two computers can't find each other on the internet without something to introduce them; that's true
of every peer-to-peer app. We run that introducer, at `getcozy.app`, and the app already points at
it. It is about a hundred lines and
does the least possible work: it passes a few sealed messages between two sockets and then gets out
of the way. Your video and audio go **straight from one computer to the other** and never touch it —
a whole evening costs about six small messages there. It can't read them either: the room id is a
hash of a secret it never receives, and every payload is sealed (see [PRIVACY.md](docs/PRIVACY.md)).

That's also why it stays free. There's no bandwidth bill to pass on, because the bandwidth was never
ours.

### Running your own, if you'd rather

Entirely optional — for forks, or for anyone who would prefer their introductions didn't route
through us. The protocol is the same either way and the app can't tell the difference.

```bash
# On any Node server, mounted into an app you already have:
#   mountCozySignalling(httpServer, { path: '/cozy/ws', trustProxy: true })
npm install ws && node server/serve.mjs                # standalone, ws://localhost:8787/ws

# Or on Cloudflare Workers:
npx wrangler deploy --config server/wrangler.toml
```

Then point a build at it with `COZY_SIGNAL=wss://your-server/cozy/ws npm run dist`, or a single
install at it in **Settings → Connection**. Rate limiting is in the code in both versions — 30
attempts a minute per address, which is what keeps a seven-character invite code safe.

---

## Building from source

Needs Node 22.12+.

```bash
npm install
npm run dev
```

> **Note for macOS developers:** system-audio capture comes back silent under `npm run dev`. macOS
> attributes audio capture to the *responsible process*, which for a dev Electron launched from a
> shell is your terminal — and terminals don't carry the `NSAudioCaptureUsageDescription` key that
> Chromium's audio tap requires. It's a development artifact: packaged builds declare the key
> themselves and capture correctly (measured at 0.92 peak, stereo, 48 kHz). To test audio while
> developing, package first:
>
> ```bash
> npm run pack && open release/mac-arm64/Cozy.app
> ```

```bash
npm run build     # typecheck + bundle
npm run dist      # installers for the current platform into release/
```

### Tests

They drive two real Electron instances through a real call over the DevTools protocol, because the
bugs that matter here — a collapsed overlay window, a negotiation race, a blank screen that only
appears once packaged — don't show up in unit tests.

```bash
npm run server:dev &                    # local signalling
npm run build
npm run test:call                       # two instances, a real encrypted call
npm run test:group                      # four instances, mesh + overlay grid
npm run test:share                      # capture, and that the overlay never leaks into it
npm run test:fullscreen                 # overlay above another process in fullscreen
npm run test:bar                        # the floating control panel
npm run test:inline                     # the Wayland fallback: overlays drawn in-window
npm run test:rejoin                     # goodnight, and finding each other again
npm run test:hotstrip                   # the Linux/X11 panel reveal, forced on
npm run test:clean                      # kill anything a interrupted run left behind

npm run pack                            # audio needs a packaged build on macOS
npm run test:audio                      # real system-audio capture
npm run test:stereo                     # stereo survives the whole trip
```

The last two play a short sound, so turn the volume up enough to hear it.

---

## What Cozy deliberately isn't

No accounts. No chat. No recording. No virtual backgrounds. No playback-sync engine — everyone
watching one live stream with the same buffer is *already* in sync. No mobile app. No more than eight people (see
[LIMITATIONS.md](docs/LIMITATIONS.md) on why the sharer's upload is the real ceiling). No telemetry
of any kind.

## Licence

MIT — see [LICENSE](LICENSE).
