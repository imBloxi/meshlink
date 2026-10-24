# Security policy

MeshLink is a messenger for people who may not have the internet. Bugs in it can put people at risk, so we take reports seriously.

## Reporting a vulnerability

**Do not open a public issue for a security bug.**

Report it privately through GitHub: **Security → Report a vulnerability** on [imBloxi/meshlink](https://github.com/imBloxi/meshlink/security/advisories/new).

Please include:

- the component (firmware, desktop app, Python app, protocol),
- the version (Settings → About shows the app, bundled firmware and node firmware versions),
- steps to reproduce, or a proof of concept,
- what an attacker gains.

What to expect:

| When | What |
|------|------|
| 3 days | We confirm that we received the report. |
| 14 days | We tell you whether we accept it, and our plan. |
| 90 days | Latest date for a fix and public advisory. We agree a date with you. |

We credit reporters in the advisory and in [CHANGELOG.md](CHANGELOG.md), unless you prefer to stay anonymous. Reports that qualify for the [Break MeshLink challenge](docs/break-meshlink.md) are also eligible for its prize.

## Supported versions

Only the latest release gets security fixes. MeshLink is pre-1.0, and the protocol can still change between minor versions.

| Version | Supported |
|---------|-----------|
| 0.4.x (latest) | Yes |
| < 0.4 | No. Update the app and reflash your nodes. |

## Threat model

### What MeshLink protects

| Asset | Protection |
|-------|------------|
| Message content (DMs) | NaCl `box` (X25519 + XSalsa20-Poly1305), end to end. Nodes relay ciphertext only. |
| Who a DM is for | Hidden: no recipient field. Receivers try each contact's key (trial decryption). |
| Message length and type | Hidden: every DM and room frame is padded to 225 bytes inside the encryption. Texts, invites and delivery receipts look the same. |
| Room content | Shared 32-byte room key (XSalsa20-Poly1305). Every message is signed with Ed25519. Kicking a member rotates the key. |
| Mesh membership | Every air frame carries a keyed BLAKE2s tag (network key). Nodes drop frames that fail the tag. |
| Keys at rest | Windows DPAPI (current user). |
| History and contacts at rest | Encrypted with a data key that DPAPI protects: message text and sender, contacts, settings, rooms, networks. Lookup columns hold keyed hashes, so the database file shows no fingerprints, room ids or names. `secure_delete` overwrites deleted rows. |
| Nodes on your home network | Silent by default: guests, discovery, the web page and mDNS work only on the node's own hotspot. |
| Account backups | Argon2id (64 MiB, 3 passes) + NaCl `secretbox`. |
| Node firmware in the app | SHA-256 checked before flashing. |

### What MeshLink does NOT protect (known limits)

- **Traffic analysis.** Anyone with a radio can see that MeshLink traffic exists, when, how many frames, and which node sent each one first (the chip id is in every header). Rooms use one 4-byte tag per key epoch, so frames of one room can be grouped. Message length is hidden.
- **Metadata on disk.** The database file still shows how many messages you have, their timestamps and delivery state, and how many contacts and rooms.
- **Names in announces.** Your display name and public key are broadcast in clear so others can find you. Stealth mode stops automatic announces.
- **Forward secrecy.** Keys are static. If someone steals your key later, they can decrypt messages they recorded earlier.
- **The open network (netId 0).** Its network key is all zeros, so anyone can inject frames into it. Use your own network for real use.
- **First contact (trust on first use).** A new contact is unverified until you compare the safety number in person.
- **A compromised PC.** Malware running as your Windows user can read your keys through DPAPI.
- **Physical access to a node.** The USB host of a node is its admin. A node stores its network key and Wi-Fi passwords in flash, unencrypted.
- **Panic wipe on SSDs.** Wipe deletes the files. SSD wear-levelling can keep old blocks readable with forensic tools.
- **Jamming.** Nobody can stop radio jamming.

### Hardening in 0.4.0

Two internal audits before the open-source release found these issues. All of them are fixed in 0.4.0:

| Severity | Component | Issue | Fix |
|----------|-----------|-------|-----|
| High | App | Room creator takeover: invites did not carry the creator's signing key. A member with the room key could send a JOIN that claimed the creator's fingerprint with their own key, and then promote, kick and delete for every member who joined later. | Invites (v2) carry the creator's signing key, which joiners pin. A contact's announced key wins over a JOIN key. A JOIN can only introduce a key for the fingerprint of the box key it carries, and never for the creator. |
| High | App | A kicked room member could keep posting: the previous key was accepted with no time limit. | The previous key is accepted for 10 minutes after a rotation, and never from removed members. |
| High | Firmware | Stack buffer overflow: the USB output buffer had 298 bytes, but ban list and config replies can have 400. 32 guest bans, which the network owner can push remotely, were enough. | The output buffer fits the largest reply, and larger frames are refused. |
| High | Firmware | Guests from the home network: with home Wi-Fi configured, anyone on that router network could connect as a guest (full permission by default) and send frames tagged with the network key. | Guests are accepted only from the node's own hotspot unless the admin turns on `lanGuests`. Discovery, the web page and mDNS follow the same rule. |
| High | App | Rogue node: the app believed a Wi-Fi node that claimed the admin role, and offered to send it the network key. | Only a USB node can be admin. Config, session and ban replies from Wi-Fi nodes are ignored. |
| Medium | App | Signed room moderation frames had no freshness check, so they could be replayed after an app restart (for example to re-promote a demoted moderator). | Frames older than 24 hours, or not newer than the last one applied from that sender, are refused. The last applied time is stored with the room. |
| Medium | App | A network code with a known network id replaced that network's key and owner key. | The app refuses such a code. |
| Medium | Firmware | Connections that never authenticated kept their guest slot, so four of them blocked the node. | Unauthenticated connections are closed after 5 seconds. |
| Medium | App | A flood of announces with new keys grew the contact list without limit, and every DM is tried against every contact. | At most 20 new contacts per minute and 1000 in total. |
| Medium | App | A new key could use the name of a contact you verified. | Such announces are ignored with a warning. |
| Medium | App | Each replayed DM frame made the app send a new delivery receipt. | At most 3 extra receipts per message. |
| Medium | Firmware | Duplicate detection remembered 128 frames, so captured frames could be replayed soon after. | It remembers 512 frames. Replays are also caught by the app (nonces and stored message ids). |
| Medium | App | Frame size showed message length, and told texts apart from receipts. | All DM and room frames are padded to 225 bytes. |
| Low | App | Contact names, fingerprints, conversation ids and settings were stored in clear in the database. | Encrypted, with keyed hashes for lookups (see "What MeshLink protects"). |
| Low | App | Node Wi-Fi profiles, with their passwords, stayed in Windows. | The app deletes the profile when it leaves the node. |
| High | Firmware | HTTP path traversal: `GET /../cfg.bin` could return the node config with the network key, the hotspot password and the router Wi-Fi password. | Only plain paths under `/www` are served. |
| Medium | Firmware | Duplicate detection and the per-origin rate limit ran before the network tag check. An outsider could copy a real `msgId` into a forged frame to suppress the real frame, or spoof a node's origin to use up its rate budget. | The tag is checked first. Only frames that pass the check update dedupe or rate state. |
| Medium | App | DM reflection: the box key is the same in both directions, so a replayed copy of your own DM opened as if your contact sent it. | The app remembers the nonces of its own frames. |
| Medium | App | An announce that carries a known contact's box key but a different signing key could rename the contact. | Announces signed with another key than the pinned key are ignored and cause a warning. Older announces cannot roll back the name. |
| Low | App | No check of which page made an IPC call. Driver install accepted any bridge name. | IPC calls are accepted only from the app's own top-level page. Driver names are checked against a fixed list. |
| Low | App | No Electron fuses. | `RunAsNode`, `NODE_OPTIONS` and `--inspect` are disabled. ASAR integrity is checked, and the app loads only from its ASAR. |
| Low | App | A crafted backup file could request a huge Argon2 parallelism value. | The `m`, `t` and `p` parameters are bounded. |
| Low | Firmware | The node name was not escaped on the node's web page. | The name is HTML-escaped. |

### Open issue (planned for 0.4)

**The signing key is not bound to the box key.** A contact's identity is the fingerprint of their X25519 box key. Their Ed25519 signing key comes from their first signed announce, and nothing proves that both keys belong to the same person. Suppose an attacker announces your public box key with their own signing key before a peer first hears from you. Then that peer pins the attacker's signing key for your fingerprint, and room messages the attacker signs show as "verified" from you. DMs are not affected, because they need your box secret key. The pinning rules stop this attack after first contact, not before it. Since 0.4.0, a room creator's key comes from the invite, and a contact's announced key wins over a room JOIN, which narrows the attack to room members who are not your contacts. The planned fix puts the signing key into the fingerprint and the safety number, which changes the protocol.

Until then, compare safety numbers in person (Contact → Verify). Treat room messages from unverified contacts with care.
