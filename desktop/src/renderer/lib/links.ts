// Transports between the app and a node. Every link speaks host frames
// (see PROTOCOL.md) and reports parsed NodeEvents.
import { u32le } from "@core/bytes";
import { encodeFrame, FrameReader } from "@core/framing";
import { LanNode, type LanNetwork, type LanNotice, type LanTransport } from "@core/lannode";
import * as p from "@core/protocol";
import { api } from "./platform";

export interface LinkHandlers {
  onEvent: (ev: p.NodeEvent) => void;
  onClose: (reason: string) => void;
  /** Something the user should hear about that is not a node event. */
  onNotice?: (notice: LanNotice) => void;
}

export interface Link {
  readonly kind: "usb" | "wifi" | "sim" | "lan";
  readonly label: string;
  open(h: LinkHandlers): Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

// ---- USB serial (Web Serial API) ----

export class WebSerialLink implements Link {
  readonly kind = "usb";
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closing = false;

  constructor(private port: SerialPort, readonly label: string) {}

  async open(h: LinkHandlers) {
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    // Release DTR/RTS so ESP boards with auto-reset circuits boot normally.
    await this.port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
    this.readLoop(h);
  }

  private async readLoop(h: LinkHandlers) {
    const frames = new FrameReader();
    try {
      while (this.port.readable && !this.closing) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            for (const f of frames.feed(value)) {
              const ev = p.parseHostFrame(f);
              if (ev) h.onEvent(ev);
            }
          }
        } finally {
          this.reader.releaseLock();
        }
      }
    } catch (e) {
      if (!this.closing) h.onClose(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!this.closing) h.onClose("Node disconnected");
  }

  // One writer for the link's lifetime; frames queue in order. Taking a new
  // writer per frame fails when two sends overlap ("WritableStream is locked").
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private queue: Promise<void> = Promise.resolve();

  send(frame: Uint8Array): Promise<void> {
    const data = encodeFrame(frame);
    const next = this.queue.then(async () => {
      if (this.closing) throw new Error("Link closed");
      this.writer ??= this.port.writable!.getWriter();
      await this.writer.write(data);
    });
    this.queue = next.catch(() => {}); // Keep the chain alive after a failed write.
    return next;
  }

  async close() {
    this.closing = true;
    await this.queue;
    this.writer?.releaseLock();
    this.writer = null;
    await this.reader?.cancel().catch(() => {});
    await this.port.close().catch(() => {});
  }
}

// ---- Wi-Fi: WebSocket to a node (guest role) ----

/**
 * Talks to a node over its Wi-Fi WebSocket. The node greets with HELLO
 * (nonce, chip id, network id); the app answers with a signature from its
 * per-network guest key and waits for AUTH_OK. One WS message = one host frame.
 */
export class WebSocketLink implements Link {
  readonly kind = "wifi";
  private ws: WebSocket | null = null;
  private closing = false;

  constructor(
    private url: string,
    readonly label: string,
    private auth: (hello: Extract<p.NodeEvent, { kind: "hello" }>) => { pk: Uint8Array; sig: Uint8Array },
  ) {}

  open(h: LinkHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let authed = false;
      const timer = setTimeout(() => {
        reject(new Error("The node did not answer. Is this PC on the node's Wi-Fi?"));
        ws.close();
      }, 8000);
      ws.onmessage = (e) => {
        if (!(e.data instanceof ArrayBuffer)) return;
        const ev = p.parseHostFrame(new Uint8Array(e.data));
        if (!ev) return;
        if (!authed) {
          if (ev.kind === "hello") {
            const { pk, sig } = this.auth(ev);
            ws.send(p.buildAuth(pk, sig).slice());
          } else if (ev.kind === "authOk") {
            authed = true;
            clearTimeout(timer);
            resolve();
          } else if (ev.kind === "error" || ev.kind === "kicked") {
            clearTimeout(timer);
            reject(new Error(ev.kind === "error" ? (p.ERR_TEXT[ev.code] ?? ev.text) : (p.ERR_TEXT[ev.reason] ?? "Rejected by the node")));
          }
          return;
        }
        h.onEvent(ev);
      };
      ws.onerror = () => {
        if (!authed) {
          clearTimeout(timer);
          reject(new Error(`Could not reach ${this.url}`));
        }
      };
      ws.onclose = () => {
        if (authed && !this.closing) h.onClose("Wi-Fi link to the node closed");
      };
    });
  }

  async send(frame: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Link closed");
    this.ws.send(frame.slice());
  }

  async close() {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }
}

// ---- Simulator: other app windows on this machine act as the mesh ----

interface SimPacket {
  from: number;
  airType: number;
  body: number[];
  msgId: number;
}

export class SimLink implements Link {
  readonly kind = "sim";
  readonly label = "Simulator";
  private ch: BroadcastChannel | null = null;
  private beacon: ReturnType<typeof setInterval> | null = null;
  private readonly chipId = (Math.random() * 0xffffffff) >>> 0;
  private h: LinkHandlers | null = null;

  async open(h: LinkHandlers) {
    this.h = h;
    this.ch = new BroadcastChannel("meshlink-sim");
    this.ch.onmessage = (e: MessageEvent<SimPacket>) => {
      const m = e.data;
      h.onEvent({ kind: "recv", airType: m.airType, ttl: 3, origin: m.from, msgId: m.msgId, flags: 0, body: Uint8Array.from(m.body) });
    };
    const mac = Array.from(u32le(this.chipId), (b) => b.toString(16).padStart(2, "0").toUpperCase());
    setTimeout(() => h.onEvent({
      kind: "info", version: p.VERSION, chipId: this.chipId, mac: ["5E", "11", ...mac].join(":"), channel: 6,
      fwVersion: "sim", role: "guest", perm: p.PERM_FULL, netId: 0, nodeName: "Simulator",
    }), 250);
    const beacon = () => this.post(p.AIR_BEACON, new Uint8Array());
    beacon();
    this.beacon = setInterval(beacon, 10_000);
  }

  private post(airType: number, body: Uint8Array) {
    const msgId = ((Math.random() * 0xffffffff) >>> 0) || 1;
    this.ch?.postMessage({ from: this.chipId, airType, body: Array.from(body), msgId } satisfies SimPacket);
    return msgId;
  }

  async send(frame: Uint8Array) {
    if (frame[0] === p.H_INFO_REQ) return;
    if (frame[0] !== p.H_SEND) return;
    const id = this.post(frame[1], frame.subarray(3));
    this.h?.onEvent({ kind: "sent", msgId: id });
  }

  async close() {
    if (this.beacon) clearInterval(this.beacon);
    this.ch?.close();
    this.ch = null;
  }
}

// ---- Home Wi-Fi: other MeshLink apps on the same router act as the mesh ----

/** The UDP socket lives in the Electron main process; this is its renderer end. */
class IpcLanTransport implements LanTransport {
  private off: (() => void)[] = [];

  async open(onDatagram: (d: Uint8Array) => void, onClosed: (reason: string) => void) {
    this.off = [api.onLanDatagram(onDatagram), api.onLanClosed(onClosed)];
    const r = await api.lanOpen();
    if (!r.ok) {
      this.detach();
      throw new Error(r.message);
    }
  }

  send(d: Uint8Array) {
    api.lanSend(d);
  }

  close() {
    this.detach();
    api.lanClose();
  }

  private detach() {
    for (const f of this.off) f();
    this.off = [];
  }
}

export class LanLink implements Link {
  readonly kind = "lan";
  readonly label = "Home Wi-Fi";
  private node: LanNode;

  constructor(net: LanNetwork, opts: { stealth: boolean }) {
    this.node = new LanNode(new IpcLanTransport(), net, { stealth: opts.stealth });
  }

  open(h: LinkHandlers) {
    return this.node.open(h);
  }

  /** Stealth changed while connected: start or stop beacons at once. */
  setStealth(on: boolean) {
    this.node.setStealth(on);
  }

  async send(frame: Uint8Array) {
    this.node.send(frame);
  }

  async close() {
    this.node.close();
  }
}

/** Name for known ESP USB-serial bridges, by USB vendor id. */
export function usbBridgeName(vendorId?: string | number): string | null {
  const v = typeof vendorId === "string" ? parseInt(vendorId, 10) : vendorId;
  switch (v) {
    case 0x1a86: return "CH340";
    case 0x10c4: return "CP210x";
    case 0x0403: return "FTDI";
    case 0x303a: return "Espressif";
    default: return null;
  }
}

// ---- Auto-connect: open a known COM port without showing a picker ----

declare global {
  interface Window {
    __meshlinkAutoPick?: () => void;
  }
}

/**
 * Get the Web Serial port for a COM name that Windows reported (e.g. "COM5").
 * The host answers requestPort() itself, so no picker appears. Desktop only.
 */
export function requestPortByName(portName: string, timeoutMs = 5000): Promise<SerialPort> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${portName} did not respond`)), timeoutMs);
    window.__meshlinkAutoPick = () => {
      window.__meshlinkAutoPick = undefined;
      navigator.serial.requestPort().then(resolve, reject).finally(() => clearTimeout(timer));
    };
    api.autoPickPort(portName);
  });
}
