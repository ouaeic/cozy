# Reporting a security issue

Please **don't** open a public issue for anything security-sensitive. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository (Security → Report a vulnerability), which is visible only to maintainers.

Expect a first reply within a week. This is a small project maintained by people with day jobs;
there is no on-call rotation and it would be dishonest to imply one.

## What's in scope

Cozy carries private conversations, so the parts worth your attention are:

- **The signalling path** — `src/renderer/core/crypto.ts`, `signal.ts`, `server/worker.ts`,
  `server/serve.mjs`. The design intends that a signalling server learns nothing: it sees a room id
  derived from a secret it never receives, and every payload is sealed. Anything that breaks that
  is the most interesting bug you can find here.
- **The invite code** — seven characters, about 27 bits. Both derivations are stretched with a
  million rounds of PBKDF2 precisely because the code is short. If you can enumerate rooms faster
  than `docs/PRIVACY.md` claims, that's a real finding.
- **The pairing upgrade** — the 256-bit secret two people derive on first contact.
- **Anything that puts media, SDP, or an IP address somewhere the docs say it doesn't go.**
- **Renderer isolation** — `contextIsolation` is on and `nodeIntegration` off; a way around either
  matters, especially via a peer-controlled string.

## Known and documented, so not a report

These are written up in [docs/LIMITATIONS.md](docs/LIMITATIONS.md) and are deliberate:

- There is no TURN relay, so roughly 5–10% of network pairs can't connect directly.
- A determined attacker with a GPU can grind a single room id in hours rather than centuries. The
  code is single-use and the room lives only while somebody waits in it; that's the trade.
- A genuine man-in-the-middle on the *first* handshake can pair with each side separately. There is
  no safety phrase to catch it yet. We'd welcome a good design for one.
- On Linux, the floating overlays are visible in a whole-screen capture — the platform gives us no
  way to exclude them.
- Builds are unsigned.
