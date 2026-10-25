// Air frames for the home Wi-Fi (LAN) transport. The format is the ESP-NOW air
// frame of PROTOCOL.md section 1, so a node could bridge it without translating.
// The tag mirrors computeTag() in firmware/src/main.cpp.
import { blake2s } from "@noble/hashes/blake2.js";
import nacl from "tweetnacl";
import { concat, readU32, u32le } from "./bytes";
import { AIR_HEADER_LEN, MAX_AIR, MAX_BODY, TAG_LEN, VERSION } from "./protocol";

const MAGIC = 0x4d;
const TTL_AT = 3;

export interface AirFrame {
  type: number;
  ttl: number;
  msgId: number;
  origin: number;
  netId: number;
  flags: number;
  body: Uint8Array;
}

export type DropReason = "short" | "long" | "magic" | "version" | "msgid" | "foreign" | "tag";
export type ParsedAir = { ok: true; frame: AirFrame } | { ok: false; reason: DropReason };

/** BLAKE2s with an 8-byte output (the length is part of the hash, not a truncation), TTL zeroed. */
function tagOf(netKey: Uint8Array, frameNoTag: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(frameNoTag);
  copy[TTL_AT] = 0;
  return blake2s(copy, { key: netKey, dkLen: TAG_LEN });
}

/** A datagram for the LAN: header, body and tag. The TTL is sent as 0; nothing relays on a LAN. */
export function buildAirFrame(f: AirFrame, netKey: Uint8Array): Uint8Array {
  if (f.body.length > MAX_BODY) throw new Error(`Frame body is ${f.body.length} bytes; the limit is ${MAX_BODY}.`);
  const header = concat(
    Uint8Array.of(MAGIC, VERSION, f.type, 0),
    u32le(f.msgId), u32le(f.origin), u32le(f.netId),
    Uint8Array.of(f.flags),
  );
  const noTag = concat(header, f.body);
  return concat(noTag, tagOf(netKey, noTag));
}

/**
 * Check a received datagram in the order a node does: size, magic, version, then
 * the network, and only then the tag. The caller must not touch any state for a
 * frame that is not `ok`, so a forged frame cannot use up a duplicate or rate budget.
 */
export function parseAirFrame(data: Uint8Array, netId: number, netKey: Uint8Array): ParsedAir {
  if (data.length < AIR_HEADER_LEN + TAG_LEN) return { ok: false, reason: "short" };
  if (data.length > MAX_AIR) return { ok: false, reason: "long" };
  if (data[0] !== MAGIC) return { ok: false, reason: "magic" };
  if (data[1] !== VERSION) return { ok: false, reason: "version" };
  const msgId = readU32(data, 4);
  if (msgId === 0) return { ok: false, reason: "msgid" };
  if (readU32(data, 12) !== netId) return { ok: false, reason: "foreign" };
  const noTag = data.subarray(0, data.length - TAG_LEN);
  if (!nacl.verify(tagOf(netKey, noTag), data.subarray(data.length - TAG_LEN))) return { ok: false, reason: "tag" };
  return {
    ok: true,
    frame: {
      type: data[2], ttl: data[TTL_AT], msgId, origin: readU32(data, 8), netId, flags: data[16],
      body: Uint8Array.from(noTag.subarray(AIR_HEADER_LEN)),
    },
  };
}
