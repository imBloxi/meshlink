# Contributing to MeshLink

Thanks for helping. MeshLink is small, so a good issue or a focused pull request goes a long way.

## Security bugs

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Layout

```
firmware/   ESP8266 node (PlatformIO, Arduino core)
desktop/    Electron app (TypeScript, React). core/ is pure TS, tested with vitest
mobile/     NodeLink Android shell; UI in desktop/src/mobile, shared desktop crypto core
app/        Python app v0.1 (legacy protocol v1; not compatible with current firmware)
docs/       design notes, challenge
PROTOCOL.md current wire format: the contract between desktop and firmware
```

## Setup

Use Node.js 24.x and the bundled npm. No account, API key, or `.env` file is required. Start with the checked-in firmware bundle; install PlatformIO only if you need to rebuild firmware.

```bash
cd desktop
npm ci
npm run check       # repository integrity, script tests, typecheck, tests, build
npm run web         # UI in a browser with the simulator, no hardware needed
npm run dev         # Electron app
npm run fw:bundle   # build firmware into the app (needs PlatformIO: pipx install platformio)
```

Python app: `cd app && pip install -r requirements.txt pytest && python -m pytest`.

Read [docs/development.md](docs/development.md) for the simulator walkthrough, component boundaries, and troubleshooting. Browser preview keys and messages are stored as plaintext: use test identities only.

Android setup and device checks are in [mobile/README.md](mobile/README.md). The mobile UI shares the existing core; do not fork crypto or wire-format implementations. Run `npm run mobile:build` before Gradle tests, lint and packaging.

For a first contribution, start with a reproducible bug, documentation correction, a focused test, or an accessibility improvement. Discuss protocol changes and larger features in an issue before building them.

## Pull requests

- One topic per PR. Explain the reason for the change, not only the change.
- `npm run check` must pass from `desktop/`. CI runs it on Linux and Windows and also tests the legacy Python app and builds both supported firmware targets. A build does not verify hardware or the rendered UI; describe any manual checks in the PR.
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
2. Run `npm install --package-lock-only` in `desktop/` to update the lockfile version, then `npm run fw:bundle` and `npm run check`. Move the CHANGELOG entries under the new version. Check `git diff` and include the updated firmware binary and manifest in the release commit.
3. Tag `vX.Y.Z` and push the tag. The release workflow builds the firmware and the installer, and attaches both to a draft GitHub release with `SHA256SUMS.txt`.
4. Check the draft, then publish it. Apps with update checks on see it from then on.
