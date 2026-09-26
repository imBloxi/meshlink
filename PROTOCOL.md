# MeshLink Protocol v1

MeshLink has three layers. Each layer only trusts what it can verify.

```
Windows app  <-- USB serial (host frames) -->  ESP8266 node  <~~ ESP-NOW (air frames) ~~>  other nodes
     \______________________ app payload, end-to-end encrypted ______________________/
```

All integers are little-endian.

## 1. Air frames (node to node, ESP-NOW broadcast, channel 6)

Max 250 bytes. Header is 12 bytes, so the body is at most 238 bytes.

| Offset | Size | Field   | Notes |
|-------:|-----:|---------|-------|
| 0 | 1 | magic   | `0x4D` |
| 1 | 1 | version | `1` |
| 2 | 1 | type    | `0x01` BEACON, `0x02` DATA, `0x03` ANNOUNCE |
| 3 | 1 | ttl     | Relays left. Default 3. BEACON uses 0. |
| 4 | 4 | msgId   | Random, never 0. Used for dedupe. |
| 8 | 4 | origin  | Chip id of the first sender. |
| 12 | ≤238 | body | Opaque to nodes. |

Relay rule: a node drops a frame whose `msgId` is in its last 64 seen IDs. Otherwise it passes the frame to its host and, if `ttl > 0`, rebroadcasts it with `ttl - 1`.

## 2. Host frames (app to node, USB serial 115200 8N1)

Each frame on the wire: `COBS(type, payload..., crc16_lo, crc16_hi)` followed by `0x00`.
CRC is CRC-16/CCITT-FALSE (poly `0x1021`, init `0xFFFF`) over `type` and `payload`.
Frames that fail COBS decoding or CRC are dropped. Boot noise from the ESP8266 is dropped this way.

| Type | Direction | Payload |
|------|-----------|---------|
| `0x10` SEND     | app to node | `airType(1) body(≤238)` |
| `0x11` INFO_REQ | app to node | empty |
| `0x20` RECV     | node to app | `airType(1) ttl(1) origin(4) msgId(4) body` |
| `0x21` INFO     | node to app | `version(1) chipId(4) mac(6) channel(1)` |
| `0x22` LOG      | node to app | UTF-8 text |
| `0x23` SENT     | node to app | `msgId(4)` |

## 3. App payloads (air frame body)

### ANNOUNCE (`0x03`)
`pubkey(32) name(≤32, UTF-8)`. Sent on connect and every 30 s. Not signed: the name proves nothing. The key fingerprint `BLAKE2b(pubkey, 8 bytes)` is the identity.

### DATA (`0x02`)
`to_fp(8) from_fp(8) nonce(24) ciphertext`

`ciphertext` is NaCl `crypto_box` (X25519 + XSalsa20-Poly1305) of:
`kind(1) unix_time(4) text`. `kind 0x01` is text. Max 177 text bytes per frame. The app splits longer text across frames.

Receivers drop frames with a nonce they have already seen (replay protection).

## Known limits (v1)
- `to_fp` and `from_fp` are in clear text, so a listener can see who talks to whom (not what).
- ANNOUNCE is trust on first use. Verify fingerprints in person.
- No delivery receipts or store-and-forward yet.
- The ESP-NOW link itself is not encrypted. Content is protected end to end.
