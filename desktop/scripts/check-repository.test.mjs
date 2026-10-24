import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkRepository } from "./check-repository.mjs";

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), "meshlink-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const firmware = Buffer.from("test firmware");
  const files = {
    "desktop/package.json": JSON.stringify({ version: "0.4.1" }),
    "desktop/package-lock.json": JSON.stringify({ version: "0.4.1", packages: { "": { version: "0.4.1" } } }),
    "firmware/src/protocol.h": '#define ML_FW_VERSION "0.4.1"\n',
    "desktop/resources/firmware/meshlink-esp8266.bin": firmware,
    "desktop/resources/firmware/manifest.json": JSON.stringify({
      version: "0.4.1", file: "meshlink-esp8266.bin", chip: "ESP8266", offset: 0,
      size: firmware.length, sha256: createHash("sha256").update(firmware).digest("hex"),
    }),
    ...changes,
  };
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return root;
}

test("accepts matching versions and firmware", (t) => {
  assert.deepEqual(checkRepository(fixture(t)), []);
});

test("rejects stale source and lockfile versions", (t) => {
  const errors = checkRepository(fixture(t, {
    "firmware/src/protocol.h": '#define ML_FW_VERSION "0.3.0"\n',
    "desktop/package-lock.json": '{"version":"0.3.0","packages":{"":{"version":"0.3.0"}}}',
  }));
  assert.equal(errors.length, 2);
  assert.match(errors.join("\n"), /Firmware source version/);
  assert.match(errors.join("\n"), /Lockfile versions/);
});

test("rejects modified firmware", (t) => {
  assert.match(checkRepository(fixture(t, {
    "desktop/resources/firmware/meshlink-esp8266.bin": "tampered",
  })).join("\n"), /SHA-256/);
});

test("rejects stale and invalid manifests", (t) => {
  const errors = checkRepository(fixture(t, {
    "desktop/resources/firmware/manifest.json": '{"version":"0.3.0","file":"other.bin","chip":"ESP32","offset":4096}',
  }));
  assert.equal(errors.length, 3);
});

test("fails when release inputs are missing or malformed", (t) => {
  const root = fixture(t);
  rmSync(join(root, "desktop/resources/firmware/meshlink-esp8266.bin"));
  assert.throws(() => checkRepository(root), /ENOENT/);
  writeFileSync(join(root, "desktop/package.json"), "invalid JSON");
  assert.throws(() => checkRepository(root), SyntaxError);
});
