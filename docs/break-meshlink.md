# Break MeshLink

> We recorded every radio frame of a private conversation and put it online.
> The encryption is open source. Read the messages, and the prize is yours.

MeshLink is an off-grid messenger on $3 ESP8266 boards. We say that nodes see only ciphertext, and that nobody outside your network can read your messages or inject into the mesh. This challenge is how we find out whether that is true.

## The capture

[`challenge/capture-v1.json`](challenge/capture-v1.json) holds every ESP-NOW frame from a short conversation between **Alice** and **Bob** on a private MeshLink network. It contains announces, direct messages, delivery receipts, a room invite and messages in a private room.

The capture includes everything a radio listener could record, and more:

- the full air frames (header, body and network tag) in hex, with timestamps,
- both people's **public** keys and fingerprints,
- the network id and channel,
- SHA-256 commitments of the hidden flags.

The capture was made with the same code that ships in the app (`desktop/scripts/make-challenge.ts`), so the frames are byte-for-byte real protocol v2 traffic. You have the full source code: [PROTOCOL.md](../PROTOCOL.md), the firmware and the app.

## Goals

Flags look like `MESHLINK{32 hex chars}`. The capture holds two of them.

| Tier | Goal | Proof | Prize |
|------|------|-------|-------|
| 1 | **Read the DM.** Recover the flag that Alice sent Bob in a direct message. | The flag. `sha256(flag)` must equal `commitments.dmFlag`. | **[PRIZE 1]** |
| 1 | **Read the room.** Recover the flag posted in the private room "ops". | The flag. `sha256(flag)` must equal `commitments.roomFlag`. | **[PRIZE 1]** |
| 2 | **Forge a DM.** Build a DM frame that Bob's app accepts as a message from Alice. | The frame in hex. We feed it to Bob's account. | **[PRIZE 2]** |
| 3 | **Get into the network.** Build any air frame that a node of this network accepts (its BLAKE2s tag verifies). | The frame in hex, with your handle in the body. | **[PRIZE 3]** |

A live round may follow: real nodes at a public event, open to radio attacks on site. It will be announced on the repository.

## Rules

- Work only with the published capture, the source code, and your own hardware. Do not attack other people's MeshLink nodes or accounts.
- The first person to send a valid proof for a goal wins that goal's prize. Each goal is paid once.
- Send proofs privately: **Security → Report a vulnerability** on GitHub ([direct link](https://github.com/imBloxi/meshlink/security/advisories/new)). Put "Break MeshLink" in the title. Do not post flags in public before we confirm and publish the result.
- Explain how you did it. A write-up is required for the prize, and we publish it (with credit) after the fix.
- The challenge runs from **[START DATE]** to **[END DATE]**, or until all goals are won.

### Out of scope

These are documented limits in [SECURITY.md](../SECURITY.md). They do not win prizes:

- traffic analysis (who sent how much, and when),
- the open network (netId 0), whose network key is public by design,
- attacks that need Alice's or Bob's computer, keys or nodes,
- the known open issue: **the signing key is not bound to the box key at first contact** (fix planned for 0.4),
- denial of service and jamming,
- social engineering of the maintainers.

A new, real attack that does not fit a tier still matters. Report it the same way, and we decide on a reward case by case.

## Why we do this

Security claims mean little until people try to break them. If you break MeshLink, you protect everyone who would otherwise trust it in a blackout, at a protest, or in the wilderness. If nobody breaks it, we can tell people that, too.

## For maintainers: running a new round

```
cd desktop
npx vite-node scripts/make-challenge.ts -- C:\path\outside\repo\challenge-secrets.json
```

This rewrites `docs/challenge/capture-v1.json`. Keep the secrets file offline until the round ends, because it holds the keys and the flags. Never reuse the keys of a round. To check a tier 2 or tier 3 proof, load Bob's key or the network key from the secrets file.
