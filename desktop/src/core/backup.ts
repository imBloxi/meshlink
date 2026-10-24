// Encrypted account backup (.meshlink file).
// Key = Argon2id(passphrase, salt); content = NaCl secretbox of JSON.
// Without the passphrase the file reveals nothing but its size.
import { argon2idAsync } from "@noble/hashes/argon2.js";
import nacl from "tweetnacl";
import { dec, enc, fromB64, toB64 } from "./bytes";

export interface BackupContent {
  version: 1;
  createdAt: number;
  identity: string; // base64 secret key
  name: string;
  contacts: unknown[];
  rooms: unknown[];
  networks: unknown[];
  settings: Record<string, unknown>;
  messages?: unknown[];
}

interface BackupFile {
  format: "meshlink-backup";
  v: 1;
  kdf: "argon2id";
  m: number; // KiB
  t: number;
  p: number;
  salt: string;
  nonce: string;
  ct: string;
}

// 64 MiB, 3 passes: about a second on a laptop.
const PARAMS = { m: 65536, t: 3, p: 1 };

async function deriveKey(pass: string, salt: Uint8Array, m: number, t: number, p: number) {
  return argon2idAsync(enc.encode(pass.normalize("NFKC")), salt, { m, t, p, dkLen: 32 });
}

export async function createBackup(content: BackupContent, passphrase: string, params = PARAMS): Promise<string> {
  if (passphrase.length < 8) throw new Error("Use a passphrase of at least 8 characters.");
  const salt = nacl.randomBytes(16);
  const nonce = nacl.randomBytes(24);
  const key = await deriveKey(passphrase, salt, params.m, params.t, params.p);
  const file: BackupFile = {
    format: "meshlink-backup", v: 1, kdf: "argon2id", ...params,
    salt: toB64(salt), nonce: toB64(nonce),
    ct: toB64(nacl.secretbox(enc.encode(JSON.stringify(content)), nonce, key)),
  };
  return JSON.stringify(file);
}

export async function openBackup(text: string, passphrase: string): Promise<BackupContent> {
  let f: BackupFile;
  try {
    f = JSON.parse(text);
  } catch {
    throw new Error("This is not a MeshLink backup file.");
  }
  if (f.format !== "meshlink-backup" || f.v !== 1 || f.kdf !== "argon2id") throw new Error("This is not a MeshLink backup file.");
  // A crafted file must not make us burn minutes of CPU or gigabytes of RAM.
  const intIn = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!intIn(f.m, 8, 1 << 20) || !intIn(f.t, 1, 20) || !intIn(f.p, 1, 4)) throw new Error("Backup file uses unsafe settings.");
  const key = await deriveKey(passphrase, fromB64(f.salt), f.m, f.t, f.p);
  const plain = nacl.secretbox.open(fromB64(f.ct), fromB64(f.nonce), key);
  if (!plain) throw new Error("Wrong passphrase, or the file is damaged.");
  return JSON.parse(dec.decode(plain));
}
