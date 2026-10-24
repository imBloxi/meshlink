import assert from "node:assert/strict";
import { test } from "node:test";
import { unresolvedRequires } from "./check-main-requires.mjs";

test("allows electron and node built-ins", () => {
  assert.deepEqual(unresolvedRequires('require("electron");require("node:fs");require("crypto");require("fs/promises")'), []);
});

test("flags packages missing from the installer", () => {
  assert.deepEqual(
    unresolvedRequires('require("@noble/hashes/blake2.js"); require("electron"); require( "@scure/bip39" )'),
    ["@noble/hashes/blake2.js", "@scure/bip39"],
  );
});
