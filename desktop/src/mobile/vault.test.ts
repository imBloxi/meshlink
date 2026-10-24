import { expect, it } from "vitest";
import { Identity } from "../core/identity";
import { toB64 } from "../core/bytes";
import { makeContact } from "../core/contacts";
import { restoreSnapshot, saveContacts, displayName, serializeSnapshot, type Snapshot } from "./vault";

it("restores an interoperable identity and verified contact keys", () => {
  const identity = Identity.generate(), friend = makeContact(Identity.generate().pubkey, "Friend");
  friend.verified = true;
  const restored = restoreSnapshot(JSON.stringify({ version: 1, secret: toB64(identity.secretKey), name: "Alice", host: "192.168.4.1",
    contacts: saveContacts(new Map([[friend.fp, friend]])), messages: [] }));
  expect(restored.identity.pubkey).toEqual(identity.pubkey);
  expect(restored.contacts.get(friend.fp)).toEqual(friend);
});
it("refuses corrupt identity keys and contact fingerprints", () => {
  const contact = makeContact(Identity.generate().pubkey, "Friend");
  const snapshot = { version: 1, secret: toB64(Identity.generate().secretKey), name: "Alice", host: "192.168.4.1",
    contacts: saveContacts(new Map([[contact.fp, contact]])), messages: [] };
  expect(() => restoreSnapshot(JSON.stringify({ ...snapshot, secret: "AA==" }))).toThrow(/key/);
  snapshot.contacts[0].fp = "0000000000000000";
  expect(() => restoreSnapshot(JSON.stringify(snapshot))).toThrow(/contact/);
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
