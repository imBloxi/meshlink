// Build the "Break MeshLink" challenge capture with the real protocol code.
//
// Two accounts (Alice, Bob) on a private network chat through the real
// Messenger. Every frame is wrapped exactly as a node puts it on the air:
// [header 17][body][BLAKE2s-64 tag keyed with the network key]. Flags hide in
// one DM and in one private room message.
//
// Run:   npx vite-node scripts/make-challenge.ts -- <secrets-out.json>
// Public output: ../docs/challenge/capture-v1.json (safe to publish).
// Secret output: the path you pass. NEVER commit it: it holds the keys and flags.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2s } from "@noble/hashes/blake2.js";
import { concat, toB64, toHex, u32le } from "../src/core/bytes";
import type { Contact } from "../src/core/contacts";
import { Identity } from "../src/core/identity";
import { Messenger } from "../src/core/messenger";
import { createNetwork } from "../src/core/network";
import * as p from "../src/core/protocol";
import { privateRoom } from "../src/core/rooms";

const here = dirname(fileURLToPath(import.meta.url));
const secretsPath = process.argv.slice(2).find((a) => a !== "--");
if (!secretsPath) throw new Error("Pass a path for the secrets file, outside the repository.");
const repo = resolve(here, "../..");
if (resolve(secretsPath).startsWith(repo)) throw new Error("Refusing to write secrets inside the repository.");
if (existsSync(secretsPath)) throw new Error(`${secretsPath} exists. Use a new path: never reuse challenge keys.`);

const net = createNetwork("Break MeshLink", 6);
const netKey = Buffer.from(net.key, "base64");
const flag = () => `MESHLINK{${randomBytes(16).toString("hex")}}`;
const flags = { dm: flag(), room: flag() };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- Air framing, as firmware/src/main.cpp airSend() + computeTag() ----

const chips = { alice: 0x00a11ce5, bob: 0x00b0b0b5 };
const air: { t: number; from: string; type: number; hex: string }[] = [];
let clock = Date.UTC(2026, 9, 1, 18, 0, 0);

function airFrame(hostFrame: Uint8Array, chip: number): Uint8Array {
  if (hostFrame[0] !== p.H_SEND) throw new Error("not a SEND frame");
  const [type, flagsByte] = [hostFrame[1], hostFrame[2]];
  const body = hostFrame.subarray(3);
  const msgId = randomBytes(4).readUInt32LE(0) || 1;
  const header = concat(
    Uint8Array.of(0x4d, p.VERSION, type, 3), u32le(msgId), u32le(chip), u32le(net.netId), Uint8Array.of(flagsByte),
  );
  const unsigned = concat(header, body);
  const forTag = unsigned.slice();
  forTag[3] = 0; // TTL is not covered by the tag
  return concat(unsigned, blake2s(forTag, { key: netKey, dkLen: p.TAG_LEN }));
}

// ---- Two real messengers, wired back to back ----

type Peer = { name: string; id: Identity; m: Messenger; chip: number };
const peers: Peer[] = [];
for (const name of ["alice", "bob"] as const) {
  const id = Identity.generate();
  const peer = { name, id, chip: chips[name] } as Peer;
  peer.m = new Messenger(id, new Map<string, Contact>(), name === "alice" ? "Alice" : "Bob", (f) => {
    air.push({ t: clock, from: name, type: f[1], hex: toHex(airFrame(f, peer.chip)) });
    clock += 40 + Math.floor(Math.random() * 400);
    for (const other of peers) {
      if (other !== peer) other.m.handle({ kind: "recv", airType: f[1], ttl: 2, origin: peer.chip, msgId: 0, flags: f[2], body: f.slice(3) }, clock);
    }
  }, net.netId);
  peers.push(peer);
}
const [alice, bob] = peers;
const step = (s: number) => (clock += s * 1000);

alice.m.announce();
bob.m.announce();
step(3);
const bobForAlice = alice.m.contacts.get(toHex(bob.id.fp))!;
const aliceForBob = bob.m.contacts.get(toHex(alice.id.fp))!;

const chat: [Peer, string][] = [
  [alice, "hey, are you on the mesh?"],
  [bob, "yes, node on the roof works. 3 hops to you"],
  [alice, `the code for the box is ${flags.dm}`],
  [bob, "got it. deleting this after"],
];
for (const [who, text] of chat) {
  who.m.sendText(who === alice ? bobForAlice : aliceForBob, text, clock);
  step(5 + Math.random() * 20);
}

// A private room: Alice creates it, Bob joins with the invite.
const room = privateRoom(net.netId, "ops", alice.m.myFp, "Alice", toHex(alice.id.signPk));
alice.m.putRoom(room);
const { encodeRoomInvite, decodeRoomInvite } = await import("../src/core/payloads");
const code = encodeRoomInvite({
  roomId: Buffer.from(room.id, "hex"), key: Buffer.from(room.key, "base64"), epoch: 0, netId: net.netId, expires: 0,
  name: room.name, creatorFp: alice.id.fp, creatorSignPk: null,
}, alice.id);
alice.m.sendRoomInvite(bobForAlice, code, clock);
step(4);
bob.m.acceptInvite(decodeRoomInvite(code), clock);
step(6);
alice.m.sendRoomText(alice.m.rooms.get(room.id)!, `meeting point moved. password ${flags.room}`, clock);
step(9);
bob.m.sendRoomText(bob.m.rooms.get(room.id)!, "ok", clock);
for (let i = 0; i < 4; i++) {
  step(2);
  alice.m.tick(clock);
  bob.m.tick(clock);
}

// ---- Write outputs ----

const capture = {
  format: "meshlink-capture",
  v: 1,
  protocol: p.VERSION,
  description: "Raw ESP-NOW payloads recorded from a two-person MeshLink network. See docs/break-meshlink.md.",
  network: { netId: net.netId, channel: net.channel },
  people: Object.fromEntries(peers.map((x) => [x.name, {
    fingerprint: toHex(x.id.fp), boxPublicKey: toB64(x.id.pubkey), signPublicKey: toB64(x.id.signPk), nodeChipId: x.chip,
  }])),
  // SHA-256 of each flag, so a winner can prove a find without us revealing it.
  commitments: { dmFlag: sha256(flags.dm), roomFlag: sha256(flags.room) },
  frames: air,
};
const out = resolve(repo, "docs/challenge/capture-v1.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(capture, null, 2) + "\n");

const secrets = {
  WARNING: "Challenge secrets. Do not publish or commit until the challenge ends.",
  flags,
  networkKey: net.key,
  ownerSecret: net.ownerSecret,
  alice: toB64(alice.id.secretKey),
  bob: toB64(bob.id.secretKey),
  room: { id: room.id, key: room.key },
};
mkdirSync(dirname(resolve(secretsPath)), { recursive: true });
writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
console.log(`${air.length} frames -> ${out}`);
console.log(`secrets -> ${resolve(secretsPath)} (keep private)`);
console.log(`commitments: dm ${capture.commitments.dmFlag}, room ${capture.commitments.roomFlag}`);
