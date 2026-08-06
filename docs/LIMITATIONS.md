# Things Cozy can't do, and why

Written plainly, because finding this out at 9pm on a Friday with someone waiting is worse than
reading it now.

---

## Netflix, Disney+, Prime and friends come through black

Not a bug, and not fixable. Those services deliberately blank themselves out for any screen
recorder — it's a copy-protection feature enforced below the application layer. Any tool that
captures a protected surface hits the same wall. Getting around it means defeating DRM, which this project won't do.

Cozy samples the picture a second or two after you start sharing and tells you when it's black,
rather than leaving you both staring at a dark rectangle blaming your internet.

**What does work:** local video files, DVD/Blu-ray player apps, YouTube, Vimeo, Twitch, most things
that aren't a paid subscription service. Several of the big services also have their own
watch-together feature, which is worth a look for exactly the content Cozy can't carry.

---

## macOS needs a separate permission for system audio, and a restart

**Status: verified working.** In a packaged build with the permission granted, capture measures a
peak amplitude of 0.92 in stereo at 48 kHz with echo cancellation, noise suppression and automatic
gain all off — exactly what a film needs.

But it has to be set up right, and when it isn't, the failure is genuinely nasty: you get a **live,
healthy-looking audio track at the correct sample rate, delivering frames on schedule, in which
every single sample is zero.** No error is raised. The film simply arrives silent and neither of you
can tell why.

We measured that failure too: with a sound audibly playing through the speakers (confirmed by a
microphone reading 0.287 against a room floor of 0.016), the capture delivered 249 frames of exact
digital zero.

Two things are needed:

1. **`NSAudioCaptureUsageDescription` in the app's Info.plist.** Cozy declares it. Without it,
   Chromium's CoreAudio Tap returns zeros forever.
2. **The user granting it.** System Settings → Privacy & Security → *Screen & System Audio
   Recording*. **Then quit and reopen Cozy** — macOS only applies the grant on a fresh launch.

Cozy watches the first few seconds of captured audio and, if it's exact digital silence, says so and
offers to open the right settings pane. Exact zero is the giveaway: genuinely quiet audio still
dithers above it.

**Developers:** system audio comes back silent under `npm run dev`. macOS attributes capture to the
*responsible process*, which for a dev Electron launched from a shell is your terminal — and
terminals don't carry that Info.plist key. Test audio with a packaged build (`npm run pack`), where
it works.

---

## The floating faces do not leak into your shared screen

Not a limitation — a thing worth knowing, because most screen-sharing tools get it wrong and you end
up watching a small copy of yourself in the corner of the film.

Cozy marks the overlay as protected content (`WDA_EXCLUDEFROMCAPTURE` on Windows,
`NSWindowSharingNone` on macOS), so the window server leaves it out of anything that captures the
screen. **Verified on macOS 14.6:** sharing an entire screen with the overlay painted a solid colour
on top of it, the receiving end saw 0 of 576 sampled pixels of it. It also means the overlay is
invisible to `screencapture` and to other recording tools — which is the intended trade.

**Not on Linux.** Electron's `setContentProtection` is macOS and Windows only; on Linux it does
nothing at all, and there is no X11 or Wayland mechanism to hide a window from a capture. So a Linux
user sharing a **whole screen** sends the floating faces and the control bar along with it. Sharing
a single **window** is unaffected on every platform, and is the better choice there anyway. The
share picker says so on Linux rather than letting you find out from the other person.

---

## On Windows the sharer hears the film from their own speakers, not from Cozy

Everywhere else, Cozy asks the OS to mute local playback while it captures, and then plays the film
back through its own mixer. That is what lets the film duck for the person *sharing* it, and not just
for the people watching.

Windows implements that request differently, and destructively: Chromium calls
`IAudioEndpointVolume::SetMute(true)` on the actual output device, so it mutes the machine the way
the volume icon does. Cozy's own playback goes to the same device, so the sharer would hear nothing
at all — and the unmute only happens on a clean shutdown, meaning a crash mid-share leaves the
computer silent with no indication why. It is a well-known hazard of that flag, and the reason Cozy
does not use it.

So on Windows, Cozy captures without muting. The sharer keeps hearing the film exactly as they
already were; everyone else still gets ducking. The one thing that doesn't work there is ducking the
film for the person sharing it.

---

## System audio capture is all-or-nothing

Loopback captures everything your computer is playing, not just the app you picked. A notification
chime during a quiet scene goes out too. That's how the platform APIs work on every OS; there's no
per-application audio tap available to us. Do Not Disturb is the practical answer.

---

## About one connection in ten can't make a direct link

Cozy connects the two computers directly. Some networks won't allow that — symmetric NAT, carrier-
grade NAT on some mobile providers, most corporate Wi-Fi. Roughly 5–10% of pairs of real-world
networks are affected.

Carrying the video for those pairs would mean relaying it through a server, and relaying video is
the one part of this that costs real money in bandwidth. We're not going to put that behind a
payment, and we're not going to quietly cap everyone to cover it — so for now Cozy is honest about
the 5–10% instead of pretending.

Cozy notices after about twelve seconds and says so, rather than leaving you both watching a
spinner. Two things usually fix it, both free:

**Put both machines on one private network.** [Tailscale](https://tailscale.com) is free for
personal use, takes a couple of minutes, and gives the two computers a direct encrypted path that
looks local. Cozy then finds that path like any other and needs no relay at all. For two people who
watch together regularly this is the best answer — nothing in the middle, nothing to configure
again.

**Try a different network.** A phone hotspot instead of office Wi-Fi is often enough; it's usually
one end causing it, not both.

If you happen to run a TURN relay already, Settings → Connection will use it. That field is there
for people who have one, not a bill anyone is expected to pick up.

---

## Linux: global shortcuts, and the command you can bind instead

Wayland has no equivalent of the key grab X11 offers — by design, a compositor only delivers keys to
the focused window. The replacement is `org.freedesktop.portal.GlobalShortcuts`, and support for it
is genuinely uneven:

| Desktop | Cozy's `⌥⇧A` mute |
|---|---|
| Any X11 / Xorg session | Works |
| KDE Plasma 5.27+ | Works, bound silently |
| GNOME 48+ | Works, after a one-time permission dialog |
| Hyprland | Works, but you must also add a `global` bind in `hyprland.conf` |
| Sway, Niri, other wlroots | **No portal backend. Does not work at all.** |
| Very new distros (xdg-desktop-portal 1.21+, e.g. Ubuntu 26.04) | Currently broken in Electron 43; fixed upstream in 44 |

Cozy sets the things that are its job to set — a proper reverse-DNS desktop identity, the portal
feature flags, one comma-joined `--enable-features` switch — but none of that can conjure a backend
that isn't there. And the portal never reports success reliably, so the app cannot even tell you
whether the shortcut took.

**So there's a command that always works.** Bind a key to it in your own desktop's keyboard settings
and it toggles your microphone in the running app, on every compositor:

```bash
cozy --toggle-mute
```

- **GNOME** — Settings → Keyboard → Custom Shortcuts → command `cozy --toggle-mute`
- **KDE** — System Settings → Shortcuts → Add Command
- **Sway** — `bindsym $mod+m exec cozy --toggle-mute`
- **Hyprland** — `bind = SUPER, M, exec, cozy --toggle-mute`

We deliberately don't write into your keybinding config for you.

Push-to-talk is a different matter and Cozy does not have it on any platform: Electron's global
shortcut API only reports the key going *down*, never coming back up.

---

## Linux: sharing works, but sound and the overlays don't work the way they do elsewhere

Linux is the platform this project can test least, and two of its ideas don't survive the trip.
Sharing the picture is fine. The rest needs explaining.

**Choosing what to share.** X11 sessions use the built-in capturer and behave like macOS and
Windows. Wayland sessions go through `xdg-desktop-portal`, which needs a backend for your desktop
(`xdg-desktop-portal-gnome`, `-kde`, `-wlr`). There, the compositor refuses to enumerate your
windows on purpose — so your desktop's own dialog does the choosing, and Cozy's picker is reduced to
a single button that opens it. That is the portal's design, not a missing feature.

**Sending the film's sound is the weak spot, and it is off by default here.** Linux has no
per-application audio tap, and — unlike macOS and Windows — no way to exclude the capturing app from
its own loopback either. So "system audio" on Linux means *everything the speakers are playing,
including Cozy itself*: the other person's voice gets captured and sent back to them, and they hear
themselves half a second late. Turn it on only if the machine sharing isn't also playing the call.
(Note the mechanism is the PulseAudio monitor of your default sink, reached through `pipewire-pulse`
on PipeWire systems — Chromium has no PipeWire audio backend of its own.)

Cozy also never asks the OS to mute local playback on Linux. Chromium implements that by muting
*every* sink on the machine — it compares a monitor-source name against sink names, which can never
match, so the "except the one we're capturing" case never fires. Under classic PulseAudio that
silences the capture too. The cost of avoiding it is that the film doesn't duck for the person
sharing it, exactly as on Windows.

**The floating overlays.** On **X11 they behave exactly as they do on macOS and Windows**: the faces
float above everything, and the control panel hides at the top of the screen and comes down when you
reach for it. Getting the second half took a different mechanism — Electron's `getCursorScreenPoint`
returns a stale answer on Linux ([electron#42519](https://github.com/electron/electron/issues/42519)),
so instead of polling for the pointer, the panel waits collapsed to a two-pixel sliver and being
*entered* is the event that opens it. The sliver is only as wide as the panel, so the rest of your
top edge stays clickable. (See the note above, though — X11 can't hide the overlays from a
whole-screen capture.)

**On Wayland they can't float at all, and that one is not ours to fix.** The compositor, not the
application, decides where windows go and what stays on top; every API this depends on —
`setAlwaysOnTop`, `setPosition`, `moveTop`, `showInactive`, and even *reading* a window's own
position — is a documented no-op there. The right primitive is `wlr-layer-shell`, which KDE, sway
and Hyprland implement, but GNOME's Mutter does not, it is not in `wayland-protocols` at any
stability level, and Chromium does not bind it. There is no version of Cozy that can make this work
from inside the app.

So on Wayland, Cozy draws the faces and the controls **inside the main window**. You lose the
ability to wander off into VLC and still see each other; everything else works.

If your compositor lets you force a window to stay on top yourself (KDE's Window Rules, or an
"always on top" keybinding), you can have the real overlays back:

```bash
COZY_FLOAT_OVERLAYS=1 cozy
```

They will open as separate windows again — floating only as far as your rules make them float, and
landing wherever the compositor puts them, because Cozy still cannot position them. It is off by
default because unassisted, that is worse than drawing them in-window.

**Video is encoded in software.** Chromium ships VA-API encoding disabled on Linux
(`kAcceleratedVideoEncodeLinux` is `DISABLED_BY_DEFAULT`), so a shared 1080p screen is encoded by
OpenH264 on the CPU — a warmer laptop, and libwebrtc will quietly scale you to 720p if it can't keep
up. Hardware *decode* is on by default, so receiving is fine. We don't force the flag on: Chromium's
own documentation says VA-API on Linux is unsupported, and it crashes the GPU process on some
drivers.

**Prefer the `.deb` if your distribution takes one.** It registers `cozy://` invite links, installs
an AppArmor profile so Chromium's sandbox works on Ubuntu 24.04+, and leaves updates to your package
manager. The AppImage runs anywhere but can't register invite links — AppImages install no desktop
file unless you use `appimaged` — and it launches with `--no-sandbox` when started from its desktop
entry.

**One more, on X11 without a compositor** (bare i3, openbox with no picom): Chromium can't get a
32-bit visual, so transparent windows render their background colour instead. The overlays would
appear as black rectangles. Run a compositor, or use the Wayland-style in-window overlays.

---

## Eight people maximum, and the sharer's upload is the real ceiling

Cozy is a full mesh: everyone sends to everyone. That's what keeps the server free and the latency
low, but a shared film is uploaded once *per viewer*. Four viewers at the full 6 Mbit/s ceiling
would want 24 Mbit/s of upstream, which almost no home connection has.

So the ceiling is divided as the room fills — 6 Mbit/s to one person, 3 to each of two, 2 to each of
three — with a floor of 1.2 Mbit/s below which a film stops being worth watching. Cameras are
unaffected; they're only ever a few hundred kbit/s each.

In practice: two or three is comfortable anywhere, four to six wants a decent upload, and past that
you'd need a media server — which is a monthly bill, which is the one thing this project won't have.

---

## Unsigned builds

macOS asks you to right-click → Open the first time; Windows shows a SmartScreen warning. Both are
the operating system telling you the app isn't signed, and both are a one-time click.

Signing certificates are an annual cost to *the project*, not to you — nothing about Cozy will ever
ask you for money. If the project takes them on later, `electron-builder.yml` is already set up for
it and no application code changes.
