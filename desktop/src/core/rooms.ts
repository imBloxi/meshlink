// Chat rooms. A room is a shared symmetric key; the air only shows a 4-byte
// tag that changes with every key epoch.
//
//   public room   key = BLAKE2b("ml-pub" | netId | name): anyone on the
//                 network who knows the name can read it.
//   private room  random key, shared by invite. Kicking a member rotates the
//                 key (epoch + 1) and sends it by DM to everyone else.
import { blake2b } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import { concat, enc, fromB64, fromHex, toB64, toHex, u32le } from "./bytes";
import { roomTag, type RoomInvite } from "./payloads";

export type RoomKind = "public" | "private";
export type RoomRole = "creator" | "moderator" | "member";

export interface RoomMember {
  fp: string;
  name: string;
  signPk: string; // hex, "" if not yet known
  role: RoomRole;
  lastSeen: number; // ms
  lastCtl?: number; // sender ts (s) of the newest moderation frame applied from this member
  lastCtlGroups?: number[]; // groups applied at lastCtl, so a same-second replay is caught
  muted?: boolean; // hidden locally
}

export interface Room {
  id: string; // hex, 16 bytes
  netId: number;
  kind: RoomKind;
  name: string;
  key: string; // base64, 32 bytes
  epoch: number;
  prevKey?: string; // previous epoch key, readable for a short grace period
  prevKeyUntil?: number; // ms; after this, frames under prevKey are dropped
  kicked?: string[]; // fingerprints removed from the room; their old-key frames are dropped
  creatorFp: string; // "" for public rooms
  creatorSignPk?: string; // hex Ed25519, pinned from the invite (or our own key if we created it)
  members: Record<string, RoomMember>;
  joinedAt: number;
  muted: boolean;
  shareHistory: boolean;
  disappearSecs: number; // 0 = keep
  pinned?: string; // message id
  slowModeSecs: number;
}

export function normalizeRoomName(name: string) {
  return name.trim().replace(/^#/, "").toLowerCase();
}

export function publicRoom(netId: number, name: string): Room {
  const n = normalizeRoomName(name);
  const seed = concat(enc.encode("ml-pub"), u32le(netId), enc.encode(n));
  return {
    id: toHex(blake2b(concat(enc.encode("id"), seed), { dkLen: 16 })),
    netId, kind: "public", name: n,
    key: toB64(blake2b(seed, { dkLen: 32 })),
    epoch: 0, creatorFp: "", members: {}, joinedAt: Date.now(), muted: false, shareHistory: false, disappearSecs: 0, slowModeSecs: 0,
  };
}

export function privateRoom(netId: number, name: string, creatorFp: string, creatorName: string, creatorSignPk: string): Room {
  return {
    id: toHex(nacl.randomBytes(16)), netId, kind: "private", name: name.trim().slice(0, 32),
    key: toB64(nacl.randomBytes(32)), epoch: 0, creatorFp, creatorSignPk,
    members: { [creatorFp]: { fp: creatorFp, name: creatorName, signPk: creatorSignPk, role: "creator", lastSeen: Date.now() } },
    joinedAt: Date.now(), muted: false, shareHistory: true, disappearSecs: 0, slowModeSecs: 0,
  };
}

export function roomFromInvite(inv: RoomInvite): Room {
  const creatorFp = toHex(inv.creatorFp);
  const creatorSignPk = inv.creatorSignPk ? toHex(inv.creatorSignPk) : undefined;
  const members: Record<string, RoomMember> = creatorSignPk
    ? { [creatorFp]: { fp: creatorFp, name: "", signPk: creatorSignPk, role: "creator", lastSeen: 0 } }
    : {};
  return {
    id: toHex(inv.roomId), netId: inv.netId, kind: "private", name: inv.name, key: toB64(inv.key), epoch: inv.epoch,
    creatorFp, creatorSignPk, members, joinedAt: Date.now(), muted: false, shareHistory: true, disappearSecs: 0, slowModeSecs: 0,
  };
}

export function roomKey(r: Room): Uint8Array {
  return fromB64(r.key);
}

export function roomIdBytes(r: Room): Uint8Array {
  return fromHex(r.id);
}

/** Air tags this room currently answers to: current epoch, plus the previous one. */
export function roomTags(r: Room): { tag: string; epoch: number; key: Uint8Array }[] {
  const out = [{ tag: toHex(roomTag(roomIdBytes(r), r.epoch)), epoch: r.epoch, key: roomKey(r) }];
  if (r.prevKey && r.epoch > 0) out.push({ tag: toHex(roomTag(roomIdBytes(r), r.epoch - 1)), epoch: r.epoch - 1, key: fromB64(r.prevKey) });
  return out;
}

export function roleOf(r: Room, fp: string): RoomRole | null {
  if (r.creatorFp && fp === r.creatorFp) return "creator";
  return r.members[fp]?.role ?? null;
}

/** Creator and moderators may moderate. Public rooms have no moderators. */
export function canModerate(r: Room, fp: string): boolean {
  const role = roleOf(r, fp);
  return r.kind === "private" && (role === "creator" || role === "moderator");
}

/** How long frames under the previous key are still accepted after a rotation. */
export const PREV_KEY_GRACE_MS = 10 * 60 * 1000;

export function rotateKey(r: Room, now = Date.now()): Room {
  return { ...r, prevKey: r.key, prevKeyUntil: now + PREV_KEY_GRACE_MS, key: toB64(nacl.randomBytes(32)), epoch: r.epoch + 1 };
}

/** Remember a removed member (bounded), so their frames under the old key are refused. */
export function withKicked(r: Room, fp: string): Room {
  const kicked = [...(r.kicked ?? []).filter((x) => x !== fp), fp].slice(-64);
  return { ...r, kicked };
}
