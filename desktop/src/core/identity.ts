// User account: one 32-byte secret. Everything else derives from it.
//
//   box key   X25519 (NaCl box) - encryption; its fingerprint is the identity
//   sign key  Ed25519 = seed BLAKE2b("meshlink-sign-v1" | sk) - signatures
//   guest key Ed25519 per network - pseudonym toward Wi-Fi nodes, unlinkable
//             between networks and never the account fingerprint
//
// The 24-word recovery phrase is the BIP39 encoding of the same 32 bytes, so
// the phrase restores exactly this account.
import { blake2b } from "@noble/hashes/blake2.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import nacl from "tweetnacl";
import { concat, enc, toHex, u32le } from "./bytes";

export const FP_LEN = 8;

export function fingerprint(pubkey: Uint8Array): Uint8Array {
  return blake2b(pubkey, { dkLen: FP_LEN });
}

/** "C50D 124A 8AAF 41A1" */
export function formatFp(fp: Uint8Array): string {
  const h = Array.from(fp, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return h.match(/.{1,4}/g)!.join(" ");
}

export class Identity {
  readonly pubkey: Uint8Array; // X25519
  readonly fp: Uint8Array;
  readonly signPk: Uint8Array; // Ed25519
  private readonly signSk: Uint8Array;

  constructor(readonly secretKey: Uint8Array) {
    this.pubkey = nacl.box.keyPair.fromSecretKey(secretKey).publicKey;
    this.fp = fingerprint(this.pubkey);
    const seed = blake2b(concat(enc.encode("meshlink-sign-v1"), secretKey), { dkLen: 32 });
    const kp = nacl.sign.keyPair.fromSeed(seed);
    this.signPk = kp.publicKey;
    this.signSk = kp.secretKey;
  }

  static generate(): Identity {
    return new Identity(nacl.box.keyPair().secretKey);
  }

  static fromPhrase(phrase: string): Identity {
    const clean = normalizePhrase(phrase);
    if (!validateMnemonic(clean, wordlist)) throw new Error("This recovery phrase is not valid. Check each word.");
    return new Identity(mnemonicToEntropy(clean, wordlist));
  }

  /** 24 words that restore this account. */
  phrase(): string {
    return entropyToMnemonic(this.secretKey, wordlist);
  }

  sign(message: Uint8Array): Uint8Array {
    return nacl.sign.detached(message, this.signSk);
  }

  /** Per-network pseudonym key used to log in to Wi-Fi nodes. */
  guestKey(netId: number) {
    const seed = blake2b(concat(enc.encode("ml-guest-v1"), u32le(netId), this.secretKey), { dkLen: 32 });
    return nacl.sign.keyPair.fromSeed(seed);
  }

  /** Answer a Wi-Fi node's HELLO: sign "ml-auth" | nonce | chipId with the guest key. */
  guestAuth(netId: number, nonce: Uint8Array, chipId: number) {
    const kp = this.guestKey(netId);
    const sig = nacl.sign.detached(concat(enc.encode("ml-auth"), nonce, u32le(chipId)), kp.secretKey);
    return { pk: kp.publicKey, sig };
  }

  /** Encrypt for one recipient. */
  seal(theirPubkey: Uint8Array, plaintext: Uint8Array, nonce = nacl.randomBytes(24)) {
    return { nonce, ciphertext: nacl.box(plaintext, nonce, theirPubkey, this.secretKey) };
  }

  /** Shared key with a contact, for fast trial decryption. */
  sharedKey(theirPubkey: Uint8Array): Uint8Array {
    return nacl.box.before(theirPubkey, this.secretKey);
  }
}

export function verify(message: Uint8Array, sig: Uint8Array, signPk: Uint8Array): boolean {
  try {
    return nacl.sign.detached.verify(message, sig, signPk);
  } catch {
    return false;
  }
}

export function normalizePhrase(p: string): string {
  return p.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidPhrase(p: string): boolean {
  return validateMnemonic(normalizePhrase(p), wordlist);
}

/**
 * Safety number for two people to compare in person: 12 groups of 5 digits
 * from both fingerprints (order independent).
 */
export function safetyNumber(fpA: Uint8Array, fpB: Uint8Array): string {
  const [x, y] = toHex(fpA) < toHex(fpB) ? [fpA, fpB] : [fpB, fpA];
  const h = blake2b(concat(enc.encode("ml-safety"), x, y), { dkLen: 40 });
  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    const v = ((h[i * 3] << 16) | (h[i * 3 + 1] << 8) | h[i * 3 + 2]) % 100000;
    groups.push(String(v).padStart(5, "0"));
  }
  return groups.join(" ");
}
