// MeshLink protocol v3: host frames between app and node. See PROTOCOL.md.
// Constants mirror firmware/src/protocol.h. App payloads (what goes inside an
// air frame body) live in payloads.ts.
import { concat, dec, enc, toHex, u32le } from "./bytes";

export const VERSION = 3;
export const MAX_AIR = 250;
export const AIR_HEADER_LEN = 17;
export const TAG_LEN = 8;
export const MAX_BODY = MAX_AIR - AIR_HEADER_LEN - TAG_LEN; // 225

export const AIR_BEACON = 0x01;
export const AIR_DM = 0x02;
export const AIR_ANNOUNCE = 0x03;
export const AIR_ROOM = 0x04;
export const AIR_POLICY = 0x06;

export const FLAG_PRIORITY = 0x01;

// host -> node
export const H_SEND = 0x10;
export const H_INFO_REQ = 0x11;
export const H_CONFIG_GET = 0x12;
export const H_CONFIG_SET = 0x13;
export const H_AUTH = 0x14;
export const H_KICK = 0x15;
export const H_BAN = 0x16;
export const H_UNBAN = 0x17;
export const H_SET_PERM = 0x18;
export const H_SESSIONS_REQ = 0x19;
export const H_STATUS_REQ = 0x1a;
export const H_REBOOT = 0x1b;
export const H_FACTORY_RESET = 0x1c;
export const H_BANS_REQ = 0x1d;
// node -> host
export const H_RECV = 0x20;
export const H_INFO = 0x21;
export const H_LOG = 0x22;
export const H_SENT = 0x23;
export const H_CONFIG = 0x24;
export const H_STATUS = 0x26;
export const H_SESSIONS = 0x28;
export const H_HELLO = 0x29;
export const H_AUTH_OK = 0x2a;
export const H_BANS = 0x2b;
export const H_KICKED = 0x2c;
export const H_ERR = 0x2f;

export const ROLE_ADMIN = 1;
export const ROLE_GUEST = 2;
export type Role = "admin" | "guest";

export const PERM_READ = 0;
export const PERM_DM = 1;
export const PERM_FULL = 2;
export type Perm = 0 | 1 | 2;

export const BAN_GUEST = 1;
export const BAN_CHIP = 2;
export const BAN_NET = 3;
export type BanKind = 1 | 2 | 3;

export const ERR_TEXT: Record<number, string> = {
  1: "Admin only",
  2: "Bad frame",
  3: "Sending too fast",
  4: "Authentication failed",
  5: "Node is full",
  6: "Banned from this node",
};

// ---- Node config (TLV) ----

export interface NodeConfig {
  nodeName: string;
  netName: string;
  netId: number;
  netKey: Uint8Array; // 16 bytes
  channel: number;
  apSsid: string;
  apPsk: string;
  apHidden: boolean;
  apEnabled: boolean;
  apOpen: boolean;
  staSsid: string;
  staPsk: string;
  ownerPk: Uint8Array | null;
  policySeq: number;
  guestPerm: Perm;
  guestMax: number;
  guestRate: number; // frames per minute
  relayForeign: boolean;
  beaconSec: number;
  ttl: number;
  jitterMs: number;
  originRate: number;
  stealth: boolean;
  lanGuests: boolean; // firmware 0.3.2+: accept guests from the home Wi-Fi
}

type Field = { id: number; kind: "str" | "u8" | "bool" | "u32" | "bytes" };
export const CONFIG_FIELDS: Record<keyof NodeConfig, Field> = {
  nodeName: { id: 1, kind: "str" },
  netId: { id: 2, kind: "u32" },
  netKey: { id: 3, kind: "bytes" },
  channel: { id: 4, kind: "u8" },
  apSsid: { id: 5, kind: "str" },
  apPsk: { id: 6, kind: "str" },
  apHidden: { id: 7, kind: "bool" },
  apEnabled: { id: 8, kind: "bool" },
  staSsid: { id: 9, kind: "str" },
  staPsk: { id: 10, kind: "str" },
  ownerPk: { id: 11, kind: "bytes" },
  guestPerm: { id: 12, kind: "u8" },
  guestMax: { id: 13, kind: "u8" },
  guestRate: { id: 14, kind: "u8" },
  relayForeign: { id: 15, kind: "bool" },
  beaconSec: { id: 16, kind: "u8" },
  ttl: { id: 17, kind: "u8" },
  jitterMs: { id: 18, kind: "u8" },
  originRate: { id: 19, kind: "u8" },
  stealth: { id: 20, kind: "bool" },
  netName: { id: 21, kind: "str" },
  policySeq: { id: 22, kind: "u32" },
  apOpen: { id: 23, kind: "bool" },
  lanGuests: { id: 24, kind: "bool" },
};

export function encodeConfig(c: Partial<NodeConfig>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [key, value] of Object.entries(c) as [keyof NodeConfig, unknown][]) {
    const f = CONFIG_FIELDS[key];
    if (!f || value === undefined) continue;
    let v: Uint8Array;
    if (f.kind === "str") v = enc.encode(String(value)).slice(0, 63);
    else if (f.kind === "u8") v = Uint8Array.of(Number(value) & 0xff);
    else if (f.kind === "bool") v = Uint8Array.of(value ? 1 : 0);
    else if (f.kind === "u32") v = u32le(Number(value));
    else v = (value as Uint8Array | null) ?? new Uint8Array();
    parts.push(Uint8Array.of(f.id, v.length), v);
  }
  return concat(...parts);
}

export function decodeConfig(tlv: Uint8Array): Partial<NodeConfig> {
  const byId = new Map(Object.entries(CONFIG_FIELDS).map(([k, f]) => [f.id, { key: k as keyof NodeConfig, ...f }]));
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i + 2 <= tlv.length) {
    const id = tlv[i], len = tlv[i + 1];
    const v = tlv.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    const f = byId.get(id);
    if (!f) continue;
    if (f.kind === "str") out[f.key] = dec.decode(v);
    else if (f.kind === "u8") out[f.key] = v[0] ?? 0;
    else if (f.kind === "bool") out[f.key] = !!v[0];
    else if (f.kind === "u32") out[f.key] = v.length === 4 ? new DataView(v.buffer, v.byteOffset, 4).getUint32(0, true) : 0;
    else out[f.key] = f.key === "ownerPk" && v.length === 0 ? null : v.slice();
  }
  return out as Partial<NodeConfig>;
}

// ---- Events from the node ----

export interface GuestSession {
  pseudo: string; // hex, first 8 bytes of the guest key
  perm: Perm;
  connectedSecs: number;
  tx: number;
  rx: number;
}

export interface NodeStatus {
  uptime: number;
  freeHeap: number;
  rx: number;
  relayed: number;
  dropTag: number;
  dropRate: number;
  guests: number;
  apOn: boolean;
  sta: "off" | "connecting" | "connected";
  staIp: string;
  apIp: string;
  channel: number;
  rssi: number;
}

export interface BanEntry {
  kind: BanKind;
  id: string; // hex
}

export type NodeEvent =
  | {
      kind: "info"; version: number; chipId: number; mac: string; channel: number; fwVersion?: string;
      role?: Role; perm?: Perm; netId?: number; nodeName?: string;
      /** Chip name (firmware 0.5.0+), for example "ESP8266" or "ESP32-C3". Absent on older nodes. */
      chip?: string;
    }
  | { kind: "recv"; airType: number; ttl: number; origin: number; msgId: number; flags: number; body: Uint8Array }
  | { kind: "sent"; msgId: number }
  | { kind: "log"; text: string }
  | { kind: "config"; config: Partial<NodeConfig> }
  | { kind: "status"; status: NodeStatus }
  | { kind: "sessions"; sessions: GuestSession[] }
  | { kind: "bans"; bans: BanEntry[] }
  | { kind: "hello"; nonce: Uint8Array; chipId: number; netId: number; nodeName: string }
  | { kind: "authOk"; role: Role; perm: Perm }
  | { kind: "kicked"; reason: number }
  | { kind: "error"; code: number; text: string };

function ipOf(n: number) {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24].join(".");
}

/** Turn a checked frame from the node into an event, or null. */
export function parseHostFrame(frame: Uint8Array): NodeEvent | null {
  const kind = frame[0];
  const p = frame.subarray(1);
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  switch (kind) {
    case H_RECV:
      if (p.length < 11) return null;
      return {
        kind: "recv", airType: p[0], ttl: p[1], origin: dv.getUint32(2, true), msgId: dv.getUint32(6, true),
        flags: p[10], body: p.slice(11),
      };
    case H_INFO: {
      if (p.length < 12) return null;
      const mac = Array.from(p.subarray(5, 11), (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
      const info: Extract<NodeEvent, { kind: "info" }> = {
        kind: "info", version: p[0], chipId: dv.getUint32(1, true), mac, channel: p[11],
      };
      let i = 12;
      if (p.length > i && p.length >= i + 1 + p[i]) {
        info.fwVersion = dec.decode(p.subarray(i + 1, i + 1 + p[i]));
        i += 1 + p[i];
      }
      // Firmware 0.3.0+: role, permission, network and node name.
      if (p.length >= i + 7) {
        info.role = p[i] === ROLE_ADMIN ? "admin" : "guest";
        info.perm = p[i + 1] as Perm;
        info.netId = dv.getUint32(i + 2, true);
        const n = p[i + 6];
        info.nodeName = dec.decode(p.subarray(i + 7, i + 7 + n));
        i += 7 + n;
        // Firmware 0.5.0+: chip name. Older nodes end the frame here.
        if (p.length > i && p.length >= i + 1 + p[i]) info.chip = dec.decode(p.subarray(i + 1, i + 1 + p[i]));
      }
      return info;
    }
    case H_LOG:
      return { kind: "log", text: dec.decode(p) };
    case H_SENT:
      return p.length >= 4 ? { kind: "sent", msgId: dv.getUint32(0, true) } : null;
    case H_CONFIG:
      return { kind: "config", config: decodeConfig(p) };
    case H_STATUS: {
      if (p.length < 36) return null;
      const u = (o: number) => dv.getUint32(o, true);
      return {
        kind: "status",
        status: {
          uptime: u(0), freeHeap: u(4), rx: u(8), relayed: u(12), dropTag: u(16), dropRate: u(20),
          guests: p[24], apOn: !!p[25], sta: (["off", "connecting", "connected"] as const)[p[26]] ?? "off",
          staIp: ipOf(u(27)), apIp: ipOf(u(31)), channel: p[35], rssi: p.length > 36 ? dv.getInt8(36) : 0,
        },
      };
    }
    case H_SESSIONS: {
      const sessions: GuestSession[] = [];
      for (let i = 0, o = 1; i < (p[0] ?? 0) && o + 17 <= p.length; i++, o += 17) {
        sessions.push({
          pseudo: toHex(p.subarray(o, o + 8)), perm: p[o + 8] as Perm, connectedSecs: dv.getUint32(o + 9, true),
          tx: dv.getUint16(o + 13, true), rx: dv.getUint16(o + 15, true),
        });
      }
      return { kind: "sessions", sessions };
    }
    case H_BANS: {
      const bans: BanEntry[] = [];
      let o = 1;
      for (let i = 0; i < (p[0] ?? 0) && o + 2 <= p.length; i++) {
        const k = p[o] as BanKind, len = p[o + 1];
        bans.push({ kind: k, id: toHex(p.subarray(o + 2, o + 2 + len)) });
        o += 2 + len;
      }
      return { kind: "bans", bans };
    }
    case H_HELLO:
      if (p.length < 25) return null;
      return {
        kind: "hello", nonce: p.slice(0, 16), chipId: dv.getUint32(16, true), netId: dv.getUint32(20, true),
        nodeName: dec.decode(p.subarray(25, 25 + p[24])),
      };
    case H_AUTH_OK:
      return { kind: "authOk", role: p[0] === ROLE_ADMIN ? "admin" : "guest", perm: (p[1] ?? 0) as Perm };
    case H_KICKED:
      return { kind: "kicked", reason: p[0] ?? 0 };
    case H_ERR:
      return { kind: "error", code: p[0] ?? 0, text: dec.decode(p.subarray(1)) };
    default:
      return null;
  }
}

// ---- Frames to the node ----

export function buildSend(airType: number, body: Uint8Array, flags = 0): Uint8Array {
  if (body.length > MAX_BODY) throw new Error(`body ${body.length} bytes, max ${MAX_BODY}`);
  return concat(Uint8Array.of(H_SEND, airType, flags), body);
}

export const buildInfoReq = () => Uint8Array.of(H_INFO_REQ);
export const buildStatusReq = () => Uint8Array.of(H_STATUS_REQ);
export const buildConfigGet = () => Uint8Array.of(H_CONFIG_GET);
export const buildConfigSet = (c: Partial<NodeConfig>) => concat(Uint8Array.of(H_CONFIG_SET), encodeConfig(c));
export const buildSessionsReq = () => Uint8Array.of(H_SESSIONS_REQ);
export const buildBansReq = () => Uint8Array.of(H_BANS_REQ);
export const buildReboot = () => Uint8Array.of(H_REBOOT);
export const buildFactoryReset = () => Uint8Array.of(H_FACTORY_RESET);
export const buildKick = (pseudo: Uint8Array) => concat(Uint8Array.of(H_KICK), pseudo.subarray(0, 8));
export const buildSetPerm = (pseudo: Uint8Array, perm: Perm) => concat(Uint8Array.of(H_SET_PERM), pseudo.subarray(0, 8), Uint8Array.of(perm));
export const buildBan = (kind: BanKind, id: Uint8Array) => concat(Uint8Array.of(H_BAN, kind), id);
export const buildUnban = (kind: BanKind, id: Uint8Array) => concat(Uint8Array.of(H_UNBAN, kind), id);
export const buildAuth = (pk: Uint8Array, sig: Uint8Array) => concat(Uint8Array.of(H_AUTH), pk, sig);

// ---- UTF-8 helpers ----

export function truncateUtf8(text: string, maxBytes: number): Uint8Array {
  return text ? splitUtf8(text, maxBytes)[0] : new Uint8Array();
}

/** Split text into UTF-8 chunks of at most maxBytes, never mid-character. */
export function splitUtf8(text: string, maxBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let cur: Uint8Array[] = [];
  let len = 0;
  for (const ch of text) {
    const e = enc.encode(ch);
    if (len + e.length > maxBytes) {
      chunks.push(concat(...cur));
      cur = [];
      len = 0;
    }
    cur.push(e);
    len += e.length;
  }
  if (len || chunks.length === 0) chunks.push(concat(...cur));
  return chunks;
}
