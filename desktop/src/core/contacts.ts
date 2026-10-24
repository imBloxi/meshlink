// Contacts are keyed by key fingerprint (hex), never by name.
import { toHex } from "./bytes";
import { fingerprint } from "./identity";

export interface Contact {
  fp: string; // hex fingerprint
  pubkey: Uint8Array; // X25519
  signPk: Uint8Array | null; // Ed25519, from a signed announce
  name: string;
  verified: boolean;
  firstSeen: number; // ms
  lastSeen: number; // ms
}

export type AnnounceVerdict = "known" | "new" | "impostor";

export function makeContact(pubkey: Uint8Array, name: string, now = Date.now(), signPk: Uint8Array | null = null): Contact {
  return { fp: toHex(fingerprint(pubkey)), pubkey, signPk, name, verified: false, firstSeen: now, lastSeen: now };
}

/**
 * Decide how to treat an ANNOUNCE (public key + display name) from the air.
 *
 * Anyone in radio range can send an ANNOUNCE with any name, so the name
 * proves nothing. Only the key is identity.
 *   known    - fingerprint already in contacts
 *   new      - unknown fingerprint, safe to add as an unverified contact
 *   impostor - unknown fingerprint that should not be added silently
 */
export function classifyAnnounce(
  contacts: ReadonlyMap<string, Contact>,
  pubkey: Uint8Array,
  name: string,
): AnnounceVerdict {
  const fp = toHex(fingerprint(pubkey));
  if (contacts.has(fp)) return "known";
  // A new key that uses the name of a contact you verified in person is
  // almost certainly someone posing as them. Only verified contacts are
  // protected: otherwise an attacker could squat names before the real
  // people show up. Case, spacing and look-alike forms are ignored.
  const key = nameKey(name);
  if (key) {
    for (const c of contacts.values()) if (c.verified && nameKey(c.name) === key) return "impostor";
  }
  return "new";
}

/** Name for comparison: NFKC, lower case, no spaces. Empty names never clash. */
export function nameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}
