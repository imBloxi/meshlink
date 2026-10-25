// Contract between the renderer and its host (Electron main, or a browser
// fallback for UI development). Everything crosses as plain JSON.

export interface StoredContact {
  fp: string; // hex fingerprint
  pubkey: string; // base64
  signPk: string; // base64 Ed25519; part of the fingerprint
  name: string;
  verified: boolean;
  firstSeen: number;
  lastSeen: number;
}

export type MessageState = "sending" | "sent" | "delivered" | "failed" | "received";

export interface StoredMessage {
  uid: string; // senderFp:group, unique
  conv: string; // "dm:<fp>" or "room:<id>"
  senderFp: string;
  outgoing: boolean;
  text: string;
  ts: number; // unix seconds
  state: MessageState;
  verified?: boolean;
}

/** Encrypted JSON records kept by the host: rooms, networks, known nodes. */
export type RecordKind = "room" | "network" | "node";

/** A node the app has provisioned or joined over Wi-Fi. */
export interface KnownNode {
  chipId: number;
  name: string;
  netId: number;
  ssid: string;
  psk: string;
  hidden: boolean;
  lastIp: string; // "192.168.4.1" on the node's own hotspot
  lastSeen: number;
}

export interface WifiNetwork {
  ssid: string;
  signal: number; // 0..100
  secured: boolean;
}

export interface DiscoveredNode {
  ip: string;
  chipId: number;
  netId: number;
  name: string;
}

export interface SerialPortChoice {
  portId: string;
  portName: string;
  displayName?: string;
  vendorId?: string;
  productId?: string;
}

export type UsbBridge = "CH340" | "CP210x" | "FTDI" | "Espressif";

/** A USB-serial bridge chip seen by Windows (whether or not its driver works). */
export interface UsbDevice {
  id: string; // Windows device instance id
  name: string;
  bridge: UsbBridge;
  vid: string;
  pid: string;
  com: string | null; // "COM5" once a driver is installed
  driverMissing: boolean;
  error: number; // Windows ConfigManagerErrorCode, 0 = OK
}

export interface FirmwareManifest {
  name: string;
  version: string;
  chip: string;
  file: string;
  offset: number;
  size: number;
  sha256: string;
  builtAt: string;
}

export interface AppInfo {
  version: string;
  electron?: string;
  chrome?: string;
  node?: string;
  platform: string;
  packaged: boolean;
  repo: string;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  url?: string; // always a github.com/imBloxi/meshlink/releases/ page
  notes?: string; // release notes (Markdown, shown as plain text)
  publishedAt?: string;
  error?: string;
}

export interface MeshlinkApi {
  platform: "electron" | "web";
  /** App, Electron and platform versions. */
  getAppInfo(): Promise<AppInfo>;
  /** Ask GitHub Releases for a newer version. Never downloads anything. */
  checkForUpdate(): Promise<UpdateInfo>;
  /** Open a release page in the system browser (MeshLink releases only). */
  openReleasePage(url: string): Promise<void>;
  /** Base64 identity secret key, decrypted with the OS keystore. */
  getIdentity(): Promise<string | null>;
  setIdentity(secretKeyB64: string): Promise<void>;
  getSettings(): Promise<Record<string, unknown>>;
  setSetting(key: string, value: unknown): Promise<void>;
  listContacts(): Promise<StoredContact[]>;
  saveContact(c: StoredContact): Promise<void>;
  listMessages(conv: string, limit: number): Promise<StoredMessage[]>;
  addMessage(m: StoredMessage): Promise<void>;
  updateMessageState(uid: string, state: MessageState): Promise<void>;
  deleteMessage(uid: string): Promise<void>;
  /** Disappearing messages: delete a conversation's messages older than ts (unix s). */
  deleteMessagesBefore(conv: string, ts: number): Promise<number>;
  deleteConversation(conv: string): Promise<void>;
  listRecords<T = unknown>(kind: RecordKind): Promise<T[]>;
  saveRecord(kind: RecordKind, id: string, data: unknown): Promise<void>;
  deleteRecord(kind: RecordKind, id: string): Promise<void>;
  /** Wi-Fi (Windows netsh). */
  wifiScan(): Promise<{ networks: WifiNetwork[]; error?: "location" | "no-wifi" | string }>;
  wifiCurrent(): Promise<string | null>;
  /** Join a node hotspot. Remembers the current Wi-Fi so wifiRestore() can go back. */
  wifiConnect(ssid: string, psk: string, hidden: boolean): Promise<{ ok: boolean; message: string }>;
  wifiRestore(): Promise<void>;
  /** Find nodes on the local network (UDP broadcast, port 4210). */
  discoverNodes(timeoutMs: number): Promise<DiscoveredNode[]>;
  /**
   * Home Wi-Fi transport: air-frame datagrams over UDP on the local subnet.
   * One session at a time: opening again closes the previous session without telling it.
   * Opening fails with a message the user can act on.
   */
  lanOpen(): Promise<{ ok: true } | { ok: false; message: string }>;
  lanSend(datagram: Uint8Array): void;
  lanClose(): void;
  onLanDatagram(cb: (datagram: Uint8Array) => void): () => void;
  onLanClosed(cb: (reason: string) => void): () => void;
  /** File dialogs for backups. */
  saveTextFile(defaultName: string, text: string): Promise<boolean>;
  openTextFile(): Promise<string | null>;
  /** Windows Location settings: Wi-Fi scans need Location on (Windows 11 24H2+). */
  openLocationSettings(): Promise<void>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  /** Minimize to the tray instead of quitting when the window closes. */
  setCloseToTray(on: boolean): Promise<void>;
  setUnreadBadge(count: number): void;
  /** Firmware image bundled in the app folder (resources/firmware), or null. */
  getFirmware(): Promise<{ manifest: FirmwareManifest; data: Uint8Array } | null>;
  /** True if an unreadable key file was moved aside at startup. */
  secretsWereReset(): Promise<boolean>;
  /** USB-serial bridges currently plugged in, and live updates. */
  listUsbDevices(): Promise<UsbDevice[]>;
  onUsbDevices(cb: (devices: UsbDevice[]) => void): () => void;
  /** Bridges with a driver bundled in resources/drivers. */
  availableDrivers(): Promise<UsbBridge[]>;
  /** Install bundled drivers (one UAC prompt). */
  installDrivers(bridges: UsbBridge[]): Promise<{ ok: boolean; message: string }>;
  /** Ask the host to answer the next requestPort() with this COM port, without a picker. */
  autoPickPort(portName: string): void;
  /** Delete identity, contacts, messages and settings. */
  wipeAll(): Promise<void>;
  /** Electron shows no native serial picker; the app renders its own. */
  onSerialPorts(cb: (ports: SerialPortChoice[]) => void): () => void;
  chooseSerialPort(portId: string): void;
}

declare global {
  interface Window {
    meshlink?: MeshlinkApi;
  }
}
