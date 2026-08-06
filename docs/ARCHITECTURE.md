# How Cozy is put together

About 3,000 lines in total. This is the map, and more importantly the reasoning — the choices that
look odd are usually the ones that matter most.

---

## Three windows, one renderer process

| | **Stage** | **Faces** | **Bar** |
|---|---|---|---|
| Shows | the shared picture | the webcams | the controls |
| Window | normal, opaque, resizable | frameless, transparent, always-on-top | frameless, transparent, always-on-top |
| Lives | wherever you put it | above everything, including other apps in fullscreen | hidden at the top of the screen, revealed by the cursor |

The Bar is the same idea as the Faces, applied to the controls. The moment you
share something you are looking at a video player, not at Cozy — so a control
strip inside the app window is one you have to alt-tab to reach, which means you
don't. It reveals when the pointer hits the top of the *screen*, from whatever
app has focus.

Three details that are load-bearing, each found the hard way:

- **`acceptFirstMouse: true`.** Without it the first click on an unfocused
  window is consumed as the click-to-focus, so reaching over from VLC to hit
  mute does nothing and you have to click twice.
- **`screen-saver` level +2, one above the Faces.** Both overlays end their
  setup with `moveTop()`; at the same level whichever asserted last won, and the
  controls could end up behind a webcam tile.
- **No `focusable: false` off macOS.** It looks like the way to stop the panel
  stealing focus, and on Windows it routes through Chromium's
  `MA_NOACTIVATEANDEAT`, which does not merely decline to activate — it discards
  the mouse message, so the buttons stop working. macOS gets a real
  non-activating NSPanel; elsewhere we accept the focus change.

Reveal is driven by polling `screen.getCursorScreenPoint()` (~8 Hz, measured at
about 12 µs a tick) rather than a click-through strip across the top of the
screen. The strip approach needs mouse-event forwarding to reach an unfocused
window, which is a Windows-only mechanism — on macOS the `forward` flag is a
documented no-op — and it puts a window over the menu bar. **On Linux neither
works**, so Linux uses a different mechanism entirely. Wayland answers `getCursorScreenPoint()` with
a position inside our own focused window — or, when nothing of ours is focused, a made-up point past
the largest window's corner, which is worse than an obvious sentinel — and X11 caches the last
position seen by our own windows and never refreshes it.

So on **X11** the panel is not polled for at all: it waits collapsed to a two-pixel sliver at the
top of the screen, and the pointer *entering* that sliver is a real event the window receives. Same
behaviour as macOS and Windows, nothing to read a stale answer from. The sliver is only as wide as
the panel, so the rest of the desktop's top edge stays clickable. On **Wayland**, where no window
can be placed or raised at all, the overlays are drawn inside the Stage instead.

Faces being a **real OS window** rather than a box inside the app is the entire product thesis. It
means one mechanism covers three situations a browser can only manage one of: watching in a window,
watching fullscreen, and being the one sharing while you get on with something else.

### The trick that makes it cheap

Faces is opened with `window.open()` from the Stage. Chromium keeps same-origin child windows **in
the same renderer process**, and Electron's own documentation puts it well: the parent can render to
the child *"as if it were a div in the parent."*

So the Stage owns every `MediaStream`, every `RTCPeerConnection` and all application state.
[`faces.html`](../src/renderer/faces.html) has no bundle at all — one inline line that calls
`window.opener.__cozy.mountFaces(document)`, after which the Stage's own Preact runtime renders into
the child document. One runtime, one store, live MediaStreams handed over by reference, and no IPC
anywhere in the media path.

**Why a custom `app://` protocol** ([`src/main/protocol.ts`](../src/main/protocol.ts)): every
`file://` URL is an opaque origin in Chromium, so a packaged build would silently lose the
same-origin relationship and with it the whole architecture. `app://cozy/…` is a standard, secure
origin shared by both windows. It also gives us a proper secure context for `getUserMedia`.

> The handler reads files with `fs.readFile`, **not** `net.fetch(file://…)`. In a packaged build
> the renderer lives inside `app.asar`; Electron's fs layer understands that archive and the network
> stack does not. Fetching them as `file://` URLs returns nothing and the window comes up black —
> which only shows up once you package, since an unpacked dev run serves from a real directory.

The window options that can only be set at creation — frameless, transparent, `type: 'panel'` — are
supplied by `setWindowOpenHandler` in [`src/main/windows.ts`](../src/main/windows.ts). Everything
else is applied *after* the window is on screen, which is load-bearing: set these while it is still
hidden and macOS silently drops them.

```
setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })   // join every Space
setAlwaysOnTop(true, 'screen-saver', 1)                          // above everything
moveTop()
setContentProtection(true)                                       // never in a shared screen
```

`type: 'panel'` is what allows the window into *another application's* fullscreen Space; a plain
NSWindow gets left behind on the previous one however high you set its level. macOS logs
`NSWindow does not support nonactivating panel styleMask` once at creation — cosmetic, and the
behaviour we need still applies.

**Measured, not assumed** ([`test/fullscreen.test.mjs`](../test/fullscreen.test.mjs)): with a
*separate process* in fullscreen, CoreGraphics reports the overlay at `layer 1001`, stacking order
0–3, against the fullscreen window at `layer 0`, order 5.

> Pixel-sampling can never confirm any of this: content protection makes the overlay invisible to
> `screencapture` too, so a screenshot shows whatever is *behind* it and looks exactly like failure.
> The test asks the window server instead.

---

## The server introduces you and leaves

The whole protocol:

```
C→S  { t:'join', room, id }
S→C  { t:'peers', ids:[…] }     → to the joiner
S→C  { t:'join', id }           → to everyone else
C→S  { t:'sig', to, d }         → relayed verbatim; d is ciphertext
S→C  { t:'sig', from, d }
     { t:'bye', id }
```

No hosts, no locks, no presenter roles, no database, no analytics. With two people, "last person to
press share wins" is a few lines of client code and needs no server involvement at all.

**Then the client stops talking to it.** Once a pre-negotiated `RTCDataChannel` is open, all
subsequent signalling — renegotiation when a share starts, mute state, quality hints, pairing,
goodbyes — travels peer-to-peer. `sendSignal()` prefers the channel and falls back to the server only
while the channel is down.

The socket itself stays open, and that is a deliberate reversal. It used to close twenty seconds
after going peer-to-peer, on the reasoning that the server had no job left. It had two: the server is
the only way a *third* person can be discovered, and the only way anyone learns that someone left. A
sealed room meant a friend joining later waited forever on an empty screen while the people inside
saw nothing, and a partner who crashed could never get back in. Keeping a hibernated socket open
costs nothing on Durable Objects — that is what the hibernation API is for — so the saving was
imaginary and the bugs were not.

Ships twice, same protocol: [`server/worker.ts`](../server/worker.ts) (Cloudflare Durable Objects
with WebSocket hibernation — an idle room costs nothing) and
[`server/serve.mjs`](../server/serve.mjs) (~120 lines of Node, for self-hosting).

### Pairing: a short code that opens a long secret

The invite is seven characters, from an alphabet with no two symbols that look or sound alike, so it
can be passed on in a sentence. That is not much entropy, and it
does not need to be: it is used exactly once, on a room that only exists while someone is waiting.

The moment two people connect, each sends sixteen random bytes in its `hello` over the encrypted
data channel, and both combine the pair — sorted, so neither order nor who-spoke-first matters —
into a 256-bit secret via `derivePairSecret`. *That* is what gets stored as the partner, and what
every future "Reconnect with Sam" derives its room from. The invite code is never persisted.

The upgrade is what makes the short code defensible: guessing one buys a single evening, and cannot
reach the pairing. Encryption is covered in [PRIVACY.md](PRIVACY.md).

---

## Media

`RTCPeerConnection` per peer, Perfect Negotiation for glare, polite/impolite decided by comparing
peer ids so exactly one side yields. Largely carried over from the earlier web version, which had
this part right.

### Quality policy — [`quality.ts`](../src/renderer/core/quality.ts)

**High ceiling, never a floor.** A `minBitrate` floor forces the encoder to overshoot a slow link,
which fills queues, spikes delay, and produces exactly the freezing and crackle that reads as "it
falls apart at her end". The ceiling controls the best case; congestion control continuously
controls what's actually sent.

**H.264 first.** Hardware encode on macOS (VideoToolbox) and Windows (Media Foundation). Not on
Linux: Chromium ships `kAcceleratedVideoEncodeLinux` disabled, so VA-API never initialises and
1080p is encoded in software by OpenH264. H.264 is still the right first choice there — software
H.264 is far cheaper than software VP9. Software
VP9 or AV1 at 1080p30 saturates a laptop CPU, trips libwebrtc's overuse detector, and pins
resolution low for tens of seconds afterwards. It's also the difference between a warm laptop and a
cool one.

**A deep receive buffer for the film, a shallow one for the voices.** WebRTC defaults to
interactive-call latency and sacrifices quality to stay low-delay, which is backwards for a film:
400 ms of buffering is invisible, a stutter is not. It is entirely wrong for conversation, where
400 ms added to every sentence is the difference between talking to someone and taking turns.

The rule that mismatched targets break lip-sync is real but narrower than it first looks: it applies
to a *synchronised pair* — one stream's audio against its own video. The film's picture and sound are
one stream and both get 400 ms. The webcam is a different stream, so a short buffer there cannot
desynchronise anything. `onTrack` knows which is which and tunes each receiver accordingly.
(`jitterBufferTarget` is milliseconds; the legacy `playoutDelayHint` is *seconds*.)

**`degradationPreference: 'balanced'`, and a hard 1080p cap on the capture.** Maintain-resolution
sounds like the quality-preserving choice and is close to its opposite: it switches libwebrtc's
quality scaler off entirely, so the encoder may never reduce resolution and instead grinds framerate
towards a slideshow while clinging to a picture it cannot afford. Balanced gives up a little of each,
keeps the scaler running, and — because it is permitted to scale down — is also what makes climbing
back up possible. The 1080p capture cap is what bounds the fall: without it, sharing a 4K or scaled
display hands the encoder four to eight million pixels to fit in the same few megabits.

**And no bitrate floor, anywhere.** Not in `setParameters`, and — the one that actually bit us — not
in the SDP either. `x-google-min-bitrate` reads like a gentle hint and is nothing of the kind:
Chromium feeds it to the congestion controller as a hard clamp, so on a link that can only carry
900 kbps the sender keeps pushing 1.5 Mbps into it, filling queues and producing exactly the freezing
and crackle the floor was meant to prevent. It sat three lines below a comment warning against
floors.

**Stereo Opus at up to 320 kbps**, via an SDP rewrite targeting the negotiated payload type. Left
alone, Opus negotiates a mono speech profile and a soundtrack arrives thin.

### The webcam ladder — the real battery win

The earlier web version encoded the webcam at 720p30 / 2.5 Mbps and then drew it into a 200-pixel
box. Most of the power budget, spent on pixels nobody could see.

Instead, each side tells the other how large it's actually drawing them, over the data channel
(`{ k:'want', size }`). The sender matches it with both `applyConstraints()` (so the camera pipeline
itself does less) and `setParameters()`:

| Tile | Capture | Ceiling | fps |
|---|---|---|---|
| S | 320×180 | 150 kbps | 15 |
| M | 480×270 | 300 kbps | 20 |
| L | 640×360 | 500 kbps | 24 |

Verified end-to-end: the received tile measures exactly 480×270 at the default size.

### The rest of the battery discipline

`powerSaveBlocker` held only while something is playing. No polling in the idle path — the 10 Hz
audio meter is the only recurring timer and it stops when there's no film. No CSS animation loops,
no `requestAnimationFrame`, no canvas. `<video>` elements only, so frames stay on the compositor.
Hidden video elements are paused. The Stage is opaque; only the small Faces window pays for
transparency. `powerMonitor` drops the share to 24 fps on battery.

---

## Capture — [`capture.ts`](../src/main/capture.ts)

`setDisplayMediaRequestHandler` answers with a `desktopCapturer` source plus
`audio: 'loopbackWithMute'`. The mute matters: it silences the sharer's own speakers so Cozy plays
the film back through its own mixer instead — which is what makes ducking work for the person
sharing, not just the person watching. If no audio arrives we re-arm without the mute and try again
before giving up.

The audio constraints are the exact opposite of the microphone's: `echoCancellation`,
`noiseSuppression` and `autoGainControl` all **off**, stereo, 48 kHz. Left to itself Chromium
returns a mono track with all three on — three algorithms tuned for a person talking, which between
them flatten a soundtrack.

Measured on a packaged macOS build: peak amplitude 0.92, stereo, 48 kHz, processing off.

Two failure detectors run after a share starts, because both failure modes are otherwise invisible:

- **Black frames** — one 32×18 canvas sample at 1.5 s and 4 s. Almost always DRM.
- **Digital silence** — the first few seconds of `AudioData` frames read via
  `MediaStreamTrackProcessor`. Exact zero throughout means the OS tap is dead, not that the film is
  quiet; real quiet audio still dithers above zero. See [LIMITATIONS.md](LIMITATIONS.md).

---

## Sound — [`mix.ts`](../src/renderer/core/mix.ts)

One `<audio>` element per person's voice at 1.0, one for the film at ~0.55. No WebAudio graph —
`HTMLMediaElement.volume` is ramped internally by Chromium so it doesn't click, costs nothing, and
avoids the long-standing awkwardness of routing a remote WebRTC stream through an `AudioContext`.

Ducking rides on one 100 ms timer reading `receiver.getSynchronizationSources()[0].audioLevel` — a
number RTP already carries, so there's no analyser node and no extra decode. Two consecutive samples
above threshold arms it, the film drops to 35% over ~120 ms, holds 600 ms past the last word, then
eases back. The same signal drives the warm ring around whoever is speaking.

Two subtleties worth knowing, because both are silent when wrong:

- The meter reads the receiver carrying that person's **microphone**, tracked by track id from
  `ontrack`. Taking "the first live audio receiver" would grab the shared film's own audio whenever
  someone is sharing, and the film would then duck itself every time it got loud.
- Voices are keyed by peer, not singular. With one shared element a third and fourth person would go
  inaudible with nothing to show for it.

---

## Layout

```
src/
  main/       index protocol windows capture power tray shortcuts store
  preload/    index               — the entire native surface, one object
  renderer/
    core/     app session signal quality mix crypto invite protocol state
    ui/       App Hearth Waiting Stage ControlBar SharePicker Sheets Faces Video icons
    styles/   app.css             — one file, no framework
server/       worker.ts wrangler.toml serve.mjs
```

Preact with signals rather than React: same ergonomics, a twentieth of the weight, and no re-render
storms on a surface that has video in it. Hand-written CSS rather than a component library, because
six screens don't need fifty primitives and the app should look like itself.
