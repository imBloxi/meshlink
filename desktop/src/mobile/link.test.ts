import { describe, expect, it, vi } from "vitest";
import { Identity } from "../core/identity";
import * as p from "../core/protocol";
import { concat, u32le } from "../core/bytes";
import { NodeLink, nodeAddress, type FrameTransport } from "./link";

class FakeTransport implements FrameTransport {
  frame: (data: Uint8Array) => void = () => {};
  lost: (reason: string) => void = () => {};
  sent: Uint8Array[] = [];
  closed = false;
  open(_host: string, frame: (data: Uint8Array) => void, lost: (reason: string) => void) {
    this.frame = frame; this.lost = lost;
  }
  send(data: Uint8Array) { this.sent.push(data); }
  close() { this.closed = true; }
}
const hello = () => concat(new Uint8Array([p.H_HELLO]), new Uint8Array(16), u32le(42), u32le(7), new Uint8Array([0]));
function info(version = p.VERSION) {
  return concat(new Uint8Array([p.H_INFO, version]), u32le(42), new Uint8Array(6),
    new Uint8Array([6, 0, p.ROLE_GUEST, p.PERM_FULL]), u32le(7), new Uint8Array([0]));
}

describe("mobile node connection", () => {
  it("restricts endpoints to literal private IPv4 addresses", () => {
    expect(nodeAddress(" 192.168.4.1 ")).toBe("192.168.4.1");
    expect(nodeAddress("10.0.0.2")).toBe("10.0.0.2");
    for (const host of ["example.com", "8.8.8.8", "127.0.0.1", "192.168.4.1:81", "192.168.999.1", "172.32.0.1", "010.0.0.1"]) {
      expect(() => nodeAddress(host)).toThrow();
    }
  });
  it("waits for signed authentication and compatible INFO before connecting", async () => {
    const transport = new FakeTransport();
    const identity = Identity.generate();
    const event = vi.fn();
    const link = new NodeLink(transport, identity);
    const connected = link.open("192.168.4.1", event, vi.fn());
    transport.frame(hello());
    expect(transport.sent[0][0]).toBe(p.H_AUTH);
    expect(transport.sent[0]).toHaveLength(97);
    const auth = identity.guestAuth(7, new Uint8Array(16), 42);
    expect(transport.sent[0]).toEqual(p.buildAuth(auth.pk, auth.sig));
    transport.frame(new Uint8Array([p.H_AUTH_OK, p.ROLE_GUEST, p.PERM_FULL]));
    expect(transport.sent[1]).toEqual(new Uint8Array([p.H_INFO_REQ]));
    transport.frame(info());
    await expect(connected).resolves.toMatchObject({ version: p.VERSION, netId: 7 });
    link.close();
  });
  it("rejects an admin claim over Wi-Fi", async () => {
    const transport = new FakeTransport();
    const link = new NodeLink(transport, Identity.generate());
    const connected = link.open("192.168.4.1", vi.fn(), vi.fn());
    transport.frame(hello());
    transport.frame(new Uint8Array([p.H_AUTH_OK, p.ROLE_ADMIN, p.PERM_FULL]));
    await expect(connected).rejects.toThrow(/guest/i);
    expect(transport.closed).toBe(true);
  });
  it("rejects incompatible protocol versions", async () => {
    const transport = new FakeTransport();
    const link = new NodeLink(transport, Identity.generate());
    const connected = link.open("192.168.4.1", vi.fn(), vi.fn());
    transport.frame(hello());
    transport.frame(new Uint8Array([p.H_AUTH_OK, p.ROLE_GUEST, p.PERM_FULL]));
    transport.frame(info(p.VERSION + 1));
    await expect(connected).rejects.toThrow(/protocol/i);
  });
  it("settles cancelled connections and closes timed-out sockets", async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const link = new NodeLink(transport, Identity.generate());
      const cancelled = link.open("192.168.4.1", vi.fn(), vi.fn());
      link.close();
      await expect(cancelled).rejects.toThrow(/cancel/i);
      const timedOut = link.open("192.168.4.1", vi.fn(), vi.fn());
      const rejected = expect(timedOut).rejects.toThrow(/answer/i);
      await vi.advanceTimersByTimeAsync(8000);
      await rejected;
      expect(transport.closed).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("rejects AUTH_OK before HELLO and malformed AUTH_OK", async () => {
    for (const bytes of [new Uint8Array([p.H_AUTH_OK, p.ROLE_GUEST, 2]), new Uint8Array([p.H_AUTH_OK])]) {
      const transport = new FakeTransport();
      const link = new NodeLink(transport, Identity.generate());
      const connected = link.open("192.168.4.1", vi.fn(), vi.fn());
      transport.frame(bytes);
      await expect(connected).rejects.toThrow();
    }
  });
});
