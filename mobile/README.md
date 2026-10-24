# NodeLink for Android

NodeLink is the Android client for the MeshLink mesh. This first version supports encrypted direct messages using the **same TypeScript crypto and protocol core** as the desktop app. There is no new server, account service, or firmware requirement.

## First connection

1. Install the debug APK you build below on an Android 8.0+ phone with an up-to-date Android System WebView.
2. Create a local identity or restore your existing 24-word MeshLink recovery phrase. Save your phrase privately in **You → Show recovery phrase**.
3. In **Node → Open Wi-Fi settings**, join the node's hotspot. Ask the owner for its password. If Android asks about no internet, choose to stay connected.
4. Return to NodeLink and connect to `192.168.4.1`, or the node's configured private IPv4 address.
5. Keep the other app connected to the same mesh. Announced contacts appear in **Chats**. Compare safety numbers through a trusted channel before marking a contact verified.

The app does not scan Wi-Fi networks or automatically switch your network. The native socket explicitly uses the connected Wi-Fi network, so cellular data does not redirect node traffic. The initial guest connection signs the node's challenge with a per-network pseudonym. It accepts only matching protocol-v2 INFO and guest access; it never sends USB administration commands or a network key.

## Build

Requirements: Node.js 24, npm, JDK 17, Android SDK platform 35 and build tools 35.0.0. Gradle 8.10.2 is supplied through the wrapper. Android Studio can install the SDK and create an untracked `android/local.properties`, or set `ANDROID_HOME` yourself.

```sh
# From the repository root:
cd desktop
npm ci
npm run typecheck
npm test
cd ../mobile/android
./gradlew testDebugUnitTest lintDebug assembleDebug
```

On Windows use `gradlew.bat`. The debug APK is `mobile/android/app/build/outputs/apk/debug/app-debug.apk`. It uses Android's development signing key and is not a production release. Gradle rebuilds the bundled web app when its mobile sources, shared core, Vite configuration or npm lockfile change, so Android Studio and command-line builds package current assets. Run `npm ci` first; Node.js and npm must be on PATH. Dependencies are fetched from Google Maven/Maven Central on the first build.

To install on your own USB-debugging-enabled test phone:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n dev.imbloxi.nodelink/.MainActivity
```

`npm run mobile:dev` from `desktop/` opens a local browser preview on port 5200. This preview shows onboarding and deliberately refuses account creation and real connections without the Android secure host. The development server removes the packaged CSP to allow Vite's refresh runtime. No desktop Electron files or settings are modified by the mobile app.

## Data and security boundaries

- UI: bundled React assets loaded with AndroidX WebViewAssetLoader at its reserved HTTPS app origin. No remote navigation, frames, cookies, file access, content access, mixed content, or browser local storage. A native CSP disables all web network connections; only the native socket reaches nodes.
- Storage: identity, contacts, settings and up to 1,000 recent messages form one AES-256-GCM encrypted snapshot. Oldest history is pruned to keep the entire encoded snapshot within 3 MiB, beneath the native 4 MiB ceiling. Long valid desktop messages remain readable after a restart. The non-exportable wrapping key lives in Android Keystore. Writes use AtomicFile; decryption or validation failure preserves the file and blocks account creation rather than replacing the identity. Hardware backing depends on the phone.
- Recovery: a storage failure pauses the connection and offers a retry. A failed write is retried from the current in-memory account to preserve unsaved messages. Resetting requires typing `RESET` and permanently removes local contacts/history; the saved 24-word phrase can then restore the identity. If the identity is still in memory, the recovery screen lets you reveal its phrase before resetting.
- OS: account data lives in Android's no-backup directory. Cloud backup, device transfer, screenshots and recents captures are disabled. An unlocked app can still display decrypted data. Recovery words export the identity by design; protect them.
- Transport: explicit private IPv4 addresses only, fixed port 81, no DNS hostnames, proxies or redirects. Cleartext network traffic is allowed in the Android manifest because the ESP8266 exposes `ws://`. Message content is still encrypted by the shared core. This does not add TLS or authenticate a node to you, and a hostile hotspot can observe traffic, reject guests or deny delivery.
- Privacy: announcements expose your display name and public identity to people on the mesh. Verify contacts independently. No analytics, cloud calls or update requests are added.

The Android shell follows the [local-content guidance](https://developer.android.com/develop/ui/views/layout/webapps/load-local-content) and [Keystore AES-GCM API](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec). See [SECURITY.md](../SECURITY.md) for the shared protocol threat model.

## Current limits and verification

This is an initial Android client. It supports foreground direct messages, contact discovery, delivery receipts, recovery phrases and contact verification. It does not yet support rooms, network invites, USB flashing, node administration, notifications, or background delivery. When the app backgrounds or the node connection drops, outstanding sends become failed. Reconnect manually after returning. There is no offline outbox or node mailbox; both peers need to be reachable. Contacts/history do not synchronize with your desktop installation.

Guest permissions refresh every five seconds, so an admin can grant or revoke sending without requiring a reconnect. Read-only guests receive messages but cannot send delivery acknowledgements; their peers may therefore see those messages as unconfirmed.

The TypeScript tests check authentication sequencing, live guest permissions, timeouts, endpoint restrictions, storage recovery, stored identity/contact validation, long-message restoration and history byte limits. JVM tests check native address restrictions. Instrumented tests in `android/app/src/androidTest` exercise actual Keystore storage and the packaged React WebView's onboarding, tab navigation, identity persistence across an Activity restart, explicit storage reset and phrase restoration. A local WebSocket node fixture also exercises the packaged UI through the real native Wi-Fi socket, guest handshake, permission changes, encrypted message transmission and disconnect handling. CI runs these on an Android 35 emulator. Run `gradlew connectedDebugAndroidTest` with a Wi-Fi-connected emulator or disposable test device locally. UI tests skip existing accounts and clean up only their own test identities; Keystore tests use unique isolated files and key aliases. These checks do not prove physical ESP8266 radio interoperability, hotspot routing with cellular enabled, or keyboard/layout behavior on every phone.

The local socket fixture must host the firmware's fixed port 81. On a disposable, root-capable emulator, run `adb root`, `adb wait-for-device`, and `adb shell 'echo 0 > /proc/sys/net/ipv4/ip_unprivileged_port_start'` before the instrumented suite. CI does this automatically. This permission is for hosting the test fixture; normal app connections to a real node require no root. On a physical phone, run the other instrumented tests with `-Pandroid.testInstrumentationRunnerArguments.class=dev.imbloxi.nodelink.AppFlowTest,dev.imbloxi.nodelink.SecureVaultTest` and verify real-node connectivity separately.

Manual device acceptance: create an identity, force-stop/reopen and check it persists; connect with cellular enabled to an offline node hotspot; exchange messages with desktop; compare safety numbers; test a read-only guest; background/reconnect; verify a failed send does not stay pending; restore a test recovery phrase; confirm private history never appears as plaintext in app files. Do not use real identities when testing account deletion or recovery failure.
