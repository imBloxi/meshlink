// App payloads v2: what goes inside an air frame body. Nodes never read these.
// All integers little-endian. See PROTOCOL.md section 3.
import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import { concat, dec, enc, fromB64Url, readU32, toB64Url, u32le } from "./bytes";
import { FP_LEN, verify, type Identity } from "./identity";
import { MAX_BODY, truncateUtf8, type BanKind } from "./protocol";

export const PUBKEY_LEN = 32;
export const SIG_LEN = 64;
export const NONCE_LEN = 24;
export const BOX_OVERHEAD = 16;
export const MAX_NAME = 32;

// ---- ANNOUNCE: signed identity ----
// boxPk(32) signPk(32) ts(4) flags(1) nameLen(1) name sig(64)
// sig = Ed25519("ml-announce" | everything before sig)

export interface Announce {
  pubkey: Uint8Array;
  signPk: Uint8Array;
  ts: number;
  name: string;
}

export function packAnnounce(me: Identity, name: string, ts = Math.floor(Date.now() / 1000)): Uint8Array {
  const n = truncateUtf8(name, MAX_NAME);
  const body = concat(me.pubkey, me.signPk, u32le(ts), Uint8Array.of(0, n.length), n);
  return concat(body, me.sign(concat(enc.encode("ml-announce"), body)));
}

/** Parse and verify. Returns null for malformed or forged announces. */
export function unpackAnnounce(b: Uint8Array): Announce | null {
  if (b.length < 70 + SIG_LEN) return null;
  const nameLen = b[69];
  const end = 70 + nameLen;
  if (b.length !== end + SIG_LEN) return null;
  const signPk = b.slice(32, 64);
  if (!verify(concat(enc.encode("ml-announce"), b.subarray(0, end)), b.subarray(end), signPk)) return null;
  return { pubkey: b.slice(0, 32), signPk, ts: readU32(b, 64), name: dec.decode(b.subarray(70, end)) };
}

// ---- Chunk header, shared by DMs and rooms ----
// kind(1) ts(4) group(4) idx(1) total(1): a message split into `total` frames.

export interface Chunk {
  kind: number;
  ts: number;
  group: number; // message id, random per message
  idx: number;
  total: number;
  payload: Uint8Array;
}

const CHUNK_HDR = 11;

// ---- Padding: every DM and room frame on the air has the same size ----
// Set on `kind` when the payload is padded (ISO/IEC 7816-4: 0x80 then zeros).
// Without padding, frame size gives away message length and tells ACKs
// apart from text. Padding happens inside the encryption.
export const PADDED = 0x80;

export function pad(b: Uint8Array, size: number): Uint8Array {
  if (b.length + 1 > size) throw new Error("payload too long to pad");
  const out = new Uint8Array(size);
  out.set(b);
  out[b.length] = 0x80;
  return out;
}

export function unpad(b: Uint8Array): Uint8Array | null {
  let i = b.length - 1;
  while (i >= 0 && b[i] === 0) i--;
  return i >= 0 && b[i] === 0x80 ? b.slice(0, i) : null;
}

function packChunk(c: Chunk, padTo = 0): Uint8Array {
  const payload = padTo ? pad(c.payload, padTo - CHUNK_HDR) : c.payload;
  return concat(Uint8Array.of(padTo ? c.kind | PADDED : c.kind), u32le(c.ts), u32le(c.group), Uint8Array.of(c.idx, c.total), payload);
}

function unpackChunk(b: Uint8Array): Chunk | null {
  if (b.length < CHUNK_HDR) return null;
  let payload: Uint8Array | null = b.slice(CHUNK_HDR);
  if (b[0] & PADDED) payload = unpad(payload);
  if (!payload) return null;
  const c = { kind: b[0] & ~PADDED, ts: readU32(b, 1), group: readU32(b, 5), idx: b[9], total: b[10], payload };
  return c.total >= 1 && c.idx < c.total ? c : null;
}

// ---- DM: hidden recipient ----
// nonce(24) box(chunk). No fingerprints in clear: receivers try each contact.

export const DM_TEXT = 0x01;
export const DM_ACK = 0x02; // payload: acked group(4)
export const DM_ROOM_INVITE = 0x03; // payload: invite code (UTF-8)
export const DM_ROOM_KEY = 0x04; // payload: roomId(16) epoch(4) key(32)
export const DM_NET_INVITE = 0x05; // payload: network code (UTF-8)

const DM_PLAIN = MAX_BODY - NONCE_LEN - BOX_OVERHEAD; // 185: chunk incl. header and padding
export const DM_CHUNK_MAX = DM_PLAIN - CHUNK_HDR - 1; // 173: one byte for the pad marker

export function sealDm(sharedKey: Uint8Array, c: Chunk): Uint8Array {
  const nonce = nacl.randomBytes(NONCE_LEN);
  const body = concat(nonce, nacl.box.after(packChunk(c, DM_PLAIN), nonce, sharedKey));
  if (body.length > MAX_BODY) throw new Error("DM too long");
  return body;
}

/** Try one shared key. Returns the chunk, or null if not for this key. */
export function openDm(sharedKey: Uint8Array, body: Uint8Array): Chunk | null {
  if (body.length < NONCE_LEN + BOX_OVERHEAD + CHUNK_HDR) return null;
  const plain = nacl.box.open.after(body.subarray(NONCE_LEN), body.subarray(0, NONCE_LEN), sharedKey);
  return plain ? unpackChunk(plain) : null;
}

export function dmNonce(body: Uint8Array): Uint8Array {
  return body.subarray(0, NONCE_LEN);
}

// ---- ROOM ----
// roomTag(4) nonce(24) secretbox(chunk with senderFp(8) after the header,
// and sig(64) appended to the last chunk).

export const ROOM_TEXT = 0x01;
export const ROOM_JOIN = 0x02; // payload: signPk(32) boxPk(32) name
export const ROOM_LEAVE = 0x03;
export const ROOM_MOD = 0x04; // payload: targetFp(8) role(1: 0 member, 1 moderator)
export const ROOM_DELETE = 0x05; // payload: senderFp(8) group(4) of the message to delete
export const ROOM_KICK = 0x06; // payload: targetFp(8), sent right before a key rotation

const ROOM_HDR = 4 + NONCE_LEN + BOX_OVERHEAD + CHUNK_HDR + FP_LEN; // 63
const ROOM_PLAIN = MAX_BODY - 4 - NONCE_LEN - BOX_OVERHEAD; // 181: inner incl. header, padding and sig
export const ROOM_CHUNK_MAX = MAX_BODY - ROOM_HDR - 1; // 161: one byte for the pad marker
export const ROOM_LAST_CHUNK_MAX = ROOM_CHUNK_MAX - SIG_LEN; // 97

export function roomTag(roomId: Uint8Array, epoch: number): Uint8Array {
  return blake2b(concat(enc.encode("ml-room-tag"), roomId, u32le(epoch)), { dkLen: 4 });
}

export interface RoomChunk extends Chunk {
  senderFp: Uint8Array;
  sig: Uint8Array | null; // only on the last chunk
}

export function roomSigMessage(roomId: Uint8Array, epoch: number, senderFp: Uint8Array, kind: number, ts: number, group: number, payload: Uint8Array) {
  return concat(enc.encode("ml-room"), roomId, u32le(epoch), senderFp, Uint8Array.of(kind), u32le(ts), u32le(group), payload);
}

export function sealRoom(roomId: Uint8Array, epoch: number, key: Uint8Array, c: RoomChunk): Uint8Array {
  const sig = c.sig ?? new Uint8Array();
  const payload = pad(c.payload, ROOM_PLAIN - CHUNK_HDR - FP_LEN - sig.length);
  const inner = concat(
    Uint8Array.of(c.kind | PADDED), u32le(c.ts), u32le(c.group), Uint8Array.of(c.idx, c.total), c.senderFp, payload, sig,
  );
  const nonce = nacl.randomBytes(NONCE_LEN);
  const body = concat(roomTag(roomId, epoch), nonce, nacl.secretbox(inner, nonce, key));
  if (body.length > MAX_BODY) throw new Error("room frame too long");
  return body;
}

export function openRoom(key: Uint8Array, body: Uint8Array): RoomChunk | null {
  if (body.length < ROOM_HDR) return null;
  const plain = nacl.secretbox.open(body.subarray(4 + NONCE_LEN), body.subarray(4, 4 + NONCE_LEN), key);
  if (!plain || plain.length < CHUNK_HDR + FP_LEN) return null;
  const idx = plain[9], total = plain[10];
  if (total < 1 || idx >= total) return null;
  const last = idx === total - 1;
  const payloadEnd = last ? plain.length - SIG_LEN : plain.length;
  if (payloadEnd < CHUNK_HDR + FP_LEN) return null;
  let payload: Uint8Array | null = plain.slice(CHUNK_HDR + FP_LEN, payloadEnd);
  if (plain[0] & PADDED) payload = unpad(payload);
  if (!payload) return null;
  return {
    kind: plain[0] & ~PADDED, ts: readU32(plain, 1), group: readU32(plain, 5), idx, total,
    senderFp: plain.slice(CHUNK_HDR, CHUNK_HDR + FP_LEN),
    payload,
    sig: last ? plain.slice(payloadEnd) : null,
  };
}

// ---- Invite codes ----

/** Private room invite, shared as text/QR or inside a DM. */
export interface RoomInvite {
  roomId: Uint8Array; // 16
  key: Uint8Array; // 32
  epoch: number;
  netId: number;
  expires: number; // unix seconds, 0 = never
  name: string;
  creatorFp: Uint8Array; // 8
  // Creator's Ed25519 key (invite v2). Joiners pin it, so another member
  // cannot later claim the creator's fingerprint with their own signing key.
  creatorSignPk: Uint8Array | null;
  inviterSignPk: Uint8Array;
}

export function encodeRoomInvite(i: Omit<RoomInvite, "inviterSignPk">, inviter: Identity): string {
  const n = truncateUtf8(i.name, MAX_NAME);
  const v2 = !!i.creatorSignPk;
  const body = concat(
    Uint8Array.of(v2 ? 2 : 1), i.roomId, i.key, u32le(i.epoch), u32le(i.netId), u32le(i.expires), i.creatorFp,
    v2 ? i.creatorSignPk! : new Uint8Array(), Uint8Array.of(n.length), n, inviter.signPk,
  );
  return "mlr1:" + toB64Url(concat(body, inviter.sign(concat(enc.encode("ml-invite"), body))));
}

export function decodeRoomInvite(code: string, now = Date.now() / 1000): RoomInvite {
  const m = code.trim().match(/^mlr1:([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("Not a MeshLink room invite.");
  const b = fromB64Url(m[1]);
  // ver(1) roomId(16) key(32) epoch(4) netId(4) expires(4) creatorFp(8) [v2: creatorSignPk(32)]
  // nameLen(1) name inviterSignPk(32) sig(64)
  const ver = b[0];
  if (ver !== 1 && ver !== 2) throw new Error("This invite is damaged.");
  const nameAt = ver === 2 ? 101 : 69;
  const nameLen = b[nameAt] ?? 0;
  const end = nameAt + 1 + nameLen + 32;
  if (b.length !== end + SIG_LEN) throw new Error("This invite is damaged.");
  const inviterSignPk = b.slice(end - 32, end);
  if (!verify(concat(enc.encode("ml-invite"), b.subarray(0, end)), b.subarray(end), inviterSignPk)) {
    throw new Error("This invite was changed after it was made.");
  }
  const inv: RoomInvite = {
    roomId: b.slice(1, 17), key: b.slice(17, 49), epoch: readU32(b, 49), netId: readU32(b, 53), expires: readU32(b, 57),
    creatorFp: b.slice(61, 69), creatorSignPk: ver === 2 ? b.slice(69, 101) : null,
    name: dec.decode(b.subarray(nameAt + 1, nameAt + 1 + nameLen)), inviterSignPk,
  };
  if (inv.expires && inv.expires < now) throw new Error("This invite has expired.");
  return inv;
}

/** Network invite: everything a device needs to join a network. */
export interface NetworkInvite {
  netId: number;
  key: Uint8Array; // 16
  channel: number;
  name: string;
  ownerPk: Uint8Array | null;
}

export function encodeNetworkInvite(n: NetworkInvite): string {
  const name = truncateUtf8(n.name, MAX_NAME);
  return "mln1:" + toB64Url(concat(
    Uint8Array.of(1), u32le(n.netId), n.key, Uint8Array.of(n.channel, n.ownerPk ? 1 : 0), n.ownerPk ?? new Uint8Array(),
    Uint8Array.of(name.length), name,
  ));
}

export function decodeNetworkInvite(code: string): NetworkInvite {
  const m = code.trim().match(/^mln1:([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error("Not a MeshLink network code.");
  const b = fromB64Url(m[1]);
  if (b[0] !== 1 || b.length < 24) throw new Error("This network code is damaged.");
  const hasOwner = b[22] === 1;
  let o = 23;
  const ownerPk = hasOwner ? b.slice(o, o + 32) : null;
  if (hasOwner) o += 32;
  const nameLen = b[o];
  if (b.length !== o + 1 + nameLen) throw new Error("This network code is damaged.");
  return { netId: readU32(b, 1), key: b.slice(5, 21), channel: b[21], ownerPk, name: dec.decode(b.subarray(o + 1)) };
}

// ---- POLICY: signed by the network owner, applied by every node ----
// seq(4) count(1) entries[op(1: ban, 2: unban) kind(1) id] sig(64)
// sig = Ed25519(ownerKey, "ml-policy" | netId | everything before sig)

export interface PolicyEntry {
  op: "ban" | "unban";
  kind: BanKind;
  id: Uint8Array; // 8 bytes for guests, 4 for chips and networks
}

export function packPolicy(netId: number, seq: number, entries: PolicyEntry[], ownerSecretKey: Uint8Array): Uint8Array {
  const body = concat(
    u32le(seq), Uint8Array.of(entries.length),
    ...entries.map((e) => concat(Uint8Array.of(e.op === "ban" ? 1 : 2, e.kind), e.id)),
  );
  const sig = nacl.sign.detached(concat(enc.encode("ml-policy"), u32le(netId), body), ownerSecretKey);
  const out = concat(body, sig);
  if (out.length > MAX_BODY) throw new Error("Too many policy entries in one frame.");
  return out;
}

export function unpackPolicy(netId: number, b: Uint8Array, ownerPk: Uint8Array): { seq: number; entries: PolicyEntry[] } | null {
  if (b.length < 5 + SIG_LEN) return null;
  const body = b.subarray(0, b.length - SIG_LEN);
  if (!verify(concat(enc.encode("ml-policy"), u32le(netId), body), b.subarray(body.length), ownerPk)) return null;
  const entries: PolicyEntry[] = [];
  let o = 5;
  for (let i = 0; i < body[4] && o + 2 <= body.length; i++) {
    const kind = body[o + 1] as BanKind;
    const len = kind === 1 ? 8 : 4;
    entries.push({ op: body[o] === 1 ? "ban" : "unban", kind, id: body.slice(o + 2, o + 2 + len) });
    o += 2 + len;
  }
  return { seq: readU32(body, 0), entries };
}
