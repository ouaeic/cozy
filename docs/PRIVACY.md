# What Cozy knows about you

Nothing. But "nothing" is easy to claim, so here is exactly what happens, and what the design makes
*impossible* rather than merely promised.

---

## Your video and audio never touch a server

Cozy is peer-to-peer. Your camera, your microphone and whatever you share go straight from your
computer to theirs, encrypted with DTLS-SRTP, which is mandatory in WebRTC and not something an
application can switch off.

The only exception is if you configure a TURN relay yourself, because your network won't allow a
direct connection. Even then the relay only ever sees encrypted packets — it forwards them without
being able to decrypt them.

---

## The introduction service can't read anything either

Two people have to find each other somehow. Cozy uses a small WebSocket service for that, and it is
built so there is nothing worth trusting it with.

Your invite code — `K4RWH7N`, seven characters — never leaves your computer. From it, both ends derive
two things independently:

```
room id  = PBKDF2-SHA256(code, "cozy-v2|room",   1,000,000 rounds) → 16 bytes
seal key = PBKDF2-SHA256(code, "cozy-v2|signal", 1,000,000 rounds) → AES-GCM-256
```

The server is handed only the **room id**. Every message it relays is **AES-GCM sealed** with the
key. So the server:

- can't read your session descriptions — and those contain your IP addresses
- can't join your room, because it can't produce a payload either of you would accept
- can't sit in the middle of the handshake, for the same reason

### Why the derivation is deliberately slow

This is the part that is easy to get wrong, so here it is plainly.

A seven-character code is about 171 million combinations — roughly 27 bits. That is small. If the
room id were a plain SHA-256 of it, anyone holding a room id could try every code and find the one
that produced it in **about four minutes on one CPU core**. A server that quietly kept room ids and
sealed payloads could then go back and read everything it had relayed.

So both values are stretched through a million rounds of PBKDF2. That costs the two of you a
fraction of a second, once, on a screen where you are already waiting for each other. It costs an
attacker hours of GPU time **per room**.

Hours, not centuries — and it matters to say so. The rest of the defence is the shape of the thing:
a code is used once, and the room it opens exists only while somebody is sitting in it, usually a
few minutes. Stretching is what makes that window real rather than decorative.

The moment two people connect, they each contribute sixteen random bytes over the encrypted channel
and combine them into a 256-bit secret that neither side chose alone. That is what gets remembered,
and every evening after the first uses it instead — with no short code involved anywhere, and
nothing left worth grinding. The short code guards a window of minutes; the long secret guards the
relationship.

**What this does not defend against.** Someone who is genuinely in the middle of your very first
handshake — able to intercept and rewrite traffic in real time, not merely watch it — could pair
with each of you separately, and Cozy does not currently show a phrase you could read to each other
to catch it. Every evening after that is protected by the secret the two of you already share.

It is a dumb pipe that moves opaque blobs between two hashes. Read it — it's about a hundred lines,
in [`server/worker.ts`](../server/worker.ts).

---

## And it never learns more than that

Once your two computers are talking directly, Cozy opens an encrypted data channel between them and
keeps the server connection open only so that other people can still find the room and everyone
hears when someone leaves. Everything that carries meaning — starting a
share, mute state, quality negotiation, remembering each other — is peer-to-peer.

The server is re-contacted only if the direct connection breaks and needs re-establishing.

A whole evening is roughly six small messages, none of which the server can open.

---

## No accounts, no analytics, no phoning home

There is no sign-up, no email address, no user id, no crash reporting, no usage metrics, no
telemetry endpoint, and no third-party script anywhere in the app. The only outbound connections
Cozy ever makes are:

- your peer, directly
- the introduction service, briefly
- STUN servers (Google and Cloudflare), which learn only that some IP asked what its own public
  address is — the standard, unavoidable cost of peer-to-peer
- GitHub Releases — checked automatically about fifteen seconds after launch and once a day while
  the app is running, for release metadata only. Packaged Windows and Linux AppImage builds do this;
  macOS and `.deb`/`.rpm` installs never contact it at all (`src/main/updater.ts`). **Settings →
  Updates turns it off**, and then Cozy contacts GitHub never
- a TURN relay, only if you configured one

---

## What's stored on your computer

One file, `cozy.json`, in your user data directory. It holds your display name, your volume balance,
your window preferences, your partner's name, the invite secret the two of you share so you don't
have to type a code again — and, **if you configured your own TURN relay, its address, username and
password, stored in plain text.** No account passwords, because there are no accounts; but that last
one is worth knowing before you attach `cozy.json` to a bug report.

Delete it and Cozy forgets everything. **Forget \<name\>** on the home screen does the same for the
pairing alone.

---

## Reporting something

If you find a way the server could learn more than described here, that's a real bug and worth
raising as a security issue rather than a normal one.
