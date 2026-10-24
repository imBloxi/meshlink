import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import vectors from "./__fixtures__/v1-vectors.json";
import { concat, fromHex, toHex, u32le } from "./bytes";
import type { Contact } from "./contacts";
import { classifyAnnounce, makeContact } from "./contacts";
import { cobsDecode, cobsEncode, crc16, encodeFrame, FrameReader } from "./framing";
import { Identity, isValidPhrase, safetyNumber } from "./identity";
import { chunkBytes, CONTROL_MAX_AGE_S, FAIL_AT, Messenger, NEW_CONTACTS_PER_MIN, type MessengerOutput } from "./messenger";
import { createNetwork, inviteOf } from "./network";
import * as pl from "./payloads";
import * as p from "./protocol";
import { isNewer } from "../shared/version";
import { PREV_KEY_GRACE_MS, privateRoom, publicRoom, roomIdBytes, roomKey, type Room } from "./rooms";

describe("framing (shared with the Python app and firmware)", () => {
  it("crc16", () => {
    for (const v of vectors.crc16) expect(crc16(fromHex(v.in))).toBe(v.crc);
  });

  it("cobs", () => {
    for (const v of vectors.cobs) {
      expect(toHex(cobsEncode(fromHex(v.in)))).toBe(v.out);
      expect(toHex(cobsDecode(fromHex(v.out)))).toBe(v.in);
    }
  });

  it("wire frames", () => {
    for (const v of vectors.frames) expect(toHex(encodeFrame(fromHex(v.in)))).toBe(v.wire);
  });

  it("frame reader drops noise and splits frames", () => {
    const r = new FrameReader();
    const a = encodeFrame(Uint8Array.of(p.H_LOG, 65));
    const b = encodeFrame(Uint8Array.of(p.H_SENT, 1, 0, 0, 0));
    const frames = r.feed(Uint8Array.from([0x13, 0x37, 0, ...a, ...b]));
    expect(frames.map((f) => f[0])).toEqual([p.H_LOG, p.H_SENT]);
  });

  it("box is byte-identical to PyNaCl", () => {
    const b = vectors.box;
    const alice = new Identity(fromHex(b.alice_sk));
    const bob = new Identity(fromHex(b.bob_sk));
    expect(toHex(alice.pubkey)).toBe(b.alice_pk);
    expect(toHex(alice.fp)).toBe(b.alice_fp);
    const { ciphertext } = alice.seal(bob.pubkey, fromHex(b.plain), fromHex(b.nonce));
    expect(toHex(ciphertext)).toBe(b.ciphertext);
    expect(toHex(nacl.box.open(fromHex(b.ciphertext), fromHex(b.nonce), alice.pubkey, bob.secretKey)!)).toBe(b.plain);
  });
});

describe("host frames v2", () => {
  it("parses INFO with role, network and node name", () => {
    const f = Uint8Array.from([
      p.H_INFO, 2, 0xee, 0xff, 0xc0, 0, 1, 2, 3, 4, 5, 6, 6,
      5, ...new TextEncoder().encode("0.3.0"), p.ROLE_ADMIN, p.PERM_FULL, 0x78, 0x56, 0x34, 0x12, 2, 65, 66,
    ]);
    expect(p.parseHostFrame(f)).toEqual({
      kind: "info", version: 2, chipId: 0xc0ffee, mac: "01:02:03:04:05:06", channel: 6, fwVersion: "0.3.0",
      role: "admin", perm: 2, netId: 0x12345678, nodeName: "AB",
    });
  });

  it("config TLV round-trips", () => {
    const cfg = { nodeName: "Roof", netId: 0xdeadbeef, netKey: new Uint8Array(16).fill(7), channel: 11, apHidden: true, guestPerm: 1 as const, ownerPk: null };
    const back = p.decodeConfig(p.encodeConfig(cfg));
    expect(back).toEqual(cfg);
  });

  it("parses sessions and bans", () => {
    const s = p.parseHostFrame(Uint8Array.from([p.H_SESSIONS, 1, 1, 2, 3, 4, 5, 6, 7, 8, 2, 10, 0, 0, 0, 3, 0, 4, 0]));
    expect(s).toEqual({ kind: "sessions", sessions: [{ pseudo: "0102030405060708", perm: 2, connectedSecs: 10, tx: 3, rx: 4 }] });
    const b = p.parseHostFrame(Uint8Array.from([p.H_BANS, 2, 2, 4, 1, 0, 0, 0, 1, 8, 1, 2, 3, 4, 5, 6, 7, 8]));
    expect(b).toEqual({ kind: "bans", bans: [{ kind: 2, id: "01000000" }, { kind: 1, id: "0102030405060708" }] });
  });
});

describe("account", () => {
  it("recovery phrase restores the same keys", () => {
    const a = Identity.generate();
    const phrase = a.phrase();
    expect(phrase.split(" ")).toHaveLength(24);
    expect(isValidPhrase(phrase)).toBe(true);
    const b = Identity.fromPhrase(`  ${phrase.toUpperCase()}  `);
    expect(toHex(b.fp)).toBe(toHex(a.fp));
    expect(toHex(b.signPk)).toBe(toHex(a.signPk));
  });

  it("rejects a phrase with a wrong word", () => {
    const words = Identity.generate().phrase().split(" ");
    words[3] = words[3] === "zoo" ? "abandon" : "zoo";
    expect(() => Identity.fromPhrase(words.join(" "))).toThrow();
  });

  it("guest keys differ per network and are not the account key", () => {
    const a = Identity.generate();
    const g1 = a.guestKey(1).publicKey, g2 = a.guestKey(2).publicKey;
    expect(toHex(g1)).not.toBe(toHex(g2));
    expect(toHex(g1)).not.toBe(toHex(a.signPk));
    const { pk, sig } = a.guestAuth(1, new Uint8Array(16), 42);
    expect(nacl.sign.detached.verify(Uint8Array.from([...new TextEncoder().encode("ml-auth"), ...new Uint8Array(16), 42, 0, 0, 0]), sig, pk)).toBe(true);
  });

  it("safety number is the same from both sides", () => {
    const a = Identity.generate(), b = Identity.generate();
    expect(safetyNumber(a.fp, b.fp)).toBe(safetyNumber(b.fp, a.fp));
    expect(safetyNumber(a.fp, b.fp)).toMatch(/^(\d{5} ){11}\d{5}$/);
  });
});

describe("payloads", () => {
  it("signed announce verifies and rejects tampering", () => {
    const a = Identity.generate();
    const body = pl.packAnnounce(a, "Alice");
    expect(body.length).toBeLessThanOrEqual(p.MAX_BODY);
    expect(pl.unpackAnnounce(body)?.name).toBe("Alice");
    const forged = body.slice();
    forged[70] ^= 1; // change the name
    expect(pl.unpackAnnounce(forged)).toBeNull();
  });

  it("room invite round-trips and detects changes", () => {
    const a = Identity.generate();
    const r = privateRoom(5, "Ops", toHex(a.fp), "Alice", toHex(a.signPk));
    const code = pl.encodeRoomInvite({ roomId: roomIdBytes(r), key: roomKey(r), epoch: 0, netId: 5, expires: 0, name: "Ops", creatorFp: a.fp, creatorSignPk: null }, a);
    const inv = pl.decodeRoomInvite(code);
    expect(toHex(inv.roomId)).toBe(r.id);
    expect(inv.name).toBe("Ops");
    expect(inv.creatorSignPk).toBeNull(); // v1 invites still open
    const v2 = pl.decodeRoomInvite(pl.encodeRoomInvite({ roomId: roomIdBytes(r), key: roomKey(r), epoch: 0, netId: 5, expires: 0, name: "Ops", creatorFp: a.fp, creatorSignPk: a.signPk }, a));
    expect(toHex(v2.creatorSignPk!)).toBe(toHex(a.signPk));
    expect(v2.name).toBe("Ops");
    const bad = code.slice(0, 20) + (code[20] === "A" ? "B" : "A") + code.slice(21);
    expect(() => pl.decodeRoomInvite(bad)).toThrow();
  });

  it("network invite round-trips", () => {
    const n = createNetwork("Base");
    const back = pl.decodeNetworkInvite(pl.encodeNetworkInvite(inviteOf(n)));
    expect(back.netId).toBe(n.netId);
    expect(back.name).toBe("Base");
    expect(back.ownerPk).not.toBeNull();
  });

  it("policy is signed by the owner only", () => {
    const owner = nacl.sign.keyPair(), other = nacl.sign.keyPair();
    const entries: pl.PolicyEntry[] = [{ op: "ban", kind: 1, id: new Uint8Array(8).fill(9) }, { op: "unban", kind: 2, id: Uint8Array.of(1, 2, 3, 4) }];
    const body = pl.packPolicy(77, 3, entries, owner.secretKey);
    expect(pl.unpackPolicy(77, body, owner.publicKey)).toEqual({ seq: 3, entries });
    expect(pl.unpackPolicy(77, body, other.publicKey)).toBeNull();
    expect(pl.unpackPolicy(78, body, owner.publicKey)).toBeNull(); // other network
  });

  it("a new key with a verified contact's name is an impostor", () => {
    const alice = makeContact(Identity.generate().pubkey, "Alice");
    const contacts = new Map([[alice.fp, alice]]);
    const other = Identity.generate().pubkey;
    expect(classifyAnnounce(contacts, alice.pubkey, "Alice")).toBe("known");
    expect(classifyAnnounce(contacts, other, " alice ")).toBe("new"); // not verified yet: no protection
    alice.verified = true;
    expect(classifyAnnounce(contacts, other, " ALICE ")).toBe("impostor");
    expect(classifyAnnounce(contacts, other, "Bob")).toBe("new");
    expect(classifyAnnounce(contacts, other, "")).toBe("new");
  });

  it("padding round-trips and rejects a missing marker", () => {
    const b = Uint8Array.of(1, 2, 0, 3);
    expect(Array.from(pl.unpad(pl.pad(b, 40))!)).toEqual([1, 2, 0, 3]);
    expect(Array.from(pl.unpad(pl.pad(new Uint8Array(), 1))!)).toEqual([]);
    expect(pl.unpad(new Uint8Array(8))).toBeNull();
    expect(() => pl.pad(new Uint8Array(40), 40)).toThrow();
  });

  it("every DM and room frame on the air has the same size", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    a.m.sendText(a.m.contacts.get(toHex(b.id.fp))!, "hi");
    a.m.sendText(a.m.contacts.get(toHex(b.id.fp))!, "x".repeat(600));
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    b.m.putRoom(room);
    a.m.sendRoomText(room, "short");
    a.m.sendRoomText(room, "y".repeat(400));
    const sizes = [...a.frames, ...b.frames].filter((f) => f[1] === p.AIR_DM || f[1] === p.AIR_ROOM).map((f) => f.length - 3);
    expect(sizes.length).toBeGreaterThan(6); // texts, chunks and ACKs
    expect(new Set(sizes)).toEqual(new Set([p.MAX_BODY]));
    expect(messages(b).map((m) => m.text)).toEqual(["hi", "x".repeat(600), "short", "y".repeat(400)]);
  });

  it("frames from 0.3 senders (no padding) still open", () => {
    const a = Identity.generate(), b = Identity.generate();
    const chunk = concat(Uint8Array.of(pl.DM_TEXT), u32le(1), u32le(7), Uint8Array.of(0, 1), new TextEncoder().encode("old"));
    const nonce = nacl.randomBytes(24);
    const body = concat(nonce, nacl.box(chunk, nonce, b.pubkey, a.secretKey));
    const c = pl.openDm(b.sharedKey(a.pubkey), body)!;
    expect([c.kind, new TextDecoder().decode(c.payload)]).toEqual([pl.DM_TEXT, "old"]);
  });

  it("chunking never splits a character and respects limits", () => {
    const text = "héllo 🛰️ ".repeat(40);
    const b = new TextEncoder().encode(text);
    const parts = chunkBytes(b, 50, 20);
    expect(parts.slice(0, -1).every((x) => x.length <= 50)).toBe(true);
    expect(parts.at(-1)!.length).toBeLessThanOrEqual(20);
    expect(parts.map((x) => new TextDecoder("utf-8", { fatal: true }).decode(x)).join("")).toBe(text);
  });
});

// ---- A small radio: messengers connected through a lossy broadcast bus ----

function mesh(names: string[], loss = 0, seed = 1) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const nodes: { m: Messenger; id: Identity; out: MessengerOutput[]; frames: Uint8Array[] }[] = [];
  let msgId = 1;
  for (const name of names) {
    const id = Identity.generate();
    const node = { id, out: [] as MessengerOutput[], frames: [] as Uint8Array[], m: null as unknown as Messenger };
    node.m = new Messenger(id, new Map<string, Contact>(), name, (f) => {
      expect(f.length - 3).toBeLessThanOrEqual(p.MAX_BODY); // every frame fits the air
      node.frames.push(f);
      for (const other of nodes) {
        if (other === node || rand() < loss) continue;
        other.out.push(...other.m.handle({ kind: "recv", airType: f[1], ttl: 2, origin: 1, msgId: msgId++, flags: f[2], body: f.slice(3) }));
      }
    });
    nodes.push(node);
  }
  return nodes;
}

function introduce(nodes: ReturnType<typeof mesh>) {
  for (const n of nodes) n.m.announce();
}

const messages = (n: { out: MessengerOutput[] }) =>
  n.out.flatMap((o) => (o.kind === "message" ? [o.message] : []));

describe("messenger v2", () => {
  it("contacts appear from signed announces", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    expect([...a.m.contacts.values()].map((c) => c.name)).toEqual(["bob"]);
    expect([...b.m.contacts.values()][0].signPk).not.toBeNull();
  });

  it("DM: our own frame played back to us is not taken as the contact's", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    a.m.sendText(a.m.contacts.get(toHex(b.id.fp))!, "secret plan");
    const mine = a.frames.find((f) => f[1] === p.AIR_DM)!;
    const out = a.m.handle({ kind: "recv", airType: p.AIR_DM, ttl: 2, origin: 9, msgId: 999, flags: 0, body: mine.slice(3) });
    expect(messages({ out })).toEqual([]);
  });

  it("announce: another signing key for a known contact is ignored", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    const mallory = Identity.generate();
    const name = new TextEncoder().encode("mallory");
    // Bob's public box key, Mallory's signing key and a new name.
    const body = concat(b.id.pubkey, mallory.signPk, u32le(Math.floor(Date.now() / 1000) + 60), Uint8Array.of(0, name.length), name);
    const forged = concat(body, mallory.sign(concat(new TextEncoder().encode("ml-announce"), body)));
    const out = a.m.handle({ kind: "recv", airType: p.AIR_ANNOUNCE, ttl: 2, origin: 9, msgId: 998, flags: 0, body: forged });
    const bob = a.m.contacts.get(toHex(b.id.fp))!;
    expect(bob.name).toBe("bob");
    expect(toHex(bob.signPk!)).toBe(toHex(b.id.signPk));
    expect(out.some((o) => o.kind === "notice" && o.level === "warning")).toBe(true);
  });

  it("announce: a replayed older announce does not roll back the name", () => {
    const [a, b] = mesh(["alice", "bob"]);
    const old = pl.packAnnounce(b.id, "bob-old", 1000);
    b.m.name = "bob";
    introduce([a, b]);
    a.m.handle({ kind: "recv", airType: p.AIR_ANNOUNCE, ttl: 2, origin: 9, msgId: 997, flags: 0, body: old });
    expect(a.m.contacts.get(toHex(b.id.fp))!.name).toBe("bob");
  });

  it("DM: hidden recipient, delivered receipt", () => {
    const [a, b, c] = mesh(["alice", "bob", "carol"]);
    introduce([a, b, c]);
    const bobC = a.m.contacts.get(toHex(b.id.fp))!;
    const sent = a.m.sendText(bobC, "hi bob");
    expect(messages(b).map((m) => m.text)).toEqual(["hi bob"]);
    expect(messages(c)).toEqual([]); // carol cannot read it
    expect(a.out).toContainEqual({ kind: "state", id: sent.id, state: "delivered" });
    // No fingerprints in clear: the body never contains bob's fp.
    expect(toHex(a.frames.at(-1)!)).not.toContain(toHex(b.id.fp));
  });

  it("long DM is split and reassembled once", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    const text = "long message ".repeat(50);
    a.m.sendText(a.m.contacts.get(toHex(b.id.fp))!, text);
    expect(messages(b).map((m) => m.text)).toEqual([text]);
  });

  it("retries over a lossy radio: every message ends delivered or failed", () => {
    const [a, b] = mesh(["alice", "bob"], 0.3, 7);
    a.m.contacts.set(toHex(b.id.fp), makeContact(b.id.pubkey, "bob"));
    b.m.contacts.set(toHex(a.id.fp), makeContact(a.id.pubkey, "alice"));
    const bobC = a.m.contacts.get(toHex(b.id.fp))!;
    const ids = Array.from({ length: 40 }, (_, i) => a.m.sendText(bobC, `m${i}`, 0).id);
    for (let t = 0; t <= FAIL_AT + 500; t += 250) a.out.push(...a.m.tick(t));
    const final = new Map<string, string>();
    for (const o of a.out) if (o.kind === "state") final.set(o.id, o.state);
    const delivered = ids.filter((id) => final.get(id) === "delivered").length;
    expect(ids.every((id) => final.has(id))).toBe(true);
    expect(delivered).toBeGreaterThan(30); // 30% loss, 3 tries each way
    // Bob never shows a message twice, even when retries arrive.
    const got = messages(b).map((m) => m.id);
    expect(new Set(got).size).toBe(got.length);
  });

  it("rooms: members read, outsiders don't, signatures are checked", () => {
    const [a, b, c] = mesh(["alice", "bob", "carol"]);
    introduce([a, b, c]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    const code = pl.encodeRoomInvite({ roomId: roomIdBytes(room), key: roomKey(room), epoch: 0, netId: 0, expires: 0, name: "Ops", creatorFp: a.id.fp, creatorSignPk: null }, a.id);
    b.m.acceptInvite(pl.decodeRoomInvite(code));
    a.m.sendRoomText(a.m.rooms.get(room.id)!, "welcome");
    expect(messages(b).map((m) => [m.text, m.verified])).toEqual([["welcome", true]]);
    expect(messages(c)).toEqual([]);
  });

  it("public rooms: same name, same room", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    a.m.putRoom(publicRoom(0, "#General"));
    b.m.putRoom(publicRoom(0, "general"));
    b.m.sendRoomText(b.m.rooms.get(publicRoom(0, "general").id)!, "hello all");
    expect(messages(a).map((m) => m.text)).toEqual(["hello all"]);
  });

  it("kick rotates the key: the kicked member can no longer read", () => {
    const [a, b, c] = mesh(["alice", "bob", "carol"]);
    introduce([a, b, c]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    const code = pl.encodeRoomInvite({ roomId: roomIdBytes(room), key: roomKey(room), epoch: 0, netId: 0, expires: 0, name: "Ops", creatorFp: a.id.fp, creatorSignPk: null }, a.id);
    b.m.acceptInvite(pl.decodeRoomInvite(code));
    c.m.acceptInvite(pl.decodeRoomInvite(code));
    const { room: next } = a.m.kickFromRoom(a.m.rooms.get(room.id)!, toHex(c.id.fp));
    expect(next.epoch).toBe(1);
    expect(c.out).toContainEqual(expect.objectContaining({ kind: "roomRemoved" }));
    expect(b.m.rooms.get(room.id)!.epoch).toBe(1);
    a.m.sendRoomText(a.m.rooms.get(room.id)!, "after kick");
    expect(messages(b).map((m) => m.text)).toContain("after kick");
    expect(messages(c).map((m) => m.text)).not.toContain("after kick");
  });

  it("moderators can delete messages; members can only delete their own", () => {
    const [a, b, c] = mesh(["alice", "bob", "carol"]);
    introduce([a, b, c]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    const code = pl.encodeRoomInvite({ roomId: roomIdBytes(room), key: roomKey(room), epoch: 0, netId: 0, expires: 0, name: "Ops", creatorFp: a.id.fp, creatorSignPk: null }, a.id);
    b.m.acceptInvite(pl.decodeRoomInvite(code));
    c.m.acceptInvite(pl.decodeRoomInvite(code));
    const msg = b.m.sendRoomText(b.m.rooms.get(room.id)!, "oops");
    c.m.deleteRoomMessage(c.m.rooms.get(room.id)!, msg.id); // not allowed
    expect(a.out.filter((o) => o.kind === "deleted")).toEqual([]);
    a.m.deleteRoomMessage(a.m.rooms.get(room.id)!, msg.id); // creator: allowed
    expect(b.out).toContainEqual({ kind: "deleted", conv: `room:${room.id}`, id: msg.id });
  });

  /** A room frame signed by `signer` but claiming to come from `senderFp`. */
  function forgedRoomFrame(room: Room, epoch: number, key: Uint8Array, signer: Identity, senderFp: Uint8Array, kind: number, payload: Uint8Array, ts = Math.floor(Date.now() / 1000)) {
    const group = (Math.random() * 0xffffffff) >>> 0;
    const sig = signer.sign(pl.roomSigMessage(roomIdBytes(room), epoch, senderFp, kind, ts, group, payload));
    return pl.sealRoom(roomIdBytes(room), epoch, key, { kind, ts, group, idx: 0, total: 1, payload, senderFp, sig });
  }
  const recv = (body: Uint8Array): p.NodeEvent => ({ kind: "recv", airType: p.AIR_ROOM, ttl: 2, origin: 9, msgId: 1, flags: 0, body });

  it("rooms: a key holder cannot take over the creator's identity", () => {
    // Dave is not a contact of Alice: he only knows her through the invite.
    const [a, d] = mesh(["alice", "dave"]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    const code = pl.encodeRoomInvite({
      roomId: roomIdBytes(room), key: roomKey(room), epoch: 0, netId: 0, expires: 0, name: "Ops", creatorFp: a.id.fp, creatorSignPk: a.id.signPk,
    }, a.id);
    d.m.acceptInvite(pl.decodeRoomInvite(code));
    // Mallory holds the room key and announces herself as Alice.
    const mallory = Identity.generate();
    const join = concat(mallory.signPk, a.id.pubkey, new TextEncoder().encode("alice"));
    const out = d.m.handle(recv(forgedRoomFrame(room, 0, roomKey(room), mallory, a.id.fp, pl.ROOM_JOIN, join)));
    expect(out.some((o) => o.kind === "notice" && o.level === "warning")).toBe(true);
    expect(d.m.rooms.get(room.id)!.members[toHex(a.id.fp)].signPk).toBe(toHex(a.id.signPk));
    a.m.sendRoomText(a.m.rooms.get(room.id)!, "real alice");
    expect(messages(d).map((m) => [m.text, m.verified])).toEqual([["real alice", true]]);
  });

  it("rooms: a JOIN cannot pin a key for someone else's fingerprint", () => {
    const [a, d] = mesh(["alice", "dave"]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    d.m.putRoom(room);
    const bob = Identity.generate(), mallory = Identity.generate();
    // Mallory's box key does not match Bob's fingerprint.
    const join = concat(mallory.signPk, mallory.pubkey, new TextEncoder().encode("bob"));
    d.m.handle(recv(forgedRoomFrame(room, 0, roomKey(room), mallory, bob.fp, pl.ROOM_JOIN, join)));
    expect(d.m.rooms.get(room.id)!.members[toHex(bob.fp)]?.signPk ?? "").toBe("");
    void a;
  });

  it("kick: the removed member's old key stops working, others get a grace period", () => {
    const [a, b, c, d] = mesh(["alice", "bob", "carol", "dave"]);
    introduce([a, b, c, d]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    const code = pl.encodeRoomInvite({ roomId: roomIdBytes(room), key: roomKey(room), epoch: 0, netId: 0, expires: 0, name: "Ops", creatorFp: a.id.fp, creatorSignPk: a.id.signPk }, a.id);
    for (const n of [b, c, d]) n.m.acceptInvite(pl.decodeRoomInvite(code));
    const oldKey = roomKey(room);
    a.m.kickFromRoom(a.m.rooms.get(room.id)!, toHex(c.id.fp));
    expect(b.m.rooms.get(room.id)!.epoch).toBe(1);
    const text = new TextEncoder().encode("still here");
    // Carol (kicked) under the old key: dropped.
    b.out.push(...b.m.handle(recv(forgedRoomFrame(room, 0, oldKey, c.id, c.id.fp, pl.ROOM_TEXT, text))));
    expect(messages(b).map((m) => m.text)).not.toContain("still here");
    // Dave (still a member) under the old key: fine during the grace period...
    b.out.push(...b.m.handle(recv(forgedRoomFrame(room, 0, oldKey, d.id, d.id.fp, pl.ROOM_TEXT, new TextEncoder().encode("late")))));
    expect(messages(b).map((m) => m.text)).toContain("late");
    // ...but not after it.
    b.out.push(...b.m.handle(recv(forgedRoomFrame(room, 0, oldKey, d.id, d.id.fp, pl.ROOM_TEXT, new TextEncoder().encode("too late"))), Date.now() + PREV_KEY_GRACE_MS + 1000));
    expect(messages(b).map((m) => m.text)).not.toContain("too late");
  });

  it("rooms: a moderation frame replayed after a restart is not applied again", () => {
    const [a, b, c] = mesh(["alice", "bob", "carol"]);
    introduce([a, b, c]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    a.m.putRoom(room);
    const code = pl.encodeRoomInvite({ roomId: roomIdBytes(room), key: roomKey(room), epoch: 0, netId: 0, expires: 0, name: "Ops", creatorFp: a.id.fp, creatorSignPk: a.id.signPk }, a.id);
    b.m.acceptInvite(pl.decodeRoomInvite(code));
    a.m.setModerator(a.m.rooms.get(room.id)!, toHex(c.id.fp), true);
    const promote = a.frames.at(-1)!;
    a.m.setModerator(a.m.rooms.get(room.id)!, toHex(c.id.fp), false);
    expect(b.m.rooms.get(room.id)!.members[toHex(c.id.fp)].role).toBe("member");
    // Bob restarts: dedupe memory is gone, the room record (with lastCtl) is kept.
    const b2 = new Messenger(b.id, b.m.contacts, "bob", () => {});
    b2.setRooms([...b.m.rooms.values()]);
    b2.handle(recv(promote.slice(3)));
    expect(b2.rooms.get(room.id)!.members[toHex(c.id.fp)].role).toBe("member");
  });

  it("rooms: stale moderation frames are refused", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    const room = privateRoom(0, "Ops", toHex(a.id.fp), "alice", toHex(a.id.signPk));
    b.m.putRoom(room);
    const old = Math.floor(Date.now() / 1000) - CONTROL_MAX_AGE_S - 60;
    const target = concat(Identity.generate().fp, Uint8Array.of(1));
    b.m.handle(recv(forgedRoomFrame(room, 0, roomKey(room), a.id, a.id.fp, pl.ROOM_MOD, target, old)));
    expect(b.m.rooms.get(room.id)!.members[toHex(target.subarray(0, 8))]).toBeUndefined();
  });

  it("announce flood: new contacts are rate limited", () => {
    const [a] = mesh(["alice"]);
    for (let i = 0; i < NEW_CONTACTS_PER_MIN + 5; i++) {
      a.m.handle({ kind: "recv", airType: p.AIR_ANNOUNCE, ttl: 2, origin: 9, msgId: i, flags: 0, body: pl.packAnnounce(Identity.generate(), `bot${i}`) });
    }
    expect(a.m.contacts.size).toBe(NEW_CONTACTS_PER_MIN);
  }, 30_000);

  it("DM: replaying a delivered frame triggers only a few ACKs", () => {
    const [a, b] = mesh(["alice", "bob"]);
    introduce([a, b]);
    a.m.sendText(a.m.contacts.get(toHex(b.id.fp))!, "hi");
    const frame = a.frames.at(-1)!;
    const before = b.frames.length;
    for (let i = 0; i < 10; i++) b.m.handle({ kind: "recv", airType: p.AIR_DM, ttl: 2, origin: 9, msgId: 500 + i, flags: 0, body: frame.slice(3) });
    expect(b.frames.length - before).toBe(3);
  });
});

describe("backup", () => {
  it("opens with the right passphrase only", async () => {
    const { createBackup, openBackup } = await import("./backup");
    const fast = { m: 256, t: 1, p: 1 };
    const content = { version: 1 as const, createdAt: 1, identity: "abc", name: "Alice", contacts: [], rooms: [], networks: [], settings: {} };
    const file = await createBackup(content, "correct horse", fast);
    expect(await openBackup(file, "correct horse")).toEqual(content);
    await expect(openBackup(file, "wrong horse")).rejects.toThrow(/Wrong passphrase/);
    expect(file).not.toContain("Alice");
  });
});

describe("release versions", () => {
  it("compares tags", () => {
    expect(isNewer("v0.4.0", "0.3.1")).toBe(true);
    expect(isNewer("0.3.10", "0.3.9")).toBe(true);
    expect(isNewer("0.3.1", "0.3.1")).toBe(false);
    expect(isNewer("v0.2.9", "0.3.0")).toBe(false);
    expect(isNewer("nightly", "0.3.0")).toBe(false);
  });
});
