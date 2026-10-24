// Build the ESP8266 firmware and copy it into resources/firmware/, where the
// app's flasher finds it. Run: npm run fw:bundle
//
// Output:
//   resources/firmware/meshlink-esp8266.bin   full flash image, written at 0x0
//   resources/firmware/manifest.json          version, sha256, size, offset
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fwDir = resolve(here, "../../firmware");
const outDir = resolve(here, "../resources/firmware");
const env = "d1_mini"; // 4 MB flash; same image runs on NodeMCU v2/v3.
// Short workspace path outside OneDrive: PlatformIO breaks on long Windows
// paths, and build output must not sync.
const workDir = join(tmpdir(), "mlw");
const buildDir = join(workDir, "build");

const version = readFileSync(join(fwDir, "src/protocol.h"), "utf8").match(/ML_FW_VERSION "([^"]+)"/)[1];

console.log(`Building firmware ${version} (${env})...`);
// `pio` (pipx, installer, CI) first, then `python -m platformio` (pip install).
const pioEnv = { ...process.env, PLATFORMIO_WORKSPACE_DIR: workDir };
const hasPio = (() => {
  try {
    execFileSync("pio", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
})();
const [cmd, args] = hasPio ? ["pio", ["run", "-e", env]] : ["python", ["-m", "platformio", "run", "-e", env]];
execFileSync(cmd, args, { cwd: fwDir, stdio: "inherit", env: pioEnv, shell: hasPio && process.platform === "win32" });

const bin = join(buildDir, env, "firmware.bin");
const data = readFileSync(bin);
mkdirSync(outDir, { recursive: true });
copyFileSync(bin, join(outDir, "meshlink-esp8266.bin"));
const manifest = {
  name: "MeshLink node",
  version,
  chip: "ESP8266",
  file: "meshlink-esp8266.bin",
  offset: 0,
  size: data.length,
  sha256: createHash("sha256").update(data).digest("hex"),
  builtAt: new Date().toISOString(),
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Bundled ${manifest.file} v${version}, ${data.length} bytes -> ${outDir}`);
