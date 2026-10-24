# Third-party notices

MeshLink is licensed under GPL-3.0 (see [LICENSE](LICENSE)). It includes or depends on the following third-party work, under their own licenses. All of these licenses are compatible with GPL-3.0.

## Vendored in this repository

| Component | Path | License |
|-----------|------|---------|
| Arduino Crypto library by Rhys Weatherley (subset: BLAKE2s, Ed25519, Curve25519, SHA512 and helpers) | `firmware/lib/mlcrypto/` | MIT. Copyright (C) 2015 Southern Storm Software, Pty Ltd. The full notice is in each file header. |

## Firmware dependencies (fetched by PlatformIO)

| Component | License |
|-----------|---------|
| ESP8266 Arduino core | LGPL-2.1 |
| arduinoWebSockets (links2004) | LGPL-2.1 |

## Desktop app dependencies (npm)

The main runtime dependencies: tweetnacl (Unlicense), @noble/hashes and @scure/bip39 (MIT), esptool-js (Apache-2.0), React (MIT), Radix UI (MIT), zustand (MIT), lucide-react (ISC), qrcode (MIT), Inter and JetBrains Mono fonts (OFL-1.1), Electron (MIT).

For the full, exact list with license texts, run:

```
cd desktop
npx license-checker --production --summary
```

## Python app dependencies

pyserial (BSD-3-Clause), PyNaCl (Apache-2.0).
