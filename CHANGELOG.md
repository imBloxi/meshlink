# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org/). Before 1.0, a minor version can change the protocol.

The desktop app and the node firmware share one version number. The app shows all versions in **Settings → About**.

## [Unreleased]

### Added
- Installer with a choice of folder and of "just me" or "all users", the license, branded pages, and an option to start MeshLink when done.
- The uninstaller asks whether to also delete your account, contacts and messages. It keeps them by default and never asks during an update.
- MeshLink app icon for the app, installer, Start menu and taskbar.
- Launch screen while the app loads its keys and history. It follows the system light or dark theme.

### Fixed
- The tray icon was blank on Windows (it was an SVG, which Windows cannot load there).
- Windows grouped the taskbar button and named notifications by Electron's default app id instead of MeshLink's.

## [0.4.0] - 2026-10-23

First open-source release, under GPL-3.0. Private by default.

> **Update every app on your network together.** 0.4 apps read messages from 0.3 apps, but 0.3 apps cannot read the padded messages that 0.4 sends. Reflash your nodes from **Connect → Flash a new board** to get the new hotspot-only defaults.

### Privacy by default
- Every DM and room frame on the air is exactly 225 bytes. A listener can no longer tell message length, or tell a text from a delivery receipt. Padding is inside the encryption.
- The local database no longer shows who you talk to. Contacts, settings, rooms, networks and message senders are encrypted. Conversations, message ids and record ids are stored as keyed hashes. Existing databases are converted on first start. Deleted rows are overwritten on disk (`secure_delete`).
- Windows notifications say only "New message". Turn on **Settings → Privacy & security → Show message text in Windows notifications** to see the sender and text.
- The app no longer leaves your Wi-Fi to join a node's hotspot unless you allow it.
- The app removes a node's Wi-Fi profile, with its password, from Windows when it leaves the node.
- Your name and key are broadcast every 60 seconds instead of every 30.
- Nodes stay silent on your home router network: guests, UDP discovery, the web page and mDNS answer only on the node's own hotspot. Turn on **Node admin → Wi-Fi → Guests from home Wi-Fi** to change this.
- No network calls by default. The update check runs only when you press **Check now**, or at start if you turn that on.

### Security
From an internal audit before the release. Details in [SECURITY.md](SECURITY.md).
- Rooms: another member could take over the creator's identity, and with it moderation, for members who joined later. Invites now carry the creator's signing key, and a room JOIN can no longer claim someone else's fingerprint.
- Rooms: a kicked member could keep posting with the old key. The old key now works for 10 minutes after a rotation, and never for removed members.
- Rooms: old signed moderation frames (promote, kick, delete) could be replayed after an app restart. They are now refused if they are stale or not newer than the last one applied.
- Firmware: a stack buffer overflow when sending the ban list or a large config over USB.
- Firmware: anyone on the home router network could join a node as a guest and send frames with the network key.
- Firmware: connections that never authenticate are closed after 5 seconds, so they cannot fill the guest slots. Duplicate detection remembers 512 frames instead of 128.
- App: a Wi-Fi node (for example a cloned hotspot) could claim the admin role and receive your network key. Only USB nodes are admin now.
- App: a network code could replace the key and owner of a network you already have.
- App: a flood of announces with new keys could grow the contact list without limit. New contacts are now limited to 20 per minute and 1000 in total.
- App: a new key that uses the name of a contact you verified is ignored with a warning.
- App: replayed messages trigger at most 3 extra delivery receipts.
- Firmware: fixed an HTTP path traversal that could expose the node config (network key, Wi-Fi passwords).
- Firmware: the network tag is checked before duplicate detection and the rate limit, so outsiders cannot suppress chosen frames or use up another node's rate budget.
- App: a replayed copy of your own DM is no longer shown as a message from the contact.
- App: a known contact can no longer be renamed by an announce signed with another key. Old announces cannot roll back names.
- App: IPC calls are accepted only from the app's own page. Driver install accepts only known bridge names.
- App: Electron fuses are hardened (no RunAsNode, no NODE_OPTIONS, no inspector, ASAR integrity). Production builds use a strict Content-Security-Policy.
- App: backup KDF parameters are bounded.

### Added
- Settings → About shows the app, bundled firmware, node firmware, protocol and Electron versions.
- Update check against GitHub Releases. It never downloads or installs anything by itself.
- Node setting `lanGuests` (config field 24).
- [Break MeshLink](docs/break-meshlink.md) challenge.
- LICENSE (GPL-3.0), SECURITY.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, CI and release workflows.

### Changed
- Protocol: padded DM and room chunks (kind bit `0x80`), room invite v2 with the creator's signing key. See [PROTOCOL.md](PROTOCOL.md).
- PROTOCOL.md now documents protocol v2 in full.

## [0.3.0]
- Protocol v2: network ids and keyed air tags, signed announces, hidden DM recipients, rooms, delivery receipts and retries, chunking.
- Electron desktop app with encrypted history, built-in firmware flasher, Wi-Fi nodes and guest access.

## [0.1.0]
- First version: ESP8266 relay firmware, Python/tkinter app, end-to-end encrypted DMs.

[Unreleased]: https://github.com/imBloxi/meshlink/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/imBloxi/meshlink/releases/tag/v0.4.0
[0.3.0]: https://github.com/imBloxi/meshlink/releases/tag/v0.3.0
[0.1.0]: https://github.com/imBloxi/meshlink/releases/tag/v0.1.0
