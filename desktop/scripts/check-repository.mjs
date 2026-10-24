// Check release inputs without installing dependencies or building firmware.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function checkRepository(root) {
  const read = (path) => readFileSync(resolve(root, path));
  const json = (path) => JSON.parse(read(path).toString("utf8"));
  const pkg = json("desktop/package.json");
  const lock = json("desktop/package-lock.json");
  const manifest = json("desktop/resources/firmware/manifest.json");
  const firmware = read("desktop/resources/firmware/meshlink-esp8266.bin");
  const header = read("firmware/src/protocol.h").toString("utf8");
  const version = header.match(/^#define ML_FW_VERSION "([^"]+)"\s*$/m)?.[1];
  const errors = [];
  if (!version || version !== pkg.version) errors.push("Firmware source version must match desktop/package.json.");
  if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
    errors.push("Lockfile versions must match desktop/package.json.");
  }
  if (manifest.version !== pkg.version) errors.push("Bundled firmware version is stale; run npm run fw:bundle.");
  if (manifest.file !== "meshlink-esp8266.bin" || manifest.chip !== "ESP8266" || manifest.offset !== 0) {
    errors.push("Bundled firmware must be an ESP8266 image at offset 0 with the expected filename.");
  }
  if (!firmware.length || manifest.size !== firmware.length ||
      manifest.sha256 !== createHash("sha256").update(firmware).digest("hex")) {
    errors.push("Bundled firmware size or SHA-256 does not match its manifest; rebuild the bundle.");
  }
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const errors = checkRepository(root);
    if (errors.length) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
    } else {
      console.log("Repository versions and bundled firmware integrity match.");
    }
  } catch (error) {
    console.error(`Repository check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
