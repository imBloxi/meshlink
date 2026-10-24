# Developing MeshLink

## Start without hardware

Install Node.js 24.x with npm, clone the repository, and run:

```sh
cd desktop
npm ci
npm run check
npm run web
```

Open `http://localhost:5199/?profile=alice` and `http://localhost:5199/?profile=bob` in two tabs of the same browser profile. Use the address printed by Vite if port 5199 is occupied; both tabs must use the same origin. The query parameter gives each tab separate local storage. Create a disposable identity in each tab and choose **Connect → Simulator** in both. The simulator uses a shared BroadcastChannel, so use the same browser profile, not separate private sessions. Contacts should appear after announcements; send a test message in each direction.

The browser fallback stores keys and history as **plaintext** in local storage. Do not import your real identity or use sensitive messages. Clear the site's browser storage when finished. USB, Wi-Fi control, encrypted storage, native notifications, and the installer need the Windows Electron app and are not covered by this preview.

To run the desktop app on Windows, stop the preview and use `npm run dev`. The firmware image is checked in, so you can open the flasher without installing PlatformIO. Flashing and radio behavior still require physical boards.

## Where changes belong

| Path | Responsibility |
| --- | --- |
| `desktop/src/core/` | Protocol, identities, encryption, rooms, messenger; Vitest tests and protocol fixtures |
| `desktop/src/main/` | Windows host integration, storage, USB, Wi-Fi, updates |
| `desktop/src/preload/` and `desktop/src/shared/api.ts` | IPC bridge and its typed contract |
| `desktop/src/renderer/` | React UI, state, transport adapters, browser fallback |
| `firmware/src/` | ESP8266 relay, configuration, protocol constants |
| `firmware/lib/mlcrypto/` | Vendored crypto subset; preserve upstream license headers |
| `app/` | Legacy Python protocol-v1 implementation; incompatible with current nodes |

Read [PROTOCOL.md](../PROTOCOL.md) before changing frames and [SECURITY.md](../SECURITY.md) before changing trust or key handling. Keep the public development experience free of required credentials and hosted services.

## Checks

From `desktop/`, `npm run check` runs the following in order:

1. `npm run repo:check`: app, lockfile, firmware source and bundled version agreement; bundle filename, chip, flash offset, size and SHA-256. This checks consistency, not firmware provenance or reproducible compilation.
2. `npm run test:scripts`: regression tests for the repository checker using temporary fixtures.
3. `npm run typecheck`: TypeScript checks.
4. `npm test`: protocol, crypto and messenger tests.
5. `npm run build`: Electron main process, preload and renderer compilation.

CI runs these on Windows and Linux. It separately runs the Python tests and builds `d1_mini` and `nodemcuv2`. Test UI changes in the relevant app and describe the result in your PR. Passing CI does not prove radio interoperability, Windows integration, or security under the full threat model.

## Firmware and installers

Install PlatformIO with your preferred Python environment (`pipx install platformio` is one option). From `desktop/`, run `npm run fw:bundle` to build the D1 mini image and update `resources/firmware/manifest.json`. Include both the image and manifest when firmware changes. Run `npm run check` afterward.

For a direct firmware build, run `pio run -e d1_mini -e nodemcuv2` from `firmware/`. On Windows, set `PLATFORMIO_WORKSPACE_DIR` to a short path outside OneDrive if PlatformIO reports missing files under long paths. The bundle script uses a temporary workspace automatically.

On Windows, `npm run dist` builds the NSIS installer. By default it writes to `%LOCALAPPDATA%\MeshLink-build\release`; the command prints the resulting paths. To choose another output folder in PowerShell:

```powershell
$env:MESHLINK_RELEASE_DIR = 'C:\meshlink-release'
npm run dist
```

Packaging needs Electron/NSIS build downloads on the first run. Follow [CONTRIBUTING.md](../CONTRIBUTING.md#releases-maintainers) for versioning and draft releases.

## Troubleshooting

- **Node engine warning:** check `node --version`; use 24.x, matching `.nvmrc` and CI.
- **Missing modules:** run `npm ci` from `desktop/`, not the repository root.
- **Repository check reports stale firmware:** rebuild with `npm run fw:bundle`; do not edit the checksum to hide an unexpected binary change.
- **Simulator tabs do not discover each other:** confirm the same origin and browser profile, different `profile` query values, and Simulator selected in both tabs.
- **Windows host behavior fails in the preview:** reproduce with `npm run dev`; the browser fallback has no Windows host integration.

Keep private keys, identity exports, network keys, and real conversations out of commits and public bug reports. Ignore rules help with local credentials but do not inspect Git history. Report vulnerabilities privately using [SECURITY.md](../SECURITY.md).
