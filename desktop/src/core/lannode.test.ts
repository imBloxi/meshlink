import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toHex } from "./bytes";
import type { Contact } from "./contacts";
import { Identity } from "./identity";
import { buildAirFrame } from "./lanframe";
import { LanNode, type LanNotice, type LanTransport } from "./lannode";
import { Messenger, type MessengerOutput } from "./messenger";
import * as p from "./protocol";
import { publicRoom } from "./rooms";

const NET = { netId: 0x5eed0001, key: Uint8Array.from({ length: 16 }, (_, i) => i + 1) };

/** A pretend LAN: every datagram reaches every other transport (and ours too when `echo` is set). */
class Hub {
  ports: HubPort[] = [];
  sent: Uint8Array[] = [];
  constructor(readonly echo = false) {}
  port() {
    const port = new HubPort(this);
    this.ports.push(port);
    return port;
  }
  inject(d: Uint8Array) {
    for (const x of this.ports) if (!x.closed) x.onDatagram?.(d);
  }
}
class HubPort implements LanTransport {
  onDatagram: ((d: Uint8Array) => void) | null = null;
  onClosed: ((reason: string) => void) | null = null;
  closed = false;
  constructor(private hub: Hub) {}
  async open(d: (x: Uint8Array) => void, c: (reason: string) => void) {
    this.onDatagram = d;
    this.onClosed = c;
  }
  send(d: Uint8Array) {
    this.hub.sent.push(d);
    for (const x of this.hub.ports) if ((x !== this || this.hub.echo) && !x.closed) x.onDatagram?.(Uint8Array.from(d));
  }
  close() {
    this.closed = true;
  }
}

interface Peer {
  id: Identity;
  node: LanNode;
  m: Messenger;
  out: MessengerOutput[];
  events: p.NodeEvent[];
  notices: LanNotice[];
  closed: string[];
}

async function peer(hub: Hub, name: string, opts: ConstructorParameters<typeof LanNode>[2] = {}): Promise<Peer> {
  const id = Identity.generate();
  const node = new LanNode(hub.port(), NET, opts);
  const me: Peer = { id, node, out: [], events: [], notices: [], closed: [], m: null as unknown as Messenger };
  me.m = new Messenger(id, new Map<string, Contact>(), name, (f) => node.send(f), NET.netId);
  await node.open({
    onEvent: (ev) => {
      me.events.push(ev);
      me.out.push(...me.m.handle(ev));
    },
    onClose: (r) => me.closed.push(r),
    onNotice: (n) => me.notices.push(n),
  });
  return me;
}

const messages = (x: Peer) => x.out.flatMap((o) => (o.kind === "message" ? [o.message] : []));
const recvs = (x: Peer) => x.events.filter((e) => e.kind === "recv");

describe("LanNode", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reports itself as a guest node on the chosen network", async () => {
    const a = await peer(new Hub(), "alice");
    const info = a.events.find((e) => e.kind === "info");
    expect(info).toMatchObject({ kind: "info", version: p.VERSION, role: "guest", perm: p.PERM_FULL, netId: NET.netId, fwVersion: "lan" });
    a.events.length = 0;
    a.node.send(p.buildInfoReq());
    expect(a.events.map((e) => e.kind)).toEqual(["info"]);
  });

  it("uses a different chip id every session", async () => {
    const hub = new Hub();
    const ids = new Set((await Promise.all([1, 2, 3, 4, 5].map(() => peer(hub, "x")))).map((x) => x.node.chipId));
    expect(ids.size).toBe(5);
  });

  it("carries a DM with its ACK, and a public room message, between two Messengers", async () => {
    const hub = new Hub();
    const a = await peer(hub, "alice");
    const b = await peer(hub, "bob");
    a.m.announce();
    b.m.announce();
    expect([...a.m.contacts.values()].map((c) => c.name)).toEqual(["bob"]);

    const sent = a.m.sendText(a.m.contacts.get(toHex(b.id.fp))!, "hello over the router");
    expect(messages(b).map((m) => m.text)).toEqual(["hello over the router"]);
    expect(a.out).toContainEqual({ kind: "state", id: sent.id, state: "delivered" });

    const room = publicRoom(NET.netId, "kitchen");
    a.m.putRoom(room);
    b.m.putRoom(room);
    a.m.sendRoomText(room, "who has the remote");
    expect(messages(b).map((m) => m.text)).toContain("who has the remote");
  });

  it("puts only tagged air frames with ttl 0 on the wire, and tells the app they were sent", async () => {
    const hub = new Hub();
    const a = await peer(hub, "alice");
    a.events.length = 0;
    hub.sent.length = 0;
    a.node.send(p.buildSend(p.AIR_ANNOUNCE, new Uint8Array(20), p.FLAG_PRIORITY));
    expect(hub.sent).toHaveLength(1);
    const wire = hub.sent[0];
    expect(wire[2]).toBe(p.AIR_ANNOUNCE);
    expect(wire[3]).toBe(0);
    expect(wire[16]).toBe(p.FLAG_PRIORITY);
    expect(wire.length).toBe(p.AIR_HEADER_LEN + 20 + p.TAG_LEN);
    const sentEv = a.events.find((e) => e.kind === "sent");
    expect(sentEv && sentEv.kind === "sent" && sentEv.msgId).toBe(new DataView(wire.buffer, wire.byteOffset).getUint32(4, true));
  });

  it("refuses a body that does not fit, without sending", async () => {
    const hub = new Hub();
    const a = await peer(hub, "alice");
    hub.sent.length = 0;
    a.events.length = 0;
    a.node.send(Uint8Array.of(p.H_SEND, p.AIR_DM, 0, ...new Uint8Array(p.MAX_BODY + 1))); // buildSend would refuse it
    expect(hub.sent).toHaveLength(0);
    expect(a.events).toEqual([{ kind: "error", code: 2, text: expect.any(String) }]);
  });

  it("ignores admin frames: a LAN link is never an admin", async () => {
    const hub = new Hub();
    const a = await peer(hub, "alice");
    hub.sent.length = 0;
    a.events.length = 0;
    a.node.send(new Uint8Array([p.H_CONFIG_SET, 3, 16, ...new Uint8Array(16)]));
    a.node.send(new Uint8Array([p.H_FACTORY_RESET]));
    expect(hub.sent).toHaveLength(0);
    expect(a.events).toEqual([]);
  });

  describe("receiving", () => {
    const frameFor = (over: Partial<Parameters<typeof buildAirFrame>[0]> = {}, key = NET.key) =>
      buildAirFrame({ type: p.AIR_BEACON, ttl: 0, msgId: 1234, origin: 0xfeed, netId: NET.netId, flags: 0, body: new Uint8Array(), ...over }, key);

    it("delivers a good frame once", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      hub.inject(frameFor());
      hub.inject(frameFor());
      expect(recvs(a)).toHaveLength(1);
      expect(recvs(a)[0]).toMatchObject({ airType: p.AIR_BEACON, origin: 0xfeed, msgId: 1234 });
    });

    it("drops another network, a wrong key and tampering", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      hub.inject(frameFor({ netId: 0x99 }));
      hub.inject(frameFor({ msgId: 2 }, new Uint8Array(16)));
      const bad = frameFor({ msgId: 3, body: Uint8Array.of(1, 2, 3) });
      bad[p.AIR_HEADER_LEN] ^= 1;
      hub.inject(bad);
      hub.inject(Uint8Array.of(1, 2, 3));
      expect(recvs(a)).toHaveLength(0);
      expect(a.node.drops).toMatchObject({ foreign: 1, tag: 2, short: 1 });
    });

    it("a forged frame cannot use up a real frame's message id or an origin's budget", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice", { originRate: 2 });
      for (let i = 0; i < 20; i++) hub.inject(frameFor({ msgId: 500 + i }, new Uint8Array(16)));
      hub.inject(frameFor({ msgId: 500 }));
      hub.inject(frameFor({ msgId: 501 }));
      expect(recvs(a).map((e) => e.kind === "recv" && e.msgId)).toEqual([500, 501]);
    });

    it("rate-limits a flooding origin", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice", { originRate: 3 });
      for (let i = 1; i <= 10; i++) hub.inject(frameFor({ msgId: i }));
      expect(recvs(a)).toHaveLength(6); // a burst of two seconds, as on a node
      expect(a.node.drops.rate).toBe(4);
    });

    it("does not hear itself when the socket loops broadcasts back", async () => {
      const hub = new Hub(true);
      const a = await peer(hub, "alice");
      const before = a.node.drops.echo ?? 0;
      a.m.announce();
      expect(a.node.drops.echo).toBe(before + 1); // it was heard, and filtered as our own
      expect(recvs(a).filter((e) => e.kind === "recv" && e.airType === p.AIR_ANNOUNCE)).toHaveLength(0);
    });
  });

  describe("presence", () => {
    it("beacons every 10 seconds, none in stealth mode", async () => {
      const hub = new Hub();
      const loud = await peer(hub, "loud");
      const quiet = await peer(hub, "quiet", { stealth: true });
      const beaconsBy = (x: Peer) => hub.sent.filter((d) => d[2] === p.AIR_BEACON && new DataView(d.buffer, d.byteOffset).getUint32(8, true) === x.node.chipId).length;
      expect(beaconsBy(loud)).toBe(1);
      vi.advanceTimersByTime(30_000);
      expect(beaconsBy(loud)).toBe(4);
      expect(beaconsBy(quiet)).toBe(0);
    });

    it("tells the user when nobody answers, and only once", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      vi.advanceTimersByTime(19_000);
      expect(a.notices).toHaveLength(0);
      vi.advanceTimersByTime(2_000);
      expect(a.notices).toHaveLength(1);
      expect(a.notices[0].level).toBe("warning");
      expect(a.notices[0].body).toMatch(/guest|isolation/i);
      vi.advanceTimersByTime(60_000);
      expect(a.notices).toHaveLength(1);
    });

    it("stays quiet when a neighbour is heard", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      await peer(hub, "bob"); // its first beacon reaches alice
      vi.advanceTimersByTime(25_000);
      expect(a.notices).toHaveLength(0);
    });
  });

  describe("stealth", () => {
    const beaconsBy = (hub: Hub, x: Peer) => hub.sent.filter((d) => d[2] === p.AIR_BEACON && new DataView(d.buffer, d.byteOffset).getUint32(8, true) === x.node.chipId).length;

    it("follows the setting while connected", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      expect(beaconsBy(hub, a)).toBe(1);
      a.node.setStealth(true);
      vi.advanceTimersByTime(60_000);
      expect(beaconsBy(hub, a)).toBe(1); // nothing more
      a.node.setStealth(false);
      expect(beaconsBy(hub, a)).toBe(2); // one at once, so neighbours see us again
      vi.advanceTimersByTime(20_000);
      expect(beaconsBy(hub, a)).toBe(4);
      a.node.setStealth(false); // no second timer
      vi.advanceTimersByTime(10_000);
      expect(beaconsBy(hub, a)).toBe(5);
    });

    it("turning stealth off on a closed node sends nothing", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice", { stealth: true });
      a.node.close();
      a.node.setStealth(false);
      vi.advanceTimersByTime(30_000);
      expect(hub.sent).toHaveLength(0);
    });
  });

  describe("closing while opening", () => {
    const slowTransport = () => {
      const t = {
        sent: [] as Uint8Array[],
        release: () => {},
        fail: (_e: Error) => {},
        open: () => new Promise<void>((res, rej) => { t.release = res; t.fail = rej; }),
        send(d: Uint8Array) { t.sent.push(d); },
        close() {},
      };
      return t;
    };

    it("stays down: no beacons, no info, no warning", async () => {
      const t = slowTransport();
      const node = new LanNode(t, NET);
      const seen: unknown[] = [];
      const opening = node.open({ onEvent: (e) => seen.push(e), onClose: (r) => seen.push(r), onNotice: (n) => seen.push(n) });
      node.close();
      t.release();
      await opening;
      vi.advanceTimersByTime(60_000);
      expect(t.sent).toEqual([]);
      expect(seen).toEqual([]);
    });

    it("does not report a failure to a caller that already gave up", async () => {
      const t = slowTransport();
      const node = new LanNode(t, NET);
      const opening = node.open({ onEvent() {}, onClose() {} });
      node.close();
      t.fail(new Error("Cancelled"));
      await expect(opening).resolves.toBeUndefined();
    });
  });

  describe("closing", () => {
    it("close() stops beacons and does not report a loss", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      a.node.close();
      hub.sent.length = 0;
      vi.advanceTimersByTime(60_000);
      expect(hub.sent).toHaveLength(0);
      expect(a.closed).toEqual([]);
    });

    it("reports a transport that dies, once", async () => {
      const hub = new Hub();
      const a = await peer(hub, "alice");
      hub.ports[0].onClosed?.("No network");
      hub.ports[0].onClosed?.("again");
      expect(a.closed).toEqual(["No network"]);
      hub.sent.length = 0;
      vi.advanceTimersByTime(30_000);
      expect(hub.sent).toHaveLength(0);
    });

    it("fails open() when the transport cannot start", async () => {
      const bad: LanTransport = { open: async () => { throw new Error("Port 4211 is in use."); }, send() {}, close() {} };
      const node = new LanNode(bad, NET);
      await expect(node.open({ onEvent() {}, onClose() {} })).rejects.toThrow("Port 4211 is in use.");
    });
  });
});
