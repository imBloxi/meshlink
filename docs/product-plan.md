# MeshLink: path to a ready product (gap analysis, system design, design system)

## Context
v0.1 is on GitHub (imBloxi/meshlink, private). It has ESP8266 relay firmware, a Python/tkinter app with end-to-end encrypted DMs, 15 passing tests and a working simulator. docs/v0.2-design.md plans the Electron rewrite with networks, rooms, a flasher and Wi-Fi. The user wants three things: confirm that nothing is missing for a real product, add useful features, and focus on design. This plan closes the gaps, adds a design system, and defines "product ready" as v1.0 release criteria.

## 1. Gap analysis of v0.1 (must fix before v1.0)
| # | Gap | Risk | Fix |
|---|-----|------|-----|
| G1 | ESP-NOW broadcast has no MAC-level ACK, so messages can be lost silently | Users think a message arrived when it did not | End-to-end ACK frame + retry with backoff (3 tries). UI shows sending / delivered / failed. |
| G2 | Every node relays at the same instant | Collisions and lost relays in 3+ node meshes | Random relay jitter of 5–40 ms in firmware. |
| G3 | Long messages are split with no group id, index or total | Out-of-order or missing chunks corrupt text | Chunk header `msgGroup(4) idx(1) total(1)` + reassembly with a 30 s timeout. |
| G4 | ANNOUNCE is unsigned and `classify_announce` does not detect impostors | Name spoofing | Signed announce (Ed25519) + impostor rule + key-change warning. |
| G5 | No network id | Any MeshLink user nearby mixes into your mesh | `netId` in air header (planned for M2). |
| G6 | No flood or rate limit | One device can spam the mesh and fill every queue | Per-origin rate limit in firmware (e.g. 10 frames/s) + max relay queue. |
| G7 | `to_fp`/`from_fp` are sent in clear text | A listener can map who talks to whom | v2: hide the recipient with trial decryption (drop `to_fp`, receivers try their keys). Sender fingerprint goes inside the ciphertext. |
| G8 | Private key and history stored as plain files | A stolen laptop exposes everything | safeStorage (DPAPI) for keys, SQLCipher for history, optional app lock. |
| G9 | No version check between app and firmware | Silent incompatibility after updates | INFO carries `fwVersion` + `protoVersion`. The app blocks with "Update node" and hands off to the flasher. |
| G10 | Nothing survives an app restart (history, rooms) | Unusable daily | SQLite persistence. |
| G11 | No CI, releases, installer, auto-update, license, SECURITY.md or user docs | Not shippable | See §5. |
| G12 | No forward secrecy (static keys) | Past messages exposed if a key leaks later | Documented limit. Mitigation: rotation of room keys and identity keys. A double ratchet is deferred because lossy radio makes it fragile. |

## 2. New features (ranked by value / effort)
1. **Delivery receipts + retry** (G1). Essential.
2. **Network map + link quality.** Each node counts beacons per neighbor and reports a neighbor table (`NEIGHBORS 0x25`). The app draws a node graph with signal bars.
3. **Range test / signal meter.** A walk-test mode: ping a chosen node every 1 s and show loss % and round-trip time live. Very useful for placing nodes.
4. **Node status.** Uptime, free heap, relay count, battery voltage (A0 ADC with a divider, optional).
5. **Store-and-forward.** Nodes keep the last 32 undelivered ciphertext frames in RAM and replay them when the recipient announces. Nodes never see plaintext.
6. **Disappearing messages** per chat (1 h / 1 d / 7 d) + **panic wipe** (hotkey to delete keys and history, with confirmation).
7. **Stealth mode.** No automatic ANNOUNCE. Contacts are added only by QR or invite.
8. **Small file / image sharing.** Up to 32 KB, chunked, with a progress bar and automatic compression. Marked experimental.
9. **SOS broadcast.** A pinned, high-priority room message with an optional text location.
10. **OTA firmware update over the mesh.** Deferred to after v1.0; USB flasher first.

## 3. System design

### Requirements
- Functional: DMs, public and private rooms, separate networks, node flashing and configuration, USB and Wi-Fi links, persistence.
- Non-functional: 3–20 nodes and ≤30 users per mesh; under 1 s delivery over 3 hops; works fully offline; no plaintext on nodes or on the air; app idle RAM under 250 MB; installer under 120 MB.
- Constraints: ESP8266 (80 KB RAM, 250-byte frames, no BLE), one developer, Node 24, no Rust.

### Components
```
┌──────────────── Electron app ───────────────────────────────┐
│ Renderer (React UI) ── IPC ── Main process                  │
│   ui/ (design system)          storage (SQLite/SQLCipher)   │
│   core/ (pure TS):             keystore (safeStorage)       │
│     framing, protocol v2,      updater (electron-updater)   │
│     crypto, chunker, acks,                                  │
│     rooms, messenger                                        │
│   links/: WebSerialLink | WebSocketLink | SimLink           │
│   flasher/ (esptool-js)                                     │
└───────────┬──────────────────────────────┬──────────────────┘
            │ USB serial (COBS+CRC)        │ WebSocket (same host frames)
      ┌─────▼─────┐   ESP-NOW flood   ┌────▼──────┐
      │  Node A   │ ~~~~~~~~~~~~~~~~~ │  Node B   │  (+ relay-only nodes)
      └───────────┘  netId-filtered   └───────────┘
```

### Protocol v2 deltas (on top of docs/v0.2-design.md)
- Air header: add `netId(4)` and `flags(1)` (priority bit, ack-requested bit). The header becomes 17 bytes.
- New air types: `ACK 0x05` (`ackOf msgGroup(4)`, encrypted to the sender), `NEIGHBORS 0x06` (not relayed), `PING/PONG 0x07/0x08` for range tests.
- Chunk header inside the ciphertext: `msgGroup(4) idx(1) total(1)`.
- Host frames: `CONFIG_GET/SET/CONFIG`, `STATUS (0x26)`, `NEIGHBORS (0x25)`.
- Firmware adds relay jitter, a per-origin rate limit, a store-and-forward ring and LittleFS config.

### Data model (SQLite)
- `identity(pubkey, name, created)`. The private key lives only in the keystore.
- `contacts(fp PK, pubkey, name, verified, first_seen, last_seen, key_changed)`.
- `networks(id PK, name, key_enc, channel, active)`.
- `rooms(id PK, net_id, kind[public|private], name, key_enc, muted, disappear_s)`.
- `messages(id PK, conv_type, conv_id, sender_fp, body, ts, state[sending|sent|delivered|failed|received], expires_at)`.
- `nodes(chip_id PK, name, net_id, fw_version, last_seen, rssi_score)`.

### Reliability
- Send path: queue → frame → wait for ACK for 2 s → retry at 2 s, then 4 s → mark failed, with a manual retry button in the UI.
- Duplicates: firmware dedupes by msgId; the app dedupes by msgGroup+idx and by nonce.
- Link loss: auto-reconnect every 3 s with a status banner.

### Trade-offs
- Electron gives fast UI work and a built-in flasher, at the cost of about 100 MB size and more RAM. Tauri can be revisited later.
- Flooding is simple and robust for under 20 nodes but wastes airtime at larger sizes. Revisit with neighbor-aware relay suppression (skip the relay if 2 neighbors already relayed) if meshes grow.
- Hidden recipients (trial decryption) cost CPU per frame. That is fine at ≤30 contacts and rooms.

### Revisit as it grows
Routing beyond flooding, forward secrecy, phone PWA, and a switch to ESP32 (BLE, more RAM, hardware crypto).

## 4. Design system ("Signal")
Location: `desktop/src/renderer/ui/`. Tokens live as CSS variables in `tokens.css`, mapped into `tailwind.config.ts`. Components are built on Radix primitives and documented in Storybook (`desktop/.storybook`).

### Tokens
- **Color** (dark-first, light theme also):
  - Neutrals: `ink-950 #0B0F14` … `ink-50 #F4F6F8`.
  - Accent `signal-500 #2EE6A6` (teal-green, "link up"), user-configurable. Six presets: teal, blue, violet, amber, rose, lime.
  - Semantic: `success`, `warning #F5B83D`, `danger #F2545B`, `info #4DA3FF`.
  - Trust colors: `trust-verified` (accent), `trust-unverified` (neutral), `trust-warning` (danger).
  - Room colors: `room-public` (info), `room-private` (accent).
- **Type**: Inter (UI) and JetBrains Mono (keys, fingerprints, logs). Scale 12/13/14/16/20/24/32. Weights 400/500/600. Line height 1.45 for body text.
- **Spacing**: 4 px base (`1`=4 … `12`=48). **Radius**: `sm 6`, `md 10`, `lg 14`, `full`. **Elevation**: 3 shadow levels + a 1 px `border-subtle`.
- **Motion**: `fast 120ms`, `base 200ms`, `slow 320ms`, easing `cubic-bezier(.2,.8,.2,1)`. Respect `prefers-reduced-motion`.
- **Density**: comfortable / compact (a settings toggle swaps the spacing tokens).

### Core components (each with variants, states, sizes and a11y)
Button (primary/secondary/ghost/danger; loading), IconButton, Input, TextArea (auto-grow composer), Select, Switch, Checkbox, Slider, Tabs, Dialog, Sheet, Popover, Tooltip, Toast, Badge, Avatar (identicon from the fingerprint), Skeleton, EmptyState, Banner.

### MeshLink-specific patterns
- **MessageBubble**: states sending / sent / delivered / failed (with retry), grouped by sender, timestamp on hover, disappearing timer ring.
- **FingerprintDisplay**: mono 4-character groups + identicon + copy button + QR. Used for verification.
- **TrustBadge**: verified ✔ / unverified / key-changed ⚠.
- **RoomBadge**: public (globe) / private (lock).
- **SignalBars**: 0–4 bars from link quality.
- **NodeCard** and **NetworkMap**: a force graph of nodes with links weighted by quality.
- **FlasherStepper**: detect → flash (progress) → configure → verify, with recoverable errors at each step.
- **InviteCard**: QR + copyable code + expiry.
- **ConnectionBanner**: connected / reconnecting / node outdated.

### App layout
Three columns: sidebar (networks switcher, DMs, rooms, nodes) · conversation · collapsible details panel (members, keys, room settings). Settings open as a full-screen modal with a left nav. Command palette on Ctrl+K.

### Accessibility
WCAG 2.1 AA contrast in both themes; full keyboard navigation; Radix focus management; screen reader labels on state icons (for example, "delivered"); never color alone to show trust or room state.

## 5. Product readiness (v1.0 release criteria)
- **CI** (GitHub Actions): TS unit tests, Python v1 vector tests, PlatformIO firmware build, and on tag: electron-builder NSIS installer + firmware.bin attached to the GitHub Release.
- **Auto-update**: electron-updater from GitHub Releases. The repo must be public, or updates need a token. Decision needed at release.
- **Code signing**: without it, Windows SmartScreen warns on install. Document this; buy a certificate later.
- **Docs**: README user guide, `docs/troubleshooting.md` (drivers CH340/CP210x, COM ports, long-path build issue), SECURITY.md (threat model + limits), LICENSE (recommend GPL-3.0 for firmware + app, or MIT).
- **Tests**: core protocol (shared test vectors with Python), chunking/ACK logic with a simulated lossy link (drop 20% of frames, confirm delivery by retry), UI component tests (Vitest + Testing Library), and one Playwright-Electron smoke test using SimLink.
- **Hardware guide**: wiring for battery + TP4056, enclosure, antenna notes.

## 6. Milestones (replaces the table in docs/v0.2-design.md)
| # | Scope |
|---|-------|
| M1 | Electron scaffold, design system tokens + core components + Storybook, TS core port with v1 vectors, WebSerial + Sim links, DM parity, SQLite persistence |
| M2 | Protocol/firmware v2: netId, signed announce, ACK/retry, chunk reassembly, relay jitter, rate limit, config frames, version check |
| M3 | Rooms (public/private), invites/QR, hidden recipients, disappearing messages |
| M4 | Flasher wizard, CI release pipeline, installer, auto-update |
| M5 | Network map, range test, node status, store-and-forward |
| M6 | Wi-Fi AP/STA + WebSocket link, stealth mode, panic wipe, app lock |
| M7 (beta) | File sharing, SOS, polish, docs → v1.0 |

## Files to add or modify
- `docs/v0.2-design.md`: merge in §1–§6. Add `docs/design-system.md` (token and component reference) and `docs/threat-model.md`.
- `firmware/src/main.cpp`, `firmware/src/protocol.h`: v2 header, jitter, rate limit, config/status/neighbors, LittleFS.
- New `desktop/`: `package.json`, `electron/main.ts`, `src/core/*.ts`, `src/renderer/ui/*`, `src/renderer/app/*`, `.storybook/`.
- `app/tests/`: export v1 test vectors as JSON for the TS port.
- `.github/workflows/ci.yml`, `release.yml`. Also `LICENSE` and `SECURITY.md`.

## Verification
- `npm test` in `desktop/` (core + UI) and `python -m pytest` in `app/`: all pass.
- Lossy simulator test: 20% frame drop, 100 messages, 100% delivered or marked failed, no corrupted text.
- Firmware: `pio run` builds; on the 2 boards, a range walk test shows loss % and delivered receipts.
- Storybook shows every component in both themes. An axe accessibility check passes.
- Release dry run: tag → CI produces the installer + firmware.bin. A fresh Windows VM installs it, flashes a board and chats.
