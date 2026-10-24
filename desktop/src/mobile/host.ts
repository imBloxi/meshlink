import { fromB64, toB64 } from "../core/bytes";
import type { FrameTransport } from "./link";

interface AndroidBridge {
  loadVault(): string;
  saveVault(value: string): string;
  wipeVault(): string;
  openNode(host: string, session: number): void;
  sendFrame(value: string, session: number): boolean;
  closeNode(): void;
  openWifiSettings(): void;
  backgroundApp(): void;
}
declare global { interface Window { NodeLinkAndroid?: AndroidBridge } }

export const isAndroid = () => !!window.NodeLinkAndroid;
function bridge(): AndroidBridge {
  if (!window.NodeLinkAndroid) throw new Error("Install the Android app to use secure storage and connect to a node.");
  return window.NodeLinkAndroid;
}
function result<T>(json: string): T {
  const parsed = JSON.parse(json) as { ok: boolean; value?: T; error?: string };
  if (!parsed.ok) throw new Error(parsed.error ?? "Secure storage is unavailable.");
  return parsed.value as T;
}
export const loadVault = () => result<string | null>(bridge().loadVault());
export const saveVault = (json: string) => result<void>(bridge().saveVault(json));
export const wipeVault = () => result<void>(bridge().wipeVault());
export const openWifi = () => bridge().openWifiSettings();
export const backgroundApp = () => bridge().backgroundApp();

let nextSession = 0;
export class AndroidTransport implements FrameTransport {
  private session = 0;
  private listener: ((ev: Event) => void) | null = null;
  open(host: string, frame: (value: Uint8Array) => void, lost: (reason: string) => void) {
    this.session = ++nextSession;
    this.listener = (event) => {
      const detail = (event as CustomEvent<{ session: number; type: string; data: string }>).detail;
      if (detail.session !== this.session) return;
      if (detail.type === "frame") {
        try { frame(fromB64(detail.data)); } catch { lost("Invalid frame from the node."); }
      } else if (detail.type === "closed") lost(detail.data);
    };
    window.addEventListener("nodelink", this.listener);
    bridge().openNode(host, this.session);
  }
  send(data: Uint8Array) {
    if (!bridge().sendFrame(toB64(data), this.session)) throw new Error("The Wi-Fi connection has closed.");
  }
  close() {
    if (this.listener) window.removeEventListener("nodelink", this.listener);
    this.listener = null;
    this.session = 0;
    if (isAndroid()) bridge().closeNode();
  }
}
