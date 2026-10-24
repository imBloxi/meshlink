# MeshLink Protocol v2

This document describes what MeshLink 0.4 sends on the radio, over USB and over Wi-Fi. The code is the reference: `firmware/src/protocol.h`, `desktop/src/core/protocol.ts` and `desktop/src/core/payloads.ts`.

MeshLink has three layers. Each layer trusts only what it can check.

```
 desktop app  ── USB serial or Wi-Fi WebSocket (host frames) ──  ESP8266 node  ~~ ESP-NOW (air frames) ~~  other nodes
      \__________________________ app payload, end-to-end encrypted, fixed size ___________________________/
```

- **Nodes** never see plaintext. They check a network tag, remove duplicates, rate-limit and relay.
- **Apps** encrypt and sign everything that carries content. Every DM and room frame on the air has the same size.

All integers are little-endian.

## 1. Air frames (node to node)

ESP-NOW broadcast on the network's channel (default 6). A frame has at most 250 bytes:

```
[ header 17 ][ body ≤ 225 ][ tag 8 ]
```

| Offset | Size | Field | Notes |
|-------:|-----:|-------|-------|
| 0 | 1 | magic | `0x4D` (`M`) |
| 1 | 1 | version | `2` |
| 2 | 1 | type | `0x01` BEACON, `0x02` DM, `0x03` ANNOUNCE, `0x04` ROOM, `0x06` POLICY |
| 3 | 1 | ttl | Relays left. Default 3, max 7. BEACON uses 0. |
| 4 | 4 | msgId | Random, never 0. Used for duplicate detection. |
| 8 | 4 | origin | Chip id of the node that first sent the frame. |
| 12 | 4 | netId | Network id. `0` is the open network. |
| 16 | 1 | flags | Bit 0: priority (shorter relay delay). |
| 17 | ≤225 | body | Opaque to nodes, except POLICY. |
| end | 8 | tag | `BLAKE2s-64(key = netKey, frame without tag, with ttl set to 0)` |

The TTL is left out of the tag because every relay changes it.

**Receive and relay rules**, in this order:

1. Drop the frame if magic or version is wrong, if `msgId` is among the last 512 IDs seen, or if `origin` is a banned chip.
2. Another `netId`: never deliver it. If `relayForeign` is on and the network is not banned, relay it blindly (per-origin rate limit applies).
3. Same `netId`: check the tag. Drop the frame on a mismatch. The tag is checked **before** the frame updates duplicate or rate-limit state. A forged frame cannot suppress a real one or use up a node's budget.
4. Remember `msgId`, apply the per-origin rate limit, deliver the frame to all hosts, apply a POLICY frame (section 4.6), and relay with `ttl − 1` after a random delay of 0 to `jitterMs`.

The open network has an all-zero key, so anyone can send into it. Content is still end-to-end encrypted.

## 2. Host frames (app to node)

### 2.1 USB serial

115200 8N1. Each frame is `COBS(type, payload…, crc16_lo, crc16_hi)` followed by `0x00`. The CRC is CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`) over type and payload. Frames that fail COBS decoding or the CRC are dropped, so ESP8266 boot noise is ignored. Host frames have at most 400 bytes.

The USB host is the node's **admin**. Physical access means control.

### 2.2 Wi-Fi (WebSocket, port 81)

One binary WebSocket message carries one host frame, with no COBS and no CRC. Wi-Fi clients are **guests**:

1. The node checks the client's address. Only clients on the node's own hotspot are accepted, unless the admin turned on `lanGuests`.
2. The node sends `HELLO` with a 16-byte random nonce.
3. The app answers with `AUTH`: a per-network guest key `pk` and an Ed25519 signature over `"ml-auth" | nonce | chipId`. The guest key is derived as `seed = BLAKE2b-256("ml-guest-v1" | netId | account secret)`. It is the same on every visit, cannot be linked to your account fingerprint, and differs between networks.
4. The node replies `AUTH_OK` with the role and permission. A connection that does not authenticate within 5 seconds is closed.

Guest permissions: `0` read only, `1` DMs and announces, `2` everything (default). Each guest has a send rate limit (frames per minute).

### 2.3 Frame types

| Type | Direction | Payload |
|------|-----------|---------|
| `0x10` SEND | app → node | `airType(1) flags(1) body(≤225)` |
| `0x11` INFO_REQ | app → node | empty |
| `0x12` CONFIG_GET | admin → node | empty |
| `0x13` CONFIG_SET | admin → node | TLV list (2.4) |
| `0x14` AUTH | guest → node | `pk(32) sig(64)` |
| `0x15` KICK | admin → node | `pseudo(8)`: first 8 bytes of a guest key |
| `0x16` BAN / `0x17` UNBAN | admin → node | `kind(1) id`: kind 1 guest (8 bytes), 2 chip (4), 3 network (4) |
| `0x18` SET_PERM | admin → node | `pseudo(8) perm(1)` |
| `0x19` SESSIONS_REQ | admin → node | empty |
| `0x1A` STATUS_REQ | app → node | empty |
| `0x1B` REBOOT / `0x1C` FACTORY_RESET | admin → node | empty |
| `0x1D` BANS_REQ | admin → node | empty |
| `0x20` RECV | node → app | `airType(1) ttl(1) origin(4) msgId(4) flags(1) body` |
| `0x21` INFO | node → app | `version(1) chipId(4) mac(6) channel(1) fwLen(1) fw role(1) perm(1) netId(4) nameLen(1) name` |
| `0x22` LOG | node → admin | UTF-8 text |
| `0x23` SENT | node → app | `msgId(4)` |
| `0x24` CONFIG | node → admin | TLV list |
| `0x26` STATUS | node → app | `uptime freeHeap rx relayed dropTag dropRate` (6 × u32), `guests(1) apOn(1) sta(1) staIp(4) apIp(4) channel(1) rssi(i8)` |
| `0x28` SESSIONS | node → admin | `count(1)`, then per guest `pseudo(8) perm(1) secs(4) tx(2) rx(2)` |
| `0x29` HELLO | node → guest | `nonce(16) chipId(4) netId(4) nameLen(1) name` |
| `0x2A` AUTH_OK | node → guest | `role(1) perm(1)` |
| `0x2B` BANS | node → admin | `count(1)`, then `kind(1) len(1) id` |
| `0x2C` KICKED | node → guest | `reason(1)` |
| `0x2F` ERR | node → app | `code(1) text`: 1 admin only, 2 bad frame, 3 too fast, 4 auth failed, 5 node full, 6 banned |

The app treats a node as admin **only over USB**. A Wi-Fi node that claims the admin role is ignored, so a cloned hotspot cannot obtain your network key.

### 2.4 Node config (TLV)

`id(1) len(1) value`, repeated. Unknown ids are skipped.

| Id | Field | Type | Id | Field | Type |
|---:|-------|------|---:|-------|------|
| 1 | nodeName | str ≤32 | 13 | guestMax | u8, 1–4 |
| 2 | netId | u32 | 14 | guestRate | u8, frames/min, 0 = no limit |
| 3 | netKey | 16 bytes | 15 | relayForeign | bool |
| 4 | channel | u8, 1–13 | 16 | beaconSec | u8, 0 = off |
| 5 | apSsid | str | 17 | ttl | u8, ≤7 |
| 6 | apPsk | str, 0 or ≥8 | 18 | jitterMs | u8 |
| 7 | apHidden | bool | 19 | originRate | u8, frames/s per origin |
| 8 | apEnabled | bool | 20 | stealth | bool: no beacons, hidden hotspot |
| 9 | staSsid | str | 21 | netName | str ≤32 |
| 10 | staPsk | str | 22 | policySeq | u32 |
| 11 | ownerPk | 32 bytes or empty | 23 | apOpen | bool |
| 12 | guestPerm | u8, 0–2 | 24 | lanGuests | bool, default off |

With `lanGuests` off (the default), the node serves guests, UDP discovery, its web page and mDNS **only on its own hotspot**. On the home router network it stays silent.

### 2.5 Discovery

UDP port 4210. Request `"MLDISCOVER"`. Answer `"MLNODE" chipId(4) netId(4) nameLen(1) name`. Same address rule as guests.

## 3. Padding

Every DM and ROOM body on the air is exactly **225 bytes**, so a listener cannot tell a short text from a long one, or a message from a delivery receipt.

Padding is added inside the encryption. The sender sets bit `0x80` of the chunk `kind` and appends `0x80` followed by zeros (ISO/IEC 7816-4) to fill the frame. The receiver strips the trailing zeros and the `0x80`, and rejects the frame if the marker is missing. Frames without the bit (from 0.3 apps) are read as before.

## 4. App payloads (air frame body)

### 4.1 Chunks

Messages longer than one frame are split into chunks. Every DM and ROOM plaintext starts with:

```
kind(1) ts(4) group(4) idx(1) total(1)
```

`group` is a random message id. `ts` is the sender's Unix time in seconds. A message has at most 255 chunks. Chunks are reassembled for up to 30 seconds.

### 4.2 ANNOUNCE (`0x03`), signed identity

```
boxPk(32) signPk(32) ts(4) flags(1) nameLen(1) name(≤32) sig(64)
sig = Ed25519(signKey, "ml-announce" | everything before sig)
```

- Identity is the fingerprint `BLAKE2b-64(boxPk)`, shown as `C50D 124A 8AAF 41A1`. The name proves nothing.
- The signing key is derived from the account secret: `seed = BLAKE2b-256("meshlink-sign-v1" | secret)`.
- After first contact the app pins the signing key. It ignores announces signed with another key and announces older than the newest one seen.
- A new key that uses the name of a contact you **verified** is treated as an impostor and ignored with a warning.
- Announces are sent on connect and every 60 seconds by default. In stealth mode they are never sent automatically.

### 4.3 DM (`0x02`), hidden recipient

```
nonce(24) crypto_box(chunk)        // always 225 bytes
```

NaCl `crypto_box` (X25519 + XSalsa20-Poly1305) between the two accounts' box keys. There is no recipient field: receivers try the shared key of each contact (trial decryption). A frame that opens with nobody's key is ignored.

| Kind | Meaning | Payload |
|-----:|---------|---------|
| `0x01` | text | UTF-8 |
| `0x02` | ACK | `group(4)` of the received message |
| `0x03` | room invite | invite code (UTF-8) |
| `0x04` | room key | `roomId(16) epoch(4) key(32)`, accepted only from the room's creator or a moderator |
| `0x05` | network invite | network code (UTF-8) |

Delivery: text and invites are resent after 2 and 6 seconds and marked failed after 10 seconds. Receivers drop nonces they have seen. A replayed copy of a received message is answered with at most 3 extra ACKs.

### 4.4 ROOM (`0x04`)

```
roomTag(4) nonce(24) secretbox(inner)    // always 225 bytes
inner = chunk header, senderFp(8), payload + padding, [sig(64) on the last chunk]
sig   = Ed25519("ml-room" | roomId | epoch | senderFp | kind | ts | group | payload)
roomTag = BLAKE2b-32("ml-room-tag" | roomId | epoch)
```

- **Private room**: random 16-byte id and 32-byte key, shared by invite.
- **Public room**: `seed = "ml-pub" | netId | name`, `key = BLAKE2b-256(seed)`, `id = BLAKE2b-128("id" | seed)`. Anyone who knows the name can read a public room.

| Kind | Meaning | Payload |
|-----:|---------|---------|
| `0x01` | text | UTF-8 |
| `0x02` | join | `signPk(32) boxPk(32) name` |
| `0x03` | leave | empty |
| `0x04` | moderator | `targetFp(8) role(1)`: creator only |
| `0x05` | delete | `authorFp(8) group(4)`: the author or a moderator |
| `0x06` | kick | `targetFp(8)`: creator or moderator, then the key rotates |

Rules that receivers apply:

- **Signing keys.** The creator's key comes from the invite. A contact's announced key wins over a key from a JOIN. A JOIN can only introduce a key for the fingerprint of the box key it carries, and never for the creator.
- **Kicks.** A kick rotates the key (`epoch + 1`) and sends the new key by DM to every remaining member. The old key is accepted for 10 more minutes, but never from a removed member.
- **Moderation freshness.** Moderator, kick, delete and leave frames older than 24 hours, more than 10 minutes in the future, or not newer than the last one applied from the same sender are refused. The last applied time is stored with the room, so replays fail even after a restart.

### 4.5 Invite codes

Room invite, `mlr1:` + base64url:

```
v1: 01 roomId(16) key(32) epoch(4) netId(4) expires(4) creatorFp(8)                    nameLen(1) name inviterSignPk(32) sig(64)
v2: 02 roomId(16) key(32) epoch(4) netId(4) expires(4) creatorFp(8) creatorSignPk(32)  nameLen(1) name inviterSignPk(32) sig(64)
sig = Ed25519(inviter, "ml-invite" | everything before sig)
```

0.4 apps write v2 and read both.

Network code, `mln1:` + base64url:

```
01 netId(4) key(16) channel(1) hasOwner(1) [ownerPk(32)] nameLen(1) name
```

The app refuses a network code whose key or owner differs from a network it already has.

### 4.6 POLICY (`0x06`), signed by the network owner

```
seq(4) count(1) entries[ op(1: ban, 2: unban) kind(1) id ] sig(64)
sig = Ed25519(ownerKey, "ml-policy" | netId | everything before sig)
```

Nodes with an `ownerPk` apply a policy only if the signature checks and `seq` is greater than the last applied `policySeq`.

## 5. Compatibility

| | Reads 0.3 frames | 0.3 reads its frames |
|---|---|---|
| 0.4 app | Yes (unpadded DMs and rooms, v1 invites) | No: 0.3 apps cannot read padded DMs and room messages |

Update every app on a network to 0.4 together. The air frame format and the firmware protocol version (`2`) did not change, so 0.3 and 0.4 nodes relay each other's traffic.

The Python app in `app/` speaks protocol **v1** (12-byte header, unsigned announces). It works only with 0.1 firmware and is kept for reference.
