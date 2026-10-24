# Contributing to MeshLink

Thanks for helping. MeshLink is small, so a good issue or a focused pull request goes a long way.

## Security bugs

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Layout

```
firmware/   ESP8266 node (PlatformIO, Arduino core)
desktop/    Electron app (TypeScript, React). core/ is pure TS, tested with vitest
app/        Python app v0.1 (legacy, kept wire-compatible for framing)
docs/       design notes, challenge
PROTOCOL.md wire format: the contract between all three
```

## Setup

```
cd desktop
npm ci
npm test            # protocol, crypto and messenger tests
npm run typecheck
npm run web         # UI in a browser with the simulator, no hardware needed
npm run dev         # Electron app
npm run fw:bundle   # build firmware into the app (needs PlatformIO: pipx install platformio)
```

Python app: `cd app && pip install -r requirements.txt pytest && python -m pytest`.

## Pull requests

- One topic per PR. Explain the reason for the change, not only the change.
- `npm test` and `npm run typecheck` must pass. CI also builds the firmware.
- **Protocol changes** need an update to `PROTOCOL.md` and to the constants in both `firmware/src/protocol.h` and `desktop/src/core/protocol.ts`. Bump the protocol version if old nodes or apps would misread the new frames.
- **Crypto changes:** use existing primitives (tweetnacl, @noble/hashes, rweather Crypto). No hand-rolled crypto. Add a test that shows the attack fails.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under the unreleased version.
- By sending a PR, you agree to license your contribution under GPL-3.0.

## Style

- TypeScript: strict mode, small pure functions in `core/`, no timers or clocks inside `core/` (pass `now`).
- Firmware: no heap allocation in the hot path, fixed buffers, check every length before `memcpy`.
- Comments explain *why*. Keep them short.

## Releases (maintainers)

1. Set the version in `desktop/package.json` and `ML_FW_VERSION` in `firmware/src/protocol.h`. The versions must be the same.
2. Move the CHANGELOG entries under the new version.
3. Tag `vX.Y.Z` and push the tag. The release workflow builds the firmware and the installer, and attaches both to a draft GitHub release with `SHA256SUMS.txt`.
4. Check the draft, then publish it. Apps with update checks on see it from then on.
