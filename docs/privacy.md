# How MeshLink protects your privacy

This page explains, layer by layer, what MeshLink hides, from whom, and how. It also lists what it cannot hide. Every claim here matches the code: the wire format is in [PROTOCOL.md](../PROTOCOL.md), the threat model and audit history are in [SECURITY.md](../SECURITY.md).

MeshLink is pre-1.0 and has not had an independent audit. Treat it as a strong design, not a guarantee.

## The short version

| Who is looking | What they can see | What they cannot see |
|---|---|---|
| Someone with a radio receiver in range | That MeshLink frames exist, when they were sent, how many, and which node sent each one first. | What a message says, who a DM is for, how long it is, or whether it is a text, an invite or a receipt. |
| A node that relays your frames | Ciphertext and the frame header. | Any message text, any account key. Nodes hold no keys for your conversations. |
| Someone outside your network | That a radio signal exists. | Nothing they send gets in: nodes drop frames without a valid network tag. |
| Someone who copies your database file | How many messages, contacts and rooms you have, their timestamps and delivery state. | Message text, senders, contact names, fingerprints, room ids, settings. |
| A guest on a node's Wi-Fi hotspot | A per-network pseudonym key. | Your account fingerprint. The pseudonym differs on every network. |
| An impostor in radio range | Your public name and public keys, if you announce. | Your secret key. They cannot take over your fingerprint (see "Identity" below). |

## 1. Message content

Direct messages use NaCl `crypto_box`: X25519 key agreement and XSalsa20-Poly1305 encryption between the two accounts' keys. The app encrypts before anything leaves your PC. Nodes see only the result.

Room messages use a shared 32-byte room key with XSalsa20-Poly1305, and every room message is also signed with Ed25519, so members can tell who wrote what. Removing a member rotates the room key. The old key works for 10 more minutes (so slow messages still arrive) but never for the removed member.

## 2. Who a message is for

A DM frame has **no recipient field**. A receiver tries the shared key of each of its contacts on every DM frame it hears. A frame that opens with nobody's key is ignored. A listener cannot tell whom a DM is for by reading it, and cannot tell it from a DM meant for someone else.

Trade-off: every DM is tried against every contact, so the contact list is bounded (20 new contacts per minute, 1000 in total) to stop someone from flooding you with fake identities.

## 3. Message length and type

Every DM and room frame on the air is exactly **225 bytes**. The message is padded inside the encryption. A short "ok", a long text, a room invite and a delivery receipt all look the same on the air. Long messages are split into chunks that also fill 225 bytes.

## 4. Mesh membership

Every air frame carries an 8-byte keyed BLAKE2s tag made with the network key. Nodes check the tag first and drop anything that fails. Duplicate detection and rate limits only count frames that passed, so an outsider cannot use forged frames to suppress real ones or use up another node's rate budget.

The open network (`netId 0`) has an all-zero key by design, so anyone can inject frames into it. Use your own network for real use.

## 5. Identity

Your identity is a fingerprint, shown as `C50D 124A 8AAF 41A1`. Since protocol v3 (0.4.2) it covers **both** your keys:

```
fingerprint = BLAKE2b-64("ml-fp-v3" | boxPk | signPk)
```

- `boxPk` is the X25519 key for encryption. `signPk` is the Ed25519 key for signatures. Both come from one 32-byte account secret.
- Announcing someone's box key with a different signing key produces a **different fingerprint**. An attacker can no longer get a peer to pin their signing key as "you", which in older versions let them sign room messages that looked verified.
- The **safety number** you compare in person (Contact → Verify) is derived from the two fingerprints, so it covers both keys of both people.
- A display name proves nothing. Contacts are keyed by fingerprint, never by name. A new key that uses the name of a contact you verified is ignored with a warning.

Limit: the fingerprint is 64 bits. Compare safety numbers in person for contacts that matter.

## 6. Your Wi-Fi and your home network

- A node's Wi-Fi hotspot is the only place guests and discovery work. A node on your home router stays silent unless the admin turns on `lanGuests`.
- The app never switches your Wi-Fi to a node's hotspot unless you allow it.
- Guests log in with a **per-network pseudonym**: `seed = BLAKE2b-256("ml-guest-v1" | netId | account secret)`. It is the same on every visit, cannot be linked to your account fingerprint, and differs between networks.
- Only a USB-connected node can be an admin. The app ignores admin claims from Wi-Fi nodes.
- Node Wi-Fi profiles, with their passwords, are deleted from Windows when the app leaves the node.
- **Home Wi-Fi mode** (Connect → Home Wi-Fi) is off until you choose it. While it is on, the app broadcasts MeshLink frames on your router's subnet, so everyone on that Wi-Fi can see that MeshLink runs, how often you send, and your announces (display name and public keys, as on the radio). Messages stay end-to-end encrypted and are tagged with your network key. The app tries to skip VPN and virtual adapters by their names (a VPN with an ordinary name is not detected), uses a random id for each session, and sends no beacons in stealth mode. Your stable public keys in the announces still link you across sessions. See [lan.md](lan.md).

## 7. What stays on your computer

| Data | Protection |
|---|---|
| Account secret | Windows DPAPI, tied to your Windows user. |
| Messages, senders, contacts, rooms, networks, settings | Encrypted with a data key that DPAPI protects. |
| Lookup columns (conversation, message id, record id) | Keyed hashes, so the file shows no fingerprints, room ids or names. |
| Deleted rows | `secure_delete` overwrites them. |
| Account backups | Argon2id (64 MiB, 3 passes) and NaCl `secretbox`. |
| Notifications | Windows only shows "New message". |
| Internet | The app makes no requests unless you turn on update checks or other features. |

Also encrypted on Android: NodeLink keeps its account snapshot behind an Android Keystore key (see [mobile/README.md](../mobile/README.md)).

## 8. Replays and reflection

- Receivers drop nonces they have seen, so a captured DM replayed later is not shown twice. A replayed copy of a message you already have gets at most 3 extra delivery receipts.
- The box key is the same in both directions, so a copy of your own DM played back to you could look like it came from your contact. The app remembers the nonces of its own frames and ignores them.
- Room moderation frames (promote, kick, delete, leave) older than 24 hours, or not newer than the last one applied from that sender, are refused, even after an app restart.

## What MeshLink does not hide

Read these before you rely on it.

- **That you use MeshLink, and when.** Radio traffic is visible. A listener sees when frames are sent, how many, and which node sent each first (the chip id is in the header). Frames of one room share a 4-byte tag per key epoch, so they can be grouped.
- **Your presence on a home network.** In Home Wi-Fi mode, anyone on the same router can see that you use MeshLink, when you send and how many frames. Do not use it on a Wi-Fi you do not trust.
- **Your announces.** Your display name and public keys are broadcast in clear so others can find you. Stealth mode stops automatic announces.
- **Forward secrecy.** Keys are static. Someone who steals your key later can decrypt traffic they recorded earlier.
- **A compromised PC.** Malware running as your Windows user can use your keys through DPAPI.
- **Physical access to a node.** A node stores its network key and Wi-Fi passwords in flash, unencrypted, and a USB host is its admin.
- **Metadata on disk.** The database still shows message counts, timestamps and delivery state.
- **Panic wipe on SSDs.** Wipe deletes files. Wear-levelling can leave old blocks readable by forensic tools.
- **Jamming.** Nobody can stop radio jamming.
- **First contact.** A new contact is unverified until you compare the safety number in person.

## Check it yourself

- Read the code: `desktop/src/core` holds the crypto and protocol, `firmware/src` holds the node.
- Break it: a full radio capture of a private conversation is published in [Break MeshLink](break-meshlink.md).
- Report a flaw privately: see [SECURITY.md](../SECURITY.md).
