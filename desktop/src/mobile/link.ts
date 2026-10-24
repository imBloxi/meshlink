import type { Identity } from "../core/identity";
import * as p from "../core/protocol";

export interface FrameTransport {
  open(host: string, frame: (data: Uint8Array) => void, lost: (reason: string) => void): void;
  send(data: Uint8Array): void;
  close(): void;
}

export function nodeAddress(value: string): string {
  const host = value.trim();
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((v) => !/^(0|[1-9]\d{0,2})$/.test(v) || +v > 255)) {
    throw new Error("Enter the node’s private IPv4 address, for example 192.168.4.1.");
  }
  const [a, b, , d] = parts.map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) || d === 0 || d === 255) {
    throw new Error("Only private Wi-Fi node addresses are allowed.");
  }
  return host;
}

type Info = Extract<p.NodeEvent, { kind: "info" }>;

/** A guest-only session; no messages leave until AUTH_OK and protocol INFO agree. */
export class NodeLink {
  private ready = false;
  private cancel: (() => void) | null = null;
  constructor(private transport: FrameTransport, private identity: Identity) {}

  open(host: string, event: (ev: p.NodeEvent) => void, closed: (reason: string) => void): Promise<Info> {
    this.close();
    const address = nodeAddress(host);
    return new Promise((resolve, reject) => {
      let stage: "hello" | "auth" | "info" | "ready" = "hello";
      let netId = 0;
      let chipId = 0;
      let finished = false;
      const fail = (reason: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.cancel = null;
        this.ready = false;
        this.transport.close();
        if (stage === "ready") closed(reason);
        else reject(new Error(reason));
      };
      const timer = setTimeout(() => fail("The node did not answer. Join its Wi-Fi hotspot and try again."), 8000);
      this.cancel = () => fail("Connection cancelled");
      try {
        this.transport.open(address, (bytes) => {
          if (finished) return;
          try {
            if (bytes.length > 1024) throw new Error("Node frame is too large.");
            if (bytes[0] === p.H_AUTH_OK && (bytes.length !== 3 || bytes[1] !== p.ROLE_GUEST)) {
              throw new Error("Expected a valid guest authentication reply.");
            }
            const ev = p.parseHostFrame(bytes);
            if (!ev) return;
            if (ev.kind === "kicked" || ev.kind === "error") {
              const code = ev.kind === "kicked" ? ev.reason : ev.code;
              if (stage !== "ready" || ev.kind === "kicked") fail(p.ERR_TEXT[code] ?? "Node rejected the connection.");
              else event(ev);
              return;
            }
            if (stage === "hello") {
              if (ev.kind !== "hello") throw new Error("Expected node HELLO before authentication.");
              netId = ev.netId;
              chipId = ev.chipId;
              const auth = this.identity.guestAuth(netId, ev.nonce, chipId);
              stage = "auth";
              this.transport.send(p.buildAuth(auth.pk, auth.sig));
            } else if (stage === "auth") {
              if (ev.kind !== "authOk" || ev.role !== "guest" || ![0, 1, 2].includes(ev.perm)) {
                throw new Error("Expected guest authentication from the node.");
              }
              stage = "info";
              this.transport.send(new Uint8Array([p.H_INFO_REQ]));
            } else if (stage === "info" || ev.kind === "info") {
              if (ev.kind !== "info") return;
              if (ev.version !== p.VERSION) throw new Error(`Unsupported node protocol v${ev.version}; this app needs v${p.VERSION}.`);
              if (ev.role !== "guest" || ev.netId !== netId || ev.chipId !== chipId || ![0, 1, 2].includes(ev.perm ?? -1)) {
                throw new Error("Node identity or guest permissions are invalid. Reconnect to the node.");
              }
              if (stage === "ready") { event(ev); return; }
              stage = "ready";
              this.ready = true;
              clearTimeout(timer);
              resolve(ev);
            } else if (ev.kind !== "hello" && ev.kind !== "authOk") {
              event(ev);
            }
          } catch (error) { fail(error instanceof Error ? error.message : "Invalid node frame."); }
        }, fail);
      } catch (error) { fail(error instanceof Error ? error.message : "Connection failed."); }
    });
  }

  refreshInfo() {
    if (!this.ready) throw new Error("Connect to a node first.");
    this.transport.send(new Uint8Array([p.H_INFO_REQ]));
  }

  send(frame: Uint8Array) {
    if (!this.ready) throw new Error("Connect to a node first.");
    // This client never administers a node or discloses a network key.
    if (frame[0] !== p.H_SEND) throw new Error("Only guest messaging is supported.");
    this.transport.send(frame);
  }

  close() {
    const cancel = this.cancel;
    this.cancel = null;
    this.ready = false;
    if (cancel) cancel();
    else this.transport.close();
  }
}
