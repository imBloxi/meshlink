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

/** One directed broadcast address per real private adapter. */
export function broadcastTargets(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const [name, list] of Object.entries(ifaces)) {
    if (VIRTUAL.test(name)) continue;
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal || !isPrivateV4(i.address)) continue;
      const b = broadcastOf(i.address, i.netmask);
      if (b) out.add(b);
    }
  }
  return [...out];
}

export interface UdpLanOptions {
  port?: number;
  /** Where datagrams go. Tests point this at a second socket. */
  sendPort?: number;
  targets?: () => string[];
  /** Which source addresses we listen to. */
  accept?: (address: string) => boolean;
  rescanMs?: number;
}

export class UdpLan {
  private sock: Socket | null = null;
  private targets: string[] = [];
  private rescan: ReturnType<typeof setInterval> | null = null;
  private readonly port: number;
  private readonly sendPort: number;

  constructor(private opts: UdpLanOptions = {}) {
    this.port = opts.port ?? LAN_PORT;
    this.sendPort = opts.sendPort ?? this.port;
  }

  async open(onDatagram: (d: Uint8Array) => void, onClosed: (reason: string) => void): Promise<void> {
    const targets = (this.opts.targets ?? broadcastTargets)();
    if (!targets.length) throw new Error("Connect to your home Wi-Fi or Ethernet first.");
    this.targets = targets;
    const accept = this.opts.accept ?? isPrivateV4;
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    await new Promise<void>((resolve, reject) => {
      sock.once("error", (e: NodeJS.ErrnoException) => {
        sock.close();
        reject(new Error(
          e.code === "EADDRINUSE" ? `Port ${this.port} is in use by another program.`
            : e.code === "EACCES" ? `Windows would not let MeshLink listen on port ${this.port}. Allow it in the firewall for Private networks.`
              : `Could not listen on the home network: ${e.message}`,
        ));
      });
      sock.bind(this.port, "0.0.0.0", resolve);
    });
    sock.setBroadcast(true);
    sock.on("message", (msg, rinfo) => {
      if (this.sock === sock && accept(rinfo.address)) onDatagram(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    });
    sock.on("error", (e) => this.fail(onClosed, `Network error: ${e.message}`));
    this.sock = sock;
    this.rescan = setInterval(() => {
      const now = (this.opts.targets ?? broadcastTargets)();
      if (!now.length) return this.fail(onClosed, "The home network connection was lost.");
      this.targets = now;
    }, this.opts.rescanMs ?? 30_000);
  }

  send(d: Uint8Array): void {
    const sock = this.sock;
    if (!sock) return;
    for (const t of this.targets) sock.send(d, this.sendPort, t, () => {});
  }

  close(): void {
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
