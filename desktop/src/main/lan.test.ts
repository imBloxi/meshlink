import { createSocket } from "node:dgram";
import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { broadcastTargets, broadcastOf, isPrivateV4, UdpLan } from "./lan";

const v4 = (address: string, netmask: string, internal = false): NetworkInterfaceInfo =>
  ({ address, netmask, family: "IPv4", internal, mac: "", cidr: null }) as NetworkInterfaceInfo;

describe("addresses", () => {
  it("knows private IPv4 ranges", () => {
    for (const a of ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20"]) expect(isPrivateV4(a)).toBe(true);
    for (const a of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "169.254.1.1", "127.0.0.1", "192.169.0.1", "::1", "nonsense"]) expect(isPrivateV4(a)).toBe(false);
  });

  it("computes the directed broadcast address", () => {
    expect(broadcastOf("192.168.1.23", "255.255.255.0")).toBe("192.168.1.255");
    expect(broadcastOf("10.1.2.3", "255.255.0.0")).toBe("10.1.255.255");
    expect(broadcastOf("172.16.5.9", "255.255.252.0")).toBe("172.16.7.255");
    expect(broadcastOf("192.168.1.2", "255.255.255.255")).toBeNull();
    expect(broadcastOf("192.168.1.2", "255.255.255.254")).toBeNull();
  });

  it("picks one broadcast address per real private adapter", () => {
    const ifaces = {
      "Wi-Fi": [v4("192.168.1.23", "255.255.255.0"), { ...v4("fe80::1", ""), family: "IPv6" } as unknown as NetworkInterfaceInfo],
      Ethernet: [v4("192.168.1.40", "255.255.255.0")], // same subnet: one target
      Loopback: [v4("127.0.0.1", "255.0.0.0", true)],
      "Public Wi-Fi": [v4("8.8.4.4", "255.255.255.0")],
      "Link local": [v4("169.254.3.4", "255.255.0.0")],
    };
    expect(broadcastTargets(ifaces)).toEqual(["192.168.1.255"]);
  });

  it("skips VPN, virtual and container adapters so presence does not leak into them", () => {
    const ifaces = {
      "Wi-Fi": [v4("192.168.0.10", "255.255.255.0")],
      "Corp VPN": [v4("10.8.0.2", "255.255.255.0")],
      "TAP-Windows Adapter V9": [v4("10.9.0.2", "255.255.255.0")],
      "vEthernet (WSL)": [v4("172.20.0.1", "255.255.240.0")],
      "vEthernet (Default Switch)": [v4("172.21.0.1", "255.255.240.0")],
      docker0: [v4("172.17.0.1", "255.255.0.0")],
      tailscale0: [v4("10.100.0.3", "255.255.255.0")],
      wg0: [v4("10.7.0.2", "255.255.255.0")],
      "VMware Network Adapter VMnet8": [v4("192.168.40.1", "255.255.255.0")],
      "VirtualBox Host-Only": [v4("192.168.56.1", "255.255.255.0")],
    };
    expect(broadcastTargets(ifaces)).toEqual(["192.168.0.255"]);
  });
});

// Two sockets on loopback standing in for two PCs: each sends to the other's port.
const PORT_A = 47311;
const PORT_B = 47312;
const open: UdpLan[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
const lan = (port: number, sendPort: number, over: Partial<ConstructorParameters<typeof UdpLan>[0]> = {}) => {
  const l = new UdpLan({ port, sendPort, targets: () => ["127.0.0.1"], accept: () => true, ...over });
  open.push(l);
  return l;
};
const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return ok();
};

describe("UdpLan", () => {
  it("delivers a datagram from one socket to the other", async () => {
    const got: number[][] = [];
    const a = lan(PORT_A, PORT_B);
    const b = lan(PORT_B, PORT_A);
    await a.open(() => {}, () => {});
    await b.open((d) => got.push([...d]), () => {});
    a.send(Uint8Array.of(1, 2, 3));
    expect(await until(() => got.length === 1)).toBe(true);
    expect(got[0]).toEqual([1, 2, 3]);
  });

  it("drops datagrams from addresses that are not accepted", async () => {
    const got: number[] = [];
    const a = lan(PORT_A, PORT_B);
    const b = lan(PORT_B, PORT_A, { accept: () => false });
    await a.open(() => {}, () => {});
    await b.open((d) => got.push(d.length), () => {});
    a.send(Uint8Array.of(9));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);
  });

  it("only accepts private source addresses by default", async () => {
    const got: number[] = [];
    const a = lan(PORT_A, PORT_B);
    const b = new UdpLan({ port: PORT_B, sendPort: PORT_A, targets: () => ["127.0.0.1"] }); // loopback is not RFC1918
    open.push(b);
    await a.open(() => {}, () => {});
    await b.open((d) => got.push(d.length), () => {});
    a.send(Uint8Array.of(9));
    await new Promise((r) => setTimeout(r, 150));
    expect(got).toEqual([]);
  });

  it("refuses to open with no home network", async () => {
    const a = lan(PORT_A, PORT_B, { targets: () => [] });
    await expect(a.open(() => {}, () => {})).rejects.toThrow(/home Wi-Fi or Ethernet/);
  });

  it("explains a port that is already taken", async () => {
    const blocker = createSocket("udp4");
    await new Promise<void>((r) => blocker.bind(PORT_A, "0.0.0.0", r));
    try {
      await expect(lan(PORT_A, PORT_B).open(() => {}, () => {})).rejects.toThrow(/port 47311.*in use/i); // EADDRINUSE on Linux, EACCES on Windows
    } finally {
      blocker.close();
    }
  });

  it("does not share its port with a second copy", async () => {
    await lan(PORT_A, PORT_B).open(() => {}, () => {});
    await expect(lan(PORT_A, PORT_B).open(() => {}, () => {})).rejects.toThrow(/port 47311/i);
  });

  it("leaves nothing listening when close() lands while it is still binding", async () => {
    const a = lan(PORT_A, PORT_B);
    const opening = a.open(() => {}, () => {});
    a.close(); // a reload or window close at this moment
    await expect(opening).rejects.toThrow(/cancel/i);
    const probe = createSocket("udp4");
    await new Promise<void>((res, rej) => { probe.once("error", rej); probe.bind(PORT_A, "0.0.0.0", res); });
    probe.close();
  });

  it("closes with a reason when the last adapter goes away", async () => {
    let up = true;
    const reasons: string[] = [];
    const a = lan(PORT_A, PORT_B, { targets: () => (up ? ["127.0.0.1"] : []), rescanMs: 20 });
    await a.open(() => {}, (r) => reasons.push(r));
    up = false;
    expect(await until(() => reasons.length === 1)).toBe(true);
    expect(reasons[0]).toMatch(/network/i);
  });

  it("follows the adapters when the laptop changes network", async () => {
    let target = "192.0.2.1"; // TEST-NET: goes nowhere
    const got: number[] = [];
    const a = lan(PORT_A, PORT_B, { targets: () => [target], rescanMs: 20 });
    const b = lan(PORT_B, PORT_A);
    await a.open(() => {}, () => {});
    await b.open((d) => got.push(d.length), () => {});
    a.send(Uint8Array.of(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([]);
    target = "127.0.0.1"; // the laptop joined another network
    await new Promise((r) => setTimeout(r, 60)); // a rescan happens
    a.send(Uint8Array.of(4, 4));
    expect(await until(() => got.length === 1)).toBe(true);
    expect(got).toEqual([2]);
  });

  it("stays silent after close()", async () => {
    const got: number[] = [];
    const reasons: string[] = [];
    const a = lan(PORT_A, PORT_B);
    const b = lan(PORT_B, PORT_A);
    await a.open(() => {}, (r) => reasons.push(r));
    await b.open((d) => got.push(d.length), () => {});
    a.close();
    a.send(Uint8Array.of(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toEqual([]);
    expect(reasons).toEqual([]);
  });
});
