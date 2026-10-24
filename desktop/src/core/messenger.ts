// Chat logic v2, independent of UI, storage and transport so it can be tested.
//
// DMs: hidden recipient (trial decryption), chunked, acknowledged and retried.
// Rooms: shared key, signed messages, moderation by the creator/moderators.
// The messenger never touches the clock or timers itself: callers pass `now`
// and call tick() regularly, which keeps it deterministic in tests.
import { concat, dec, enc, equal, fromHex, randomU32, readU32, toB64, toHex, u32le } from "./bytes";
import { classifyAnnounce, makeContact, type Contact } from "./contacts";
import { fingerprint, formatFp, verify, type Identity } from "./identity";
import * as pl from "./payloads";
import * as p from "./protocol";
import { canModerate, PREV_KEY_GRACE_MS, roleOf, roomFromInvite, roomIdBytes, roomTags, rotateKey, withKicked, type Room } from "./rooms";

export type MessageState = "sending" | "sent" | "delivered" | "failed" | "received";

export interface ChatMessage {
  id: string; // senderFp:group
  conv: string; // "dm:<fp>" or "room:<id>"
  senderFp: string;
  outgoing: boolean;
  text: string;
  ts: number; // unix seconds
  state: MessageState;
  verified?: boolean; // room messages: signature checked against a known key
}

export type MessengerOutput =
  | { kind: "message"; message: ChatMessage }
  | { kind: "state"; id: string; state: MessageState }
  | { kind: "contact"; contact: Contact }
  | { kind: "room"; room: Room }
  | { kind: "roomRemoved"; roomId: string; reason: string }
  | { kind: "roomInvite"; code: string; invite: pl.RoomInvite; fromFp: string }
  | { kind: "networkInvite"; code: string; fromFp: string }
  | { kind: "deleted"; conv: string; id: string }
  | { kind: "notice"; level: "info" | "warning"; text: string }
  | { kind: "neighbor"; origin: number; isNew: boolean };

/** Resend schedule for unacknowledged DMs, in ms after the first send. */
export const RETRY_AT = [2000, 6000];
export const FAIL_AT = 10000;
const REASSEMBLY_MS = 30000;
/** Signed room moderation frames older than this (or this far in the future) are refused. */
export const CONTROL_MAX_AGE_S = 24 * 3600;
const CONTROL_MAX_SKEW_S = 10 * 60;
/** New contacts from announces: at most this many per minute, and this many in total. */
export const NEW_CONTACTS_PER_MIN = 20;
export const MAX_CONTACTS = 1000;
/** A lost ACK is resent at most this many times per message. */
const MAX_REACKS = 3;

interface Pending {
  id: string;
  frames: Uint8Array[];
  sentAt: number;
  attempts: number;
}

interface Partial {
  parts: (Uint8Array | undefined)[];
  first: number;
  sig?: Uint8Array | null;
}

export const dmConv = (fp: string) => `dm:${fp}`;
export const roomConv = (id: string) => `room:${id}`;

export class Messenger {
  readonly neighbors = new Map<number, number>(); // node chip id -> last beacon ms
  readonly rooms = new Map<string, Room>();
  private shared = new Map<string, Uint8Array>(); // contact fp -> box shared key
  private seenNonces = new Set<string>();
  private seenOrder: string[] = [];
  private pending = new Map<string, Pending>(); // DM id -> retry state
  private partial = new Map<string, Partial>();
  private done = new Set<string>(); // reassembled message ids, bounded
  private doneOrder: string[] = [];
  private tagIndex = new Map<string, { roomId: string; epoch: number; key: Uint8Array }>();
  private announceTs = new Map<string, number>(); // contact fp -> newest announce ts
  private newContactTimes: number[] = []; // ms, contacts added in the last minute
  private fullNoticeAt = 0;
  private reAcks = new Map<string, number>(); // message id -> ACKs resent for replays, bounded

  constructor(
    readonly me: Identity,
    readonly contacts: Map<string, Contact>,
    public name: string,
    private sendFrame: (frame: Uint8Array) => void,
    public netId = 0,
  ) {}

  get myFp() {
    return toHex(this.me.fp);
  }

  // ---- Rooms registry ----

  setRooms(rooms: Room[]) {
    this.rooms.clear();
    for (const r of rooms) this.rooms.set(r.id, r);
    this.reindex();
  }

  putRoom(r: Room) {
    this.rooms.set(r.id, r);
    this.reindex();
  }

  removeRoom(id: string) {
    this.rooms.delete(id);
    this.reindex();
  }

  private reindex() {
    this.tagIndex.clear();
    for (const r of this.rooms.values()) {
      if (r.netId !== this.netId) continue;
      for (const t of roomTags(r)) this.tagIndex.set(t.tag, { roomId: r.id, epoch: t.epoch, key: t.key });
    }
  }

  // ---- Outgoing ----

  announce() {
    this.sendFrame(p.buildSend(p.AIR_ANNOUNCE, pl.packAnnounce(this.me, this.name)));
  }

  private sharedKey(c: Contact) {
    let k = this.shared.get(c.fp);
    if (!k) {
      k = this.me.sharedKey(c.pubkey);
      this.shared.set(c.fp, k);
    }
    return k;
  }

  private dmFrames(c: Contact, kind: number, payload: Uint8Array, group: number, ts: number) {
    const parts = chunkBytes(payload, pl.DM_CHUNK_MAX);
    return parts.map((part, idx) =>
      p.buildSend(p.AIR_DM, pl.sealDm(this.sharedKey(c), { kind, ts, group, idx, total: parts.length, payload: part })));
  }

  /** Send a DM of any kind. Text and invites are tracked for delivery. */
  private sendDm(c: Contact, kind: number, payload: Uint8Array, now: number, track: boolean) {
    const group = randomU32();
    const ts = Math.floor(now / 1000);
    const frames = this.dmFrames(c, kind, payload, group, ts);
    // The box key is shared by both sides, so a copy of our own frame played
    // back to us would open as if the contact sent it. Remember our nonces.
    for (const f of frames) this.replay(f.subarray(3, 3 + pl.NONCE_LEN));
    const id = `${this.myFp}:${group.toString(16)}`;
    // Register before sending: on a fast link the ACK can arrive before send() returns.
    if (track) this.pending.set(id, { id, frames, sentAt: now, attempts: 1 });
    frames.forEach((f) => this.sendFrame(f));
    return { id, ts };
  }

  sendText(c: Contact, text: string, now = Date.now()): ChatMessage {
    const { id, ts } = this.sendDm(c, pl.DM_TEXT, enc.encode(text), now, true);
    return { id, conv: dmConv(c.fp), senderFp: this.myFp, outgoing: true, text, ts, state: "sending" };
  }

  /** Retry sending a failed DM (same id, so the receiver deduplicates). */
  retry(id: string, now = Date.now()): boolean {
    const pd = this.pending.get(id);
    if (!pd) return false;
    pd.sentAt = now;
    pd.attempts = 1;
    pd.frames.forEach((f) => this.sendFrame(f));
    return true;
  }

  sendRoomInvite(c: Contact, code: string, now = Date.now()) {
    return this.sendDm(c, pl.DM_ROOM_INVITE, enc.encode(code), now, true);
  }

  sendNetworkInvite(c: Contact, code: string, now = Date.now()) {
    return this.sendDm(c, pl.DM_NET_INVITE, enc.encode(code), now, true);
  }

  /** Resend or fail unacknowledged DMs. Call about twice a second. */
  tick(now = Date.now()): MessengerOutput[] {
    const out: MessengerOutput[] = [];
    for (const pd of this.pending.values()) {
      const age = now - pd.sentAt;
      if (age >= FAIL_AT) {
        this.pending.delete(pd.id);
        out.push({ kind: "state", id: pd.id, state: "failed" });
        // Keep the frames so retry() can resend them.
        this.pending.set(pd.id, { ...pd, sentAt: Number.POSITIVE_INFINITY });
      } else if (pd.attempts <= RETRY_AT.length && age >= RETRY_AT[pd.attempts - 1]) {
        pd.attempts++;
        pd.frames.forEach((f) => this.sendFrame(f));
      }
    }
    for (const [key, part] of this.partial) if (now - part.first > REASSEMBLY_MS) this.partial.delete(key);
    return out;
  }

  // Room sending

  private roomFrames(r: Room, kind: number, payload: Uint8Array, now: number) {
    const group = randomU32();
    const ts = Math.floor(now / 1000);
    const idBytes = roomIdBytes(r);
    const sig = this.me.sign(pl.roomSigMessage(idBytes, r.epoch, this.me.fp, kind, ts, group, payload));
    // The last chunk also carries the 64-byte signature.
    const parts = chunkBytes(payload, pl.ROOM_CHUNK_MAX, pl.ROOM_LAST_CHUNK_MAX);
    const key = roomTags(r)[0].key;
    const frames = parts.map((part, idx) => {
      const last = idx === parts.length - 1;
      const body = pl.sealRoom(idBytes, r.epoch, key, {
        kind, ts, group, idx, total: parts.length, payload: part, senderFp: this.me.fp, sig: last ? sig : null,
      });
      return p.buildSend(p.AIR_ROOM, body);
    });
    frames.forEach((f) => this.sendFrame(f));
    return { id: `${this.myFp}:${group.toString(16)}`, ts };
  }

  sendRoomText(r: Room, text: string, now = Date.now()): ChatMessage {
    const { id, ts } = this.roomFrames(r, pl.ROOM_TEXT, enc.encode(text), now);
    return { id, conv: roomConv(r.id), senderFp: this.myFp, outgoing: true, text, ts, state: "sending", verified: true };
  }

  /** Say hello in a room so members learn our keys and name. */
  joinRoom(r: Room, now = Date.now()) {
    this.roomFrames(r, pl.ROOM_JOIN, concat(this.me.signPk, this.me.pubkey, enc.encode(this.name)), now);
  }

  leaveRoom(r: Room, now = Date.now()) {
    this.roomFrames(r, pl.ROOM_LEAVE, new Uint8Array(), now);
  }

  deleteRoomMessage(r: Room, messageId: string, now = Date.now()) {
    const [fp, g] = messageId.split(":");
    this.roomFrames(r, pl.ROOM_DELETE, concat(fromHex(fp), u32le(parseInt(g, 16))), now);
  }

  setModerator(r: Room, fp: string, on: boolean, now = Date.now()) {
    this.roomFrames(r, pl.ROOM_MOD, concat(fromHex(fp), Uint8Array.of(on ? 1 : 0)), now);
  }

  /**
   * Remove a member: announce the kick under the old key, rotate the key and
   * send the new one by DM to every remaining member we can reach.
   * Returns the updated room and the members who could not be reached.
   */
  kickFromRoom(r: Room, fp: string, now = Date.now()): { room: Room; unreachable: string[] } {
    this.roomFrames(r, pl.ROOM_KICK, fromHex(fp), now);
    const members = { ...r.members };
    delete members[fp];
    const next = withKicked({ ...rotateKey(r, now), members }, fp);
    this.putRoom(next);
    const unreachable: string[] = [];
    const payload = concat(roomIdBytes(next), u32le(next.epoch), roomTags(next)[0].key);
    for (const m of Object.values(members)) {
      if (m.fp === this.myFp) continue;
      const c = this.contacts.get(m.fp);
      if (!c) {
        unreachable.push(m.name || m.fp);
        continue;
      }
      this.sendDm(c, pl.DM_ROOM_KEY, payload, now, false);
    }
    return { room: next, unreachable };
  }

  // ---- Incoming ----

  handle(ev: p.NodeEvent, now = Date.now()): MessengerOutput[] {
    if (ev.kind !== "recv") return [];
    switch (ev.airType) {
      case p.AIR_BEACON: {
        const isNew = !this.neighbors.has(ev.origin);
        this.neighbors.set(ev.origin, now);
        return [{ kind: "neighbor", origin: ev.origin, isNew }];
      }
      case p.AIR_ANNOUNCE:
        return this.onAnnounce(ev.body, now);
      case p.AIR_DM:
        return this.onDm(ev.body, now);
      case p.AIR_ROOM:
        return this.onRoom(ev.body, now);
      default:
        return [];
    }
  }

  private replay(nonce: Uint8Array): boolean {
    const h = toHex(nonce);
    if (this.seenNonces.has(h)) return true;
    this.seenNonces.add(h);
    this.seenOrder.push(h);
    if (this.seenOrder.length > 2048) this.seenNonces.delete(this.seenOrder.shift()!);
    return false;
  }

  private markDone(id: string): boolean {
    if (this.done.has(id)) return false;
    this.done.add(id);
    this.doneOrder.push(id);
    if (this.doneOrder.length > 1024) this.done.delete(this.doneOrder.shift()!);
    return true;
  }

  /** Collect chunks. Returns the full payload once all parts arrived. */
  private assemble(key: string, c: pl.Chunk, now: number, sig?: Uint8Array | null): { payload: Uint8Array; sig?: Uint8Array | null } | null {
    if (c.total === 1) return { payload: c.payload, sig };
    let part = this.partial.get(key);
    if (!part) {
      part = { parts: Array.from({ length: c.total }, () => undefined), first: now }; // not sparse: some() skips holes
      this.partial.set(key, part);
    }
    if (part.parts.length !== c.total) return null;
    part.parts[c.idx] = c.payload;
    if (sig) part.sig = sig;
    if (part.parts.some((x) => !x)) return null;
    this.partial.delete(key);
    return { payload: concat(...(part.parts as Uint8Array[])), sig: part.sig };
  }

  private onAnnounce(body: Uint8Array, now: number): MessengerOutput[] {
    const a = pl.unpackAnnounce(body);
    if (!a || equal(a.pubkey, this.me.pubkey)) return [];
    const verdict = classifyAnnounce(this.contacts, a.pubkey, a.name);
    const fp = makeContact(a.pubkey, a.name).fp;
    if (verdict === "impostor") {
      return [{
        kind: "notice", level: "warning",
        text: `Unknown key ${formatFp(fromHex(fp))} claims the name "${a.name}". Ignored.`,
      }];
    }
    if (verdict === "new") {
      // Anyone in range can mint keys for free. Bound how fast and how far the
      // contact list grows: every DM is trial-decrypted against all of it.
      this.newContactTimes = this.newContactTimes.filter((t) => now - t < 60_000);
      if (this.contacts.size >= MAX_CONTACTS || this.newContactTimes.length >= NEW_CONTACTS_PER_MIN) {
        if (now - this.fullNoticeAt < 60_000) return [];
        this.fullNoticeAt = now;
        return [{ kind: "notice", level: "warning", text: "Many new keys are announcing nearby. New contacts are paused for now." }];
      }
      this.newContactTimes.push(now);
      const c = makeContact(a.pubkey, a.name, now, a.signPk);
      this.contacts.set(c.fp, c);
      this.announceTs.set(c.fp, a.ts);
      return [
        { kind: "contact", contact: c },
        { kind: "notice", level: "info", text: `New contact "${c.name}". Verify their key in person.` },
      ];
    }
    const c = this.contacts.get(fp)!;
    // The box key is public, so anyone can announce it with their own signing
    // key. Once a signing key is pinned, ignore announces signed by another.
    if (c.signPk && !equal(c.signPk, a.signPk)) {
      return [{
        kind: "notice", level: "warning",
        text: `Someone announced "${c.name}"'s key with a different signing key. Ignored.`,
      }];
    }
    // Replayed old announces must not roll back the name.
    if (a.ts < (this.announceTs.get(fp) ?? 0)) return [];
    this.announceTs.set(fp, a.ts);
    c.lastSeen = now;
    c.name = a.name || c.name;
    c.signPk ??= a.signPk;
    return [{ kind: "contact", contact: c }];
  }

  private onDm(body: Uint8Array, now: number): MessengerOutput[] {
    // Hidden recipient: try every contact's shared key. Not ours = silence.
    let from: Contact | null = null;
    let chunk: pl.Chunk | null = null;
    for (const c of this.contacts.values()) {
      chunk = pl.openDm(this.sharedKey(c), body);
      if (chunk) {
        from = c;
        break;
      }
    }
    if (!from || !chunk) return [];
    if (this.replay(pl.dmNonce(body))) {
      // A retry repeats the same frames. If we already have that message, our
      // ACK was lost: send it again, otherwise the sender marks it failed.
      // Bounded: a replayed frame must not make us transmit without limit.
      const doneId = `${from.fp}:${chunk.group.toString(16)}`;
      const sent = this.reAcks.get(doneId) ?? 0;
      if (chunk.kind !== pl.DM_ACK && chunk.idx === chunk.total - 1 && this.done.has(doneId) && sent < MAX_REACKS) {
        this.reAcks.delete(doneId);
        this.reAcks.set(doneId, sent + 1);
        if (this.reAcks.size > 1024) this.reAcks.delete(this.reAcks.keys().next().value!);
        this.sendDm(from, pl.DM_ACK, u32le(chunk.group), now, false);
      }
      return [];
    }
    from.lastSeen = now;
    const out: MessengerOutput[] = [{ kind: "contact", contact: from }];

    if (chunk.kind === pl.DM_ACK) {
      const id = `${this.myFp}:${readU32(chunk.payload, 0).toString(16)}`;
      if (this.pending.delete(id)) out.push({ kind: "state", id, state: "delivered" });
      return out;
    }
    const id = `${from.fp}:${chunk.group.toString(16)}`;
    const full = this.assemble(`dm|${id}`, chunk, now);
    if (!full) return out;
    // Acknowledge every complete copy, even repeats: our last ACK may have been lost.
    this.sendDm(from, pl.DM_ACK, u32le(chunk.group), now, false);
    if (!this.markDone(id)) return out;

    const text = dec.decode(full.payload);
    switch (chunk.kind) {
      case pl.DM_TEXT:
        out.push({
          kind: "message",
          message: { id, conv: dmConv(from.fp), senderFp: from.fp, outgoing: false, text, ts: chunk.ts, state: "received" },
        });
        break;
      case pl.DM_ROOM_INVITE:
        try {
          out.push({ kind: "roomInvite", code: text, invite: pl.decodeRoomInvite(text), fromFp: from.fp });
        } catch (e) {
          out.push({ kind: "notice", level: "warning", text: `Bad room invite from ${from.name}: ${(e as Error).message}` });
        }
        break;
      case pl.DM_NET_INVITE:
        out.push({ kind: "networkInvite", code: text, fromFp: from.fp });
        break;
      case pl.DM_ROOM_KEY:
        out.push(...this.onRoomKey(from, full.payload, now));
        break;
    }
    return out;
  }

  /** New key after a kick. Accept it only from the room's creator or a moderator. */
  private onRoomKey(from: Contact, b: Uint8Array, now: number): MessengerOutput[] {
    if (b.length !== 52) return [];
    const r = this.rooms.get(toHex(b.subarray(0, 16)));
    const epoch = readU32(b, 16);
    if (!r || epoch <= r.epoch || !canModerate(r, from.fp)) return [];
    const next: Room = { ...r, prevKey: r.key, prevKeyUntil: now + PREV_KEY_GRACE_MS, key: toB64(b.subarray(20)), epoch };
    this.putRoom(next);
    return [{ kind: "room", room: next }, { kind: "notice", level: "info", text: `Room "${r.name}" has a new key.` }];
  }

  private onRoom(body: Uint8Array, now: number): MessengerOutput[] {
    const t = this.tagIndex.get(toHex(body.subarray(0, 4)));
    if (!t) return []; // Not a room we are in.
    const r = this.rooms.get(t.roomId)!;
    const c = pl.openRoom(t.key, body);
    if (!c || this.replay(body.subarray(4, 28))) return [];
    const senderFp = toHex(c.senderFp);
    if (senderFp === this.myFp) return [];
    // The previous key is only good for a short grace period after a
    // rotation, and never for members who were removed: they still hold it.
    if (t.epoch !== r.epoch && (!r.prevKeyUntil || now > r.prevKeyUntil || r.kicked?.includes(senderFp))) return [];
    const id = `${senderFp}:${c.group.toString(16)}`;
    const full = this.assemble(`room|${id}`, c, now, c.sig);
    if (!full || !this.markDone(id)) return [];

    // Who signed it? The creator's key is pinned from the invite (a contact's
    // announced key wins). Others: a contact's or room member's key.
    const contactPk = this.contacts.get(senderFp)?.signPk;
    const isCreator = !!r.creatorFp && senderFp === r.creatorFp;
    let signPkHex = contactPk ? toHex(contactPk)
      : isCreator ? (r.creatorSignPk || "")
      : (r.members[senderFp]?.signPk || "");
    // A JOIN may introduce a new member's key, but only for the fingerprint
    // of the box key it carries, and never for the creator: otherwise any
    // key holder could claim someone else's identity in the room.
    if (!signPkHex && !isCreator && c.kind === pl.ROOM_JOIN && full.payload.length >= 64
      && toHex(fingerprint(full.payload.subarray(32, 64))) === senderFp) {
      signPkHex = toHex(full.payload.subarray(0, 32));
    }
    const msg = pl.roomSigMessage(fromHex(r.id), t.epoch, c.senderFp, c.kind, c.ts, c.group, full.payload);
    const verified = !!signPkHex && !!full.sig && verify(msg, full.sig, fromHex(signPkHex));
    if (signPkHex && !verified) {
      return [{ kind: "notice", level: "warning", text: `A message in "${r.name}" had a bad signature. Dropped.` }];
    }

    // Moderation frames are signed but carry no sequence number, and our
    // dedupe memory is lost on restart. Refuse stale ones and anything not
    // newer than the last one applied from this sender (kept in the room record).
    const isControl = c.kind === pl.ROOM_MOD || c.kind === pl.ROOM_KICK || c.kind === pl.ROOM_DELETE || c.kind === pl.ROOM_LEAVE;
    const prevMember = r.members[senderFp];
    if (isControl && verified) {
      const nowS = Math.floor(now / 1000);
      if (c.ts < nowS - CONTROL_MAX_AGE_S || c.ts > nowS + CONTROL_MAX_SKEW_S) return [];
      const last = prevMember?.lastCtl ?? 0;
      if (c.ts < last || (c.ts === last && prevMember?.lastCtlGroups?.includes(c.group))) return [];
    }

    let room = r;
    const members = { ...r.members };
    const member = members[senderFp] ?? { fp: senderFp, name: this.contacts.get(senderFp)?.name ?? "", signPk: signPkHex, role: senderFp === r.creatorFp ? "creator" : "member", lastSeen: now };
    members[senderFp] = { ...member, signPk: member.signPk || signPkHex, lastSeen: now };
    if (isControl && verified) {
      const same = member.lastCtl === c.ts ? (member.lastCtlGroups ?? []) : [];
      members[senderFp].lastCtl = c.ts;
      members[senderFp].lastCtlGroups = [...same, c.group].slice(-8);
    }
    const out: MessengerOutput[] = [];
    const conv = roomConv(r.id);

    switch (c.kind) {
      case pl.ROOM_TEXT:
        if (member.muted) break;
        out.push({
          kind: "message",
          message: { id, conv, senderFp, outgoing: false, text: dec.decode(full.payload), ts: c.ts, state: "received", verified },
        });
        break;
      case pl.ROOM_JOIN:
        if (verified && full.payload.length >= 64) {
          members[senderFp].name = dec.decode(full.payload.subarray(64)).slice(0, 32);
          out.push({ kind: "notice", level: "info", text: `${members[senderFp].name || "Someone"} joined "${r.name}".` });
        }
        break;
      case pl.ROOM_LEAVE:
        if (verified && !isCreator) delete members[senderFp];
        break;
      case pl.ROOM_MOD:
        if (verified && senderFp === r.creatorFp && full.payload.length === 9) {
          const target = toHex(full.payload.subarray(0, 8));
          const m = members[target] ?? { fp: target, name: "", signPk: "", role: "member", lastSeen: 0 };
          members[target] = { ...m, role: full.payload[8] ? "moderator" : "member" };
        }
        break;
      case pl.ROOM_DELETE:
        if (verified && full.payload.length === 12) {
          const author = toHex(full.payload.subarray(0, 8));
          if (author === senderFp || canModerate(r, senderFp)) {
            out.push({ kind: "deleted", conv, id: `${author}:${readU32(full.payload, 8).toString(16)}` });
          }
        }
        break;
      case pl.ROOM_KICK:
        if (verified && canModerate(r, senderFp) && full.payload.length === 8) {
          const target = toHex(full.payload);
          if (target === this.myFp) {
            this.removeRoom(r.id);
            return [{ kind: "roomRemoved", roomId: r.id, reason: `You were removed from "${r.name}".` }];
          }
          delete members[target];
          room = withKicked(room, target);
        }
        break;
    }
    const next = { ...room, members };
    this.rooms.set(r.id, next);
    out.unshift({ kind: "room", room: next });
    return out;
  }

  /** Join a private room from an invite and say hello. */
  acceptInvite(inv: pl.RoomInvite, now = Date.now()): Room {
    const r = roomFromInvite(inv);
    const existing = this.rooms.get(r.id);
    const room = existing && existing.epoch >= r.epoch
      ? { ...existing, creatorSignPk: existing.creatorSignPk || r.creatorSignPk }
      : { ...r, members: { ...(existing?.members ?? {}), ...r.members } };
    this.putRoom(room);
    this.joinRoom(room, now);
    return room;
  }

  isRoomModerator(r: Room) {
    return canModerate(r, this.myFp);
  }

  roleIn(r: Room) {
    return roleOf(r, this.myFp);
  }
}

/** Split bytes into chunks; the last chunk may have a smaller limit. */
export function chunkBytes(b: Uint8Array, max: number, lastMax = max): Uint8Array[] {
  const out: Uint8Array[] = [];
  let o = 0;
  while (b.length - o > lastMax) {
    const take = Math.min(max, b.length - o);
    // Never split a UTF-8 character: back up to a lead byte.
    let end = o + take;
    while (end < b.length && end > o && (b[end] & 0xc0) === 0x80) end--;
    if (end === o) end = o + take; // binary data, not text
    out.push(b.slice(o, end));
    o = end;
  }
  out.push(b.slice(o));
  if (out.length > 255) throw new Error("Message too long");
  return out;
}
