// Networks. Each network has an id and a 16-byte key that nodes use to tag
// every air frame; nodes of other networks cannot inject or read the tags.
// The creator of a network holds the owner key that signs ban policies.
import nacl from "tweetnacl";
import { fromB64, randomU32, toB64 } from "./bytes";
import type { NetworkInvite } from "./payloads";

export interface Network {
  netId: number;
  name: string;
  key: string; // base64, 16 bytes
  channel: number;
  ownerPk: string | null; // base64 Ed25519
  ownerSecret: string | null; // base64, only on the owner's devices
  policySeq: number;
  bans: { kind: 1 | 2 | 3; id: string; note: string; at: number }[];
  createdAt: number;
}

export const OPEN_NETWORK: Network = {
  netId: 0, name: "Open network", key: toB64(new Uint8Array(16)), channel: 6,
  ownerPk: null, ownerSecret: null, policySeq: 0, bans: [], createdAt: 0,
};

export function createNetwork(name: string, channel = 6): Network {
  const owner = nacl.sign.keyPair();
  return {
    netId: randomU32(), name: name.trim().slice(0, 32) || "My network", key: toB64(nacl.randomBytes(16)), channel,
    ownerPk: toB64(owner.publicKey), ownerSecret: toB64(owner.secretKey), policySeq: 0, bans: [], createdAt: Date.now(),
  };
}

export function networkFromInvite(i: NetworkInvite): Network {
  return {
    netId: i.netId, name: i.name, key: toB64(i.key), channel: i.channel, ownerPk: i.ownerPk ? toB64(i.ownerPk) : null,
    ownerSecret: null, policySeq: 0, bans: [], createdAt: Date.now(),
  };
}

export function inviteOf(n: Network): NetworkInvite {
  return { netId: n.netId, name: n.name, key: fromB64(n.key), channel: n.channel, ownerPk: n.ownerPk ? fromB64(n.ownerPk) : null };
}

export function isOwner(n: Network) {
  return !!n.ownerSecret;
}

export function netIdHex(id: number) {
  return id.toString(16).padStart(8, "0").toUpperCase();
}
