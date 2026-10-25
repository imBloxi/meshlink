// UDP socket for the home Wi-Fi (LAN) transport. It carries air frames between
// MeshLink apps on one subnet. It does not import Electron, so it runs under
// the unit tests; the IPC wiring is in index.ts.
import { createSocket, type Socket } from "node:dgram";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export const LAN_PORT = 4211;

const toInt = (a: string): number | null => {
  const p = a.split(".");
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return null;
  return ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
};
const toStr = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** RFC1918 only. Mirrors nodeAddress() in the app: we never talk to a public address. */
export function isPrivateV4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (toInt(address) === null) return false;
  const [a, b] = p;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Directed broadcast address of a subnet, or null for a /31 or /32 that has none. */
export function broadcastOf(address: string, netmask: string): string | null {
  const a = toInt(address);
  const m = toInt(netmask);
  if (a === null || m === null) return null;
  const host = ~m >>> 0;
  if (host < 2) return null;
  return toStr(((a & m) | host) >>> 0);
}

// Adapters that are VPNs, virtual switches or containers. A corporate VPN often
// has a 10.x address, and broadcasting there would show MeshLink to that network.
const VIRTUAL = /vpn|\btap\b|tap-|\btun\d*\b|tun\d|wireguard|\bwg\d|tailscale|zerotier|ham?achi|vethernet|hyper-v|wsl|docker|veth|br-|virtual|vmware|vmnet|vbox|bluetooth|loopback|pseudo/i;

/** A subnet we talk on: where to broadcast, and which source addresses belong to it. */
export interface Adapter {
  broadcast: string;
  net: number;
  mask: number;
}

/** One entry per real private subnet. Sending and receiving both use this list. */
export function privateAdapters(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): Adapter[] {
  const out = new Map<string, Adapter>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || !isPrivateV4(i.address)) continue;
      const b = broadcastOf(i.address, i.netmask);
      const a = toInt(i.address);
      const m = toInt(i.netmask);
      if (b && a !== null && m !== null) out.set(b, { broadcast: b, net: (a & m) >>> 0, mask: m });
    }
  }
  return [...out.values()];
}

/** One directed broadcast address per real private adapter. */
export function broadcastTargets(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  return privateAdapters(ifaces).map((a) => a.broadcast);
}

/** True when the address is on the subnet of one of the adapters. */
export function inSubnets(address: string, subnets: Pick<Adapter, "net" | "mask">[]): boolean {
  const a = toInt(address);
  return a !== null && subnets.some((s) => ((a & s.mask) >>> 0) === s.net);
}

export interface UdpLanOptions {
  port?: number;
  /** Where datagrams go. Tests point this at a second socket. */
  sendPort?: number;
  targets?: () => string[];
  /** Subnets whose sources we listen to. Defaults to the real private adapters, the same ones we send on. */
  subnets?: () => Pick<Adapter, "net" | "mask">[];
  /** Overrides the subnet rule. Tests only. */
  accept?: (address: string) => boolean;
  rescanMs?: number;
}

export class UdpLan {
  private sock: Socket | null = null;
  private targets: string[] = [];
  private subnets: Pick<Adapter, "net" | "mask">[] = [];
  private rescan: ReturnType<typeof setInterval> | null = null;
  private readonly port: number;
  private readonly sendPort: number;
  private gen = 0; // bumped by every open() and close(), so an open that lost the race can tell

  constructor(private opts: UdpLanOptions = {}) {
    this.port = opts.port ?? LAN_PORT;
    this.sendPort = opts.sendPort ?? this.port;
  }

  async open(onDatagram: (d: Uint8Array) => void, onClosed: (reason: string) => void): Promise<void> {
    const scan = this.scan();
    if (!scan.targets.length) throw new Error("Connect to your home Wi-Fi or Ethernet first.");
    this.targets = scan.targets;
    this.subnets = scan.subnets;
    const gen = ++this.gen;
    // A source must be on the subnet of a real adapter: not another private subnet, not a VPN.
    const accept = this.opts.accept ?? ((address: string) => inSubnets(address, this.subnets));
    // No reuseAddr: a second copy must fail to bind, not share the port and split the datagrams.
    const sock = createSocket({ type: "udp4" });
    await new Promise<void>((resolve, reject) => {
      const failed = (e: NodeJS.ErrnoException) => {
        sock.close();
        reject(new Error(
          e.code === "EADDRINUSE" ? `Port ${this.port} is in use by another program.`
            // Windows reports a port that another program holds as EACCES, the same code as a firewall block.
            : e.code === "EACCES" ? `Could not listen on port ${this.port}. It is in use by another program (or a second copy of MeshLink), or Windows is blocking MeshLink. Close the other program and allow MeshLink for Private networks in the firewall.`
              : `Could not listen on the home network: ${e.message}`,
        ));
      };
      sock.once("error", failed);
      sock.bind(this.port, "0.0.0.0", () => {
        sock.off("error", failed);
        resolve();
      });
    });
    if (gen !== this.gen) {
      // close() ran while we were binding. Do not install a socket nobody will close.
      sock.close();
      throw new Error("Cancelled.");
    }
    sock.setBroadcast(true);
    sock.on("message", (msg, rinfo) => {
      if (this.sock === sock && accept(rinfo.address)) onDatagram(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    });
    sock.on("error", (e) => this.fail(onClosed, `Network error: ${e.message}`));
    this.sock = sock;
    this.rescan = setInterval(() => {
      const now = this.scan();
      if (!now.targets.length) return this.fail(onClosed, "The home network connection was lost.");
      this.targets = now.targets;
      this.subnets = now.subnets;
    }, this.opts.rescanMs ?? 30_000);
  }

  private scan(): { targets: string[]; subnets: Pick<Adapter, "net" | "mask">[] } {
    const adapters = this.opts.targets && this.opts.subnets ? [] : privateAdapters();
    return {
      targets: this.opts.targets ? this.opts.targets() : adapters.map((a) => a.broadcast),
      subnets: this.opts.subnets ? this.opts.subnets() : this.opts.targets ? [] : adapters,
    };
  }

  send(d: Uint8Array): void {
    const sock = this.sock;
    if (!sock) return;
    for (const t of this.targets) sock.send(d, this.sendPort, t, () => {});
  }

  close(): void {
    this.gen++;
    if (this.rescan) clearInterval(this.rescan);
    this.rescan = null;
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.close();
    } catch {
      /* already closed */
    }
  }

  private fail(onClosed: (reason: string) => void, reason: string) {
    if (!this.sock) return;
    this.close();
    onClosed(reason);
  }
}
