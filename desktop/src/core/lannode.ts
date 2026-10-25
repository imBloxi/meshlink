// A pretend node for the home Wi-Fi (LAN) transport. It speaks host frames to the
// app (info, recv, sent) like SimLink and a real node do, and air frames to the
// LAN through an injected transport. The Electron main process supplies the UDP
// socket; tests supply an in-memory hub.
import { randomU32 } from "./bytes";
import { buildAirFrame, parseAirFrame, type DropReason } from "./lanframe";
import { LanFilter, type FilterVerdict } from "./lanpeer";
import * as p from "./protocol";

export interface LanTransport {
  open(onDatagram: (data: Uint8Array) => void, onClosed: (reason: string) => void): Promise<void>;
  send(data: Uint8Array): void;
  close(): void;
}

export interface LanNetwork {
  netId: number;
  key: Uint8Array; // 16 bytes
}

export interface LanNotice {
  level: "info" | "warning";
  title: string;
  body: string;
}

export interface LanHandlers {
  onEvent(ev: p.NodeEvent): void;
  onClose(reason: string): void;
  onNotice?(notice: LanNotice): void;
}

export interface LanNodeOptions {
  /** No beacons, like a node in stealth mode. */
  stealth?: boolean;
  beaconMs?: number;
  /** Warn when no other MeshLink has been heard after this long. */
  noPeersMs?: number;
  originRate?: number;
}

export type LanDrops = Partial<Record<DropReason | Exclude<FilterVerdict, "ok">, number>>;

export class LanNode {
  /** Random per session, so the LAN cannot follow one PC across restarts. */
  readonly chipId = randomU32();
  readonly drops: LanDrops = {};
  private readonly peers = new Set<number>();
  private readonly filter: LanFilter;
  private handlers: LanHandlers | null = null;
  private beacon: ReturnType<typeof setInterval> | null = null;
  private lonely: ReturnType<typeof setTimeout> | null = null;
  private open_ = false;

  constructor(private transport: LanTransport, private net: LanNetwork, private opts: LanNodeOptions = {}) {
    this.filter = new LanFilter(this.chipId, { originRate: opts.originRate });
  }

  async open(h: LanHandlers): Promise<void> {
    this.handlers = h;
    await this.transport.open((d) => this.receive(d), (reason) => this.lost(reason));
    this.open_ = true;
    this.emitInfo();
    if (!this.opts.stealth) {
      this.sendAir(p.AIR_BEACON, 0, new Uint8Array());
      this.beacon = setInterval(() => this.sendAir(p.AIR_BEACON, 0, new Uint8Array()), this.opts.beaconMs ?? 10_000);
    }
    this.lonely = setTimeout(() => {
      if (this.peers.size) return;
      h.onNotice?.({
        level: "warning",
        title: "No one else on this Wi-Fi yet",
        body: "Nobody running MeshLink on this network answered. Check that they chose the same network, that this is not a guest Wi-Fi or one with client isolation, and that Windows calls it a Private network.",
      });
    }, this.opts.noPeersMs ?? 20_000);
  }

  /** A host frame from the app. Only messaging is accepted: a LAN link has no admin. */
  send(frame: Uint8Array): void {
    if (!this.open_) return;
    if (frame[0] === p.H_INFO_REQ) return this.emitInfo();
    if (frame[0] !== p.H_SEND || frame.length < 3) return;
    if (frame.length - 3 > p.MAX_BODY) {
      this.handlers?.onEvent({ kind: "error", code: 2, text: p.ERR_TEXT[2] ?? "Bad frame" });
      return;
    }
    const msgId = this.sendAir(frame[1], frame[2], frame.subarray(3));
    this.handlers?.onEvent({ kind: "sent", msgId });
  }

  close(): void {
    this.stop();
    this.handlers = null;
    this.transport.close();
  }

  private sendAir(type: number, flags: number, body: Uint8Array): number {
    const msgId = randomU32();
    this.transport.send(buildAirFrame({ type, ttl: 0, msgId, origin: this.chipId, netId: this.net.netId, flags, body }, this.net.key));
    return msgId;
  }

  private receive(data: Uint8Array) {
    if (!this.open_) return;
    // The tag is checked before any state changes, so forged frames cost nothing.
    const r = parseAirFrame(data, this.net.netId, this.net.key);
    if (!r.ok) return this.drop(r.reason);
    const f = r.frame;
    if (f.origin !== this.chipId) this.peers.add(f.origin);
    const verdict = this.filter.check(f);
    if (verdict !== "ok") return this.drop(verdict);
    this.handlers?.onEvent({ kind: "recv", airType: f.type, ttl: f.ttl, origin: f.origin, msgId: f.msgId, flags: f.flags, body: f.body });
  }

  private drop(reason: keyof LanDrops) {
    this.drops[reason] = (this.drops[reason] ?? 0) + 1;
  }

  private emitInfo() {
    const mac = ["4C", "41", ...Array.from({ length: 4 }, (_, i) => ((this.chipId >>> (8 * i)) & 0xff).toString(16).padStart(2, "0").toUpperCase())];
    this.handlers?.onEvent({
      kind: "info", version: p.VERSION, chipId: this.chipId, mac: mac.join(":"), channel: 0, fwVersion: "lan",
      role: "guest", perm: p.PERM_FULL, netId: this.net.netId, nodeName: "Home Wi-Fi",
    });
  }

  private lost(reason: string) {
    const h = this.handlers;
    if (!this.open_ || !h) return;
    this.stop();
    this.handlers = null;
    this.transport.close();
    h.onClose(reason);
  }

  private stop() {
    this.open_ = false;
    if (this.beacon) clearInterval(this.beacon);
    if (this.lonely) clearTimeout(this.lonely);
    this.beacon = this.lonely = null;
  }
}
