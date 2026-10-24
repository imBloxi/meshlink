import { expect, it } from "vitest";
import { Identity } from "../core/identity";
import { toB64 } from "../core/bytes";
import { makeContact } from "../core/contacts";
import { restoreSnapshot, saveContacts, displayName, serializeSnapshot, type Snapshot } from "./vault";

it("restores an interoperable identity and verified contact keys", () => {
  const identity = Identity.generate(), other = Identity.generate();
  const friend = makeContact(other.pubkey, other.signPk, "Friend");
  friend.verified = true;
  const restored = restoreSnapshot(JSON.stringify({ version: 1, secret: toB64(identity.secretKey), name: "Alice", host: "192.168.4.1",
    contacts: saveContacts(new Map([[friend.fp, friend]])), messages: [] }));
  expect(restored.identity.pubkey).toEqual(identity.pubkey);
  expect(restored.contacts.get(friend.fp)).toEqual(friend);
});
it("refuses corrupt identity keys and contacts", () => {
  const other = Identity.generate();
  const contact = makeContact(other.pubkey, other.signPk, "Friend");
  const snapshot = { version: 1, secret: toB64(Identity.generate().secretKey), name: "Alice", host: "192.168.4.1",
    contacts: saveContacts(new Map([[contact.fp, contact]])), messages: [] };
  expect(() => restoreSnapshot(JSON.stringify({ ...snapshot, secret: "AA==" }))).toThrow(/key/);
  snapshot.contacts[0].name = 5 as never;
  expect(() => restoreSnapshot(JSON.stringify(snapshot))).toThrow(/contact/);
});
it("migrates pre-v3 contacts: new fingerprint, verification reset, history follows, no signing key means dropped", () => {
  const other = Identity.generate(), unsigned = Identity.generate();
  const fresh = makeContact(other.pubkey, other.signPk, "Friend");
  const oldFp = "aaaaaaaaaaaaaaaa", noKeyFp = "bbbbbbbbbbbbbbbb";
  const saved = saveContacts(new Map([[fresh.fp, fresh]]));
  saved[0] = { ...saved[0], fp: oldFp, verified: true };
  saved.push({ ...saved[0], fp: noKeyFp, pubkey: toB64(unsigned.pubkey), signPk: null });
  const message = (id: string, fp: string) => ({ id, conv: `dm:${fp}`, senderFp: fp, outgoing: false, text: "hi", ts: 1, state: "received" });
  const restored = restoreSnapshot(JSON.stringify({ version: 1, secret: toB64(Identity.generate().secretKey), name: "Alice", host: "192.168.4.1",
    contacts: saved, messages: [message("m1", oldFp)] }));
  expect([...restored.contacts.keys()]).toEqual([fresh.fp]);
  expect(restored.contacts.get(fresh.fp)!.verified).toBe(false);
  expect(restored.snapshot.messages[0]).toMatchObject({ conv: `dm:${fresh.fp}`, senderFp: fresh.fp });
});
it("bounds display names by UTF-8 bytes", () => {
  expect(displayName(" Alice ")).toBe("Alice");
  expect(() => displayName(" ")).toThrow();
  expect(() => displayName("🌍".repeat(9))).toThrow();
});

it("prunes oldest history by encoded bytes, preserving recent messages and identity", () => {
  const identity = Identity.generate();
  const snapshot: Snapshot = { version: 1, secret: toB64(identity.secretKey), name: "Alice", host: "192.168.4.1", contacts: [],
    messages: Array.from({ length: 1000 }, (_, i) => ({ id: `message-${i}`, conv: "dm:0000000000000000", senderFp: "0000000000000000",
      outgoing: false, text: '🌍"\\'.repeat(2000), ts: i, state: "received" })) };
  const serialized = serializeSnapshot(snapshot);
  expect(new TextEncoder().encode(serialized.json).length).toBeLessThanOrEqual(3 * 1024 * 1024);
  expect(serialized.messages.length).toBeLessThan(1000);
  expect(serialized.messages.at(-1)?.id).toBe("message-999");
  expect(restoreSnapshot(serialized.json).identity.pubkey).toEqual(identity.pubkey);
});
