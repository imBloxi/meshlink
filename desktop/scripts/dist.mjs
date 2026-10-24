// Package the app into a Windows installer. Output goes to
// %LOCALAPPDATA%\MeshLink-build\release, never into the (OneDrive-synced)
// project folder. Run: npm run dist
import { join } from "node:path";
import { build, Platform } from "electron-builder";

const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? ".", "AppData", "Local");
// CI sets MESHLINK_RELEASE_DIR to collect the installer for the GitHub release.
const output = process.env.MESHLINK_RELEASE_DIR ?? join(base, "MeshLink-build", "release");

const files = await build({
  targets: Platform.WINDOWS.createTarget("nsis"),
  publish: "never", // the release workflow uploads the files itself
  config: { directories: { output } },
});
console.log("Installer ready:");
for (const f of files) console.log("  " + f);
