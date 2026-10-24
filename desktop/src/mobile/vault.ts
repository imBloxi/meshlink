import { fromB64, toB64, toHex, enc } from "../core/bytes";
import type { Contact } from "../core/contacts";
import { fingerprint, Identity } from "../core/identity";
import type { ChatMessage } from "../core/messenger";

export interface SavedContact extends Omit<Contact, "pubkey" | "signPk"> { pubkey: string; signPk: string | null }
export interface Snapshot {
  version: 1;
  secret: string;
  name: string;
  host: string;
  contacts: SavedContact[];
  messages: ChatMessage[];
}
// Leave headroom beneath the native vault's 4 MiB limit. Count alone is not
// enough: desktop peers can send much longer messages than the mobile composer.
export function serializeSnapshot(snapshot: Snapshot): { json: string; messages: ChatMessage[] } {
  const limit = 3 * 1024 * 1024;
  let size = enc.encode(JSON.stringify({ ...snapshot, messages: [] })).length;
  if (size > limit) throw new Error("Account metadata exceeds the secure storage limit.");
  const messages: ChatMessage[] = [];
  for (const message of snapshot.messages.slice(-1000).reverse()) {
    const bytes = enc.encode(JSON.stringify(message)).length + (messages.length ? 1 : 0);
    if (size + bytes > limit) break;
    size += bytes;
    messages.push(message);
  }
  messages.reverse();
  return { json: JSON.stringify({ ...snapshot, messages }), messages };
}
export function displayName(value: string) {
  const name = value.trim();
  if (!name || enc.encode(name).length > 32) throw new Error("Choose a name between 1 and 32 UTF-8 bytes.");
  return name;
}
function key(value: unknown, size: number): Uint8Array {
  if (typeof value !== "string") throw new Error("Invalid key in encrypted storage.");
  const bytes = fromB64(value);
  if (bytes.length !== size || toB64(bytes) !== value) throw new Error("Invalid key in encrypted storage.");
  return bytes;
}
export function restoreSnapshot(json: string): { snapshot: Snapshot; identity: Identity; contacts: Map<string, Contact> } {
  if (enc.encode(json).length > 4 * 1024 * 1024) throw new Error("Encrypted account exceeds the storage limit.");
  const value = JSON.parse(json) as Snapshot;
  if (!value || value.version !== 1 || typeof value.name !== "string" || typeof value.host !== "string" ||
      !Array.isArray(value.contacts) || value.contacts.length > 1000 || !Array.isArray(value.messages) || value.messages.length > 1000) {
    throw new Error("The encrypted account file has an unsupported or invalid format.");
  }
  displayName(value.name);
  const identity = new Identity(key(value.secret, 32));
  const contacts = new Map<string, Contact>();
  // Protocol v3 puts the signing key into the fingerprint. Contacts saved by
  // older versions get their new fingerprint and lose their verified mark (the
  // safety number changed). Without a signing key there is nothing to derive
  // it from: drop them, they return with their next announce.
  const renamed = new Map<string, string>();
  for (const contact of value.contacts) {
    const pubkey = key(contact.pubkey, 32);
    if (typeof contact.name !== "string" || typeof contact.verified !== "boolean" ||
        !Number.isFinite(contact.firstSeen) || !Number.isFinite(contact.lastSeen)) {
      throw new Error("Invalid contact in encrypted storage.");
    }
    if (contact.signPk === null) continue;
    const signPk = key(contact.signPk, 32);
    const fp = toHex(fingerprint(pubkey, signPk));
    let verified = contact.verified;
    if (fp !== contact.fp) {
      renamed.set(contact.fp, fp);
      verified = false;
    }
    contacts.set(fp, { ...contact, fp, pubkey, signPk, verified });
  }
  for (const message of value.messages) {
    if (!message || typeof message.id !== "string" || typeof message.text !== "string" ||
        typeof message.conv !== "string" || !/^dm:[a-f0-9]{16}$/.test(message.conv) ||
        typeof message.senderFp !== "string" || typeof message.outgoing !== "boolean" || !Number.isFinite(message.ts) ||
        !["sending", "sent", "delivered", "failed", "received"].includes(message.state)) {
      throw new Error("Invalid message in encrypted storage.");
    }
    // Pending retries live in RAM; an app restart cannot resume those sends.
    if (message.state === "sending" || message.state === "sent") message.state = "failed";
    const moved = renamed.get(message.conv.slice(3));
    if (moved) message.conv = `dm:${moved}`;
    const movedSender = renamed.get(message.senderFp);
    if (movedSender) message.senderFp = movedSender;
  }
  return { snapshot: value, identity, contacts };
}
export const saveContacts = (contacts: Map<string, Contact>): SavedContact[] => [...contacts.values()].map((c) => ({
  ...c, pubkey: toB64(c.pubkey), signPk: toB64(c.signPk),
}));
