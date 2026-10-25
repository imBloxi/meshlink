// App state (zustand). Wires Messenger + Link + host storage together.
import { createBackup, openBackup, type BackupContent } from "@core/backup";
import { assessFirmware } from "@core/firmware";
import { fromB64, fromHex, toB64, toHex, u32le } from "@core/bytes";
import type { Contact } from "@core/contacts";
import { fingerprint, Identity } from "@core/identity";
import { dmConv, Messenger, roomConv, type MessengerOutput } from "@core/messenger";
import { createNetwork, inviteOf, networkFromInvite, OPEN_NETWORK, type Network } from "@core/network";
import * as pl from "@core/payloads";
import * as p from "@core/protocol";
import { privateRoom, publicRoom, roomFromInvite, roomIdBytes, roomKey, type Room } from "@core/rooms";
import type { FirmwareManifest, KnownNode, MessageState, StoredContact, StoredMessage, UsbBridge, UsbDevice } from "@shared/api";
import { create } from "zustand";
import { LanLink, requestPortByName, usbBridgeName, WebSerialLink, WebSocketLink, type Link } from "./links";
import { api } from "./platform";

export type Accent = "teal" | "blue" | "violet" | "amber" | "rose" | "lime";

export interface Settings {
  name: string;
  theme: "system" | "light" | "dark";
  accent: Accent;
  density: "comfortable" | "compact";
  fontScale: number;
  announceInterval: number; // seconds
  stealth: boolean; // never announce automatically
  enterToSend: boolean;
  showTimestamps: boolean;
  notifyToasts: boolean;
  notifyNative: boolean; // Windows notifications when the window is in the background
  notifyPreview: boolean; // show sender and text in Windows notifications (off: "New message" only)
  frameLog: boolean;
  autoConnect: boolean; // connect to a detected board automatically
  autoInstallDrivers: boolean; // install bundled USB drivers when a board lacks one
  autoWifi: boolean; // no USB board: connect to a known node over Wi-Fi
  allowHotspot: boolean; // may join a node's own hotspot (drops the PC's internet)
  closeToTray: boolean;
  launchAtLogin: boolean;
  checkUpdates: boolean; // ask GitHub for a newer release on start (off by default: no network calls)
  activeNetId: number; // network new nodes are put on
  experimentalLan: boolean; // experimental: show Home Wi-Fi in the Connect dialog (off by default)
  lanIntro: boolean; // the home Wi-Fi privacy note has been shown
  disappear: Record<string, number>; // DM conversation -> seconds
}

export const defaultSettings: Settings = {
  name: "",
  theme: "system",
  accent: "teal",
  density: "comfortable",
  fontScale: 1,
  announceInterval: 60, // privacy by default: broadcast name and key less often
  stealth: false,
  enterToSend: true,
  showTimestamps: true,
  notifyToasts: true,
  notifyNative: true,
  notifyPreview: false, // Windows notifications can show on the lock screen and in Action Center history
  frameLog: false,
  autoConnect: true,
  autoInstallDrivers: true,
  autoWifi: true,
  allowHotspot: false, // never switch the PC's Wi-Fi unless the user allows it
  closeToTray: false,
  launchAtLogin: false,
  checkUpdates: false,
  activeNetId: 0,
  experimentalLan: false,
  lanIntro: false,
  disappear: {},
};

export interface Toast {
  id: number;
  level: "info" | "warning" | "success" | "error";
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}

export interface LogLine {
  t: number;
  dir: "in" | "out" | "node";
  text: string;
}

export interface PendingInvite {
  code: string;
  invite: pl.RoomInvite;
  fromFp: string;
  at: number;
}

export type ConnStatus = "disconnected" | "connecting" | "connected";
export type PanelName = "settings" | "connect" | "details" | "flasher" | "newRoom" | "admin" | "account" | "networks";

export interface NodeAdminState {
  config: Partial<p.NodeConfig> | null;
  status: p.NodeStatus | null;
  sessions: p.GuestSession[];
  bans: p.BanEntry[];
}

interface State {
  ready: boolean;
  identity: Identity | null;
  settings: Settings;
  contacts: Record<string, Contact>;
  rooms: Record<string, Room>;
  networks: Record<string, Network>;
  knownNodes: Record<string, KnownNode>;
  messages: Record<string, StoredMessage[]>; // by conversation
  unread: Record<string, number>;
  selected: string | null; // conversation: "dm:<fp>" | "room:<id>"
  invites: PendingInvite[];
  conn: {
    status: ConnStatus; kind?: Link["kind"]; label?: string; chipId?: number; mac?: string; fwVersion?: string; chip?: string; protocol?: number; error?: string;
    role?: p.Role; perm?: p.Perm; netId?: number; nodeName?: string;
  };
  node: NodeAdminState;
  firmware: { manifest: FirmwareManifest; data: Uint8Array } | null;
  usbDevices: UsbDevice[];
  bundledDrivers: UsbBridge[];
  driverInstall: "idle" | "running";
  wifiBusy: string | null; // what the Wi-Fi auto-connect is doing
  neighbors: Record<number, number>;
  toasts: Toast[];
  log: LogLine[];
  panels: Record<PanelName, boolean>;
  roomDialog: { roomId: string | null; tab: "invite" | "members" | "settings" } | null;
  now: number;

  init(): Promise<void>;
  createIdentity(name: string): Promise<void>;
  restoreFromPhrase(phrase: string, name: string): Promise<void>;
  exportBackup(passphrase: string, withMessages: boolean): Promise<boolean>;
  importBackup(text: string, passphrase: string): Promise<void>;
  updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void;
  select(conv: string | null): Promise<void>;
  connect(link: Link, opts?: { quiet?: boolean }): Promise<boolean>;
  disconnect(): Promise<void>;
  connectCom(com: string, auto?: boolean): Promise<void>;
  connectWifi(node: KnownNode, opts?: { viaLan?: string; quiet?: boolean }): Promise<boolean>;
  /** Message other MeshLink apps over the home router, on the active network. No node needed. */
  connectLan(): Promise<boolean>;
  autoConnectWifi(): Promise<void>;
  sendText(text: string): void;
  retry(uid: string): void;
  announceNow(): void;
  setVerified(fp: string, verified: boolean): void;
  // rooms
  createRoom(name: string, kind: "public" | "private"): Room | null;
  acceptInvite(code: string): void;
  declineInvite(code: string): void;
  roomInviteCode(roomId: string, hours: number): string;
  inviteContact(roomId: string, fp: string): void;
  leaveRoom(roomId: string): void;
  kickMember(roomId: string, fp: string): void;
  setModerator(roomId: string, fp: string, on: boolean): void;
  muteMember(roomId: string, fp: string, on: boolean): void;
  deleteMessage(conv: string, uid: string): void;
  updateRoom(roomId: string, patch: Partial<Room>): void;
  openRoomDialog(roomId: string | null, tab?: "invite" | "members" | "settings"): void;
  // networks
  createNetwork(name: string, channel: number): Network;
  joinNetwork(code: string): Network;
  leaveNetwork(netId: number): void;
  networkCode(netId: number): string;
  inviteToNetwork(fp: string, netId: number): void;
  provisionNode(netId: number): void;
  policyBan(netId: number, kind: p.BanKind, idHex: string, note: string, unban?: boolean): void;
  // node admin (USB only)
  refreshNode(): void;
  setNodeConfig(patch: Partial<p.NodeConfig>): void;
  kickGuest(pseudo: string): void;
  banGuest(pseudo: string): void;
  nodeBan(kind: p.BanKind, idHex: string, unban?: boolean): void;
  setGuestPerm(pseudo: string, perm: p.Perm): void;
  rebootNode(): void;
  factoryResetNode(): void;
  forgetNode(chipId: number): void;
  // misc
  setPanel(panel: PanelName, open: boolean): void;
  toast(t: Omit<Toast, "id">): void;
  dismissToast(id: number): void;
  wipe(): Promise<void>;
  installDrivers(bridges: UsbBridge[]): Promise<void>;
}

const contactsMap = new Map<string, Contact>();
let messenger: Messenger | null = null;
let link: Link | null = null;
let announceTimer: ReturnType<typeof setInterval> | null = null;
let toastId = 0;
const driverTried = new Set<string>();
let lastAutoCom: string | null = null;
const autoFailed = new Set<string>();
let wifiLoop: ReturnType<typeof setTimeout> | null = null;

const toStored = (c: Contact): StoredContact => ({ ...c, pubkey: toB64(c.pubkey), signPk: toB64(c.signPk) });
const fromStored = (c: StoredContact): Contact => ({ ...c, pubkey: fromB64(c.pubkey), signPk: fromB64(c.signPk) });
const hexOf = (b: Uint8Array) => toHex(b).match(/../g)?.join(" ") ?? "";
const netKey = (id: number) => String(id >>> 0);

export const useApp = create<State>((set, get) => {
  const log = (dir: LogLine["dir"], text: string) => {
    if (!get().settings.frameLog) return;
    set((s) => ({ log: [...s.log.slice(-399), { t: Date.now(), dir, text }] }));
  };

  const syncContacts = () => set({ contacts: Object.fromEntries(contactsMap) });

  const sendFrame = (frame: Uint8Array) => {
    log("out", hexOf(frame));
    link?.send(frame).catch((e) => get().toast({ level: "error", title: "Send failed", body: String(e) }));
  };

  const addMessage = (m: StoredMessage) => {
    api.addMessage(m);
    set((s) => {
      const list = s.messages[m.conv];
      if (!list) return {}; // not loaded yet: select() loads it from storage
      if (list.some((x) => x.uid === m.uid)) return {};
      return { messages: { ...s.messages, [m.conv]: [...list, m] } };
    });
  };

  const setMessageState = (uid: string, state: MessageState) => {
    api.updateMessageState(uid, state);
    set((s) => {
      const out: Record<string, StoredMessage[]> = {};
      for (const [conv, list] of Object.entries(s.messages)) {
        out[conv] = list.some((m) => m.uid === uid) ? list.map((m) => (m.uid === uid ? { ...m, state } : m)) : list;
      }
      return { messages: out };
    });
  };

  const removeMessage = (conv: string, uid: string) => {
    api.deleteMessage(uid);
    set((s) => ({ messages: { ...s.messages, [conv]: (s.messages[conv] ?? []).filter((m) => m.uid !== uid) } }));
  };

  const saveRoom = (r: Room) => {
    api.saveRecord("room", r.id, r);
    set((s) => ({ rooms: { ...s.rooms, [r.id]: r } }));
  };

  const saveNetwork = (n: Network) => {
    api.saveRecord("network", netKey(n.netId), n);
    set((s) => ({ networks: { ...s.networks, [netKey(n.netId)]: n } }));
  };

  const saveNode = (n: KnownNode) => {
    api.saveRecord("node", String(n.chipId), n);
    set((s) => ({ knownNodes: { ...s.knownNodes, [String(n.chipId)]: n } }));
  };

  const scheduleAnnounce = () => {
    if (announceTimer) clearInterval(announceTimer);
    announceTimer = null;
    const { stealth, announceInterval } = get().settings;
    if (!link || stealth) return;
    announceTimer = setInterval(() => messenger?.announce(), announceInterval * 1000);
  };


  const notify = (conv: string, title: string, body: string) => {
    const s = get().settings;
    if (s.notifyNative && document.hidden && "Notification" in window) {
      try {
        // Without previews, Windows (lock screen, Action Center history) learns nothing.
        const n = s.notifyPreview ? new Notification(title, { body, silent: false }) : new Notification("MeshLink", { body: "New message", silent: false });
        n.onclick = () => {
          window.focus();
          get().select(conv);
        };
      } catch {
        /* notifications blocked */
      }
    } else if (s.notifyToasts) {
      get().toast({ level: "info", title, body, action: { label: "Open", run: () => get().select(conv) } });
    }
  };

  const updateBadge = () => {
    const total = Object.values(get().unread).reduce((a, b) => a + b, 0);
    api.setUnreadBadge(total);
  };

  const applyOutputs = (outs: MessengerOutput[]) => {
    for (const out of outs) {
      switch (out.kind) {
        case "contact":
          api.saveContact(toStored(out.contact));
          syncContacts();
          break;
        case "message": {
          const m = out.message;
          const stored: StoredMessage = { ...m, uid: m.id };
          addMessage(stored);
          if (get().selected !== m.conv || document.hidden) {
            const r = m.conv.startsWith("room:") ? get().rooms[m.conv.slice(5)] : null;
            if (!r?.muted) {
              set((s) => ({ unread: { ...s.unread, [m.conv]: (s.unread[m.conv] ?? 0) + 1 } }));
              updateBadge();
              const who = contactsMap.get(m.senderFp)?.name ?? r?.members[m.senderFp]?.name ?? "Someone";
              notify(m.conv, r ? `${who} in #${r.name}` : who, m.text);
            }
          }
          break;
        }
        case "state":
          setMessageState(out.id, out.state);
          if (out.state === "failed") {
            get().toast({ level: "warning", title: "Message not delivered", body: "No reply from the other device. Retry from the message." });
          }
          break;
        case "room":
          saveRoom(out.room);
          break;
        case "roomRemoved":
          api.deleteRecord("room", out.roomId);
          set((s) => {
            const rooms = { ...s.rooms };
            delete rooms[out.roomId];
            return { rooms, selected: s.selected === roomConv(out.roomId) ? null : s.selected };
          });
          get().toast({ level: "warning", title: "Removed from room", body: out.reason });
          break;
        case "roomInvite":
          if (get().invites.some((i) => i.code === out.code) || get().rooms[toHex(out.invite.roomId)]) break;
          set((s) => ({ invites: [...s.invites, { code: out.code, invite: out.invite, fromFp: out.fromFp, at: Date.now() }] }));
          get().toast({
            level: "info", title: "Room invite",
            body: `${contactsMap.get(out.fromFp)?.name ?? "A contact"} invited you to #${out.invite.name}.`,
            action: { label: "Join", run: () => get().acceptInvite(out.code) },
          });
          break;
        case "networkInvite":
          get().toast({
            level: "info", title: "Network invite",
            body: `${contactsMap.get(out.fromFp)?.name ?? "A contact"} shared a network with you.`,
            action: { label: "Join", run: () => { try { get().joinNetwork(out.code); } catch (e) { get().toast({ level: "error", title: "Invite rejected", body: String(e) }); } } },
          });
          break;
        case "deleted":
          removeMessage(out.conv, out.id);
          break;
        case "notice":
          get().toast({ level: out.level, title: out.level === "warning" ? "Security notice" : "Mesh", body: out.text });
          break;
        case "neighbor":
          set((s) => ({ neighbors: { ...s.neighbors, [out.origin]: Date.now() } }));
          break;
      }
    }
  };

  // Only a USB link can be admin. A Wi-Fi "node" may be a clone that claims
  // the admin role to receive the network key from provisionNode().
  const isAdmin = () => get().conn.kind === "usb" && get().conn.role === "admin";

  const onEvent = (ev: p.NodeEvent) => {
    switch (ev.kind) {
      case "info": {
        const netId = ev.netId ?? 0;
        set((s) => ({
          conn: {
            ...s.conn, status: "connected", chipId: ev.chipId, mac: ev.mac, fwVersion: ev.fwVersion, chip: ev.chip, protocol: ev.version,
            role: s.conn.kind === "usb" ? (ev.role ?? "admin") : "guest", perm: ev.perm, netId, nodeName: ev.nodeName,
          },
        }));
        if (messenger) {
          messenger.netId = netId;
          messenger.setRooms(Object.values(get().rooms));
        }
        log("node", `node ${ev.chipId.toString(16).toUpperCase()} fw ${ev.fwVersion ?? "?"} ${ev.chip ?? ""} v${ev.version} ${ev.role ?? ""} net ${netId.toString(16)}`);
        const fw = assessFirmware({
          nodeFw: ev.fwVersion, nodeProtocol: ev.version, nodeChip: ev.chip, appProtocol: p.VERSION,
          bundled: get().firmware?.manifest,
        });
        if (fw.state === "protocol-new") {
          get().toast({ level: "warning", title: "This app is older than the node", body: fw.message });
        } else if (fw.state === "protocol-old") {
          get().toast({
            level: "warning", title: "Node firmware is outdated", body: fw.message,
            action: fw.canFlash ? { label: "Update", run: () => { get().disconnect(); get().setPanel("flasher", true); } } : undefined,
          });
        }
        if (isAdmin()) {
          get().refreshNode();
          const active = get().settings.activeNetId;
          if (netId === 0 && active && get().networks[netKey(active)]) {
            const n = get().networks[netKey(active)];
            get().toast({
              level: "info", title: "New node on the open network",
              body: `Put it on your network "${n.name}"?`,
              action: { label: "Add to network", run: () => get().provisionNode(active) },
            });
          }
        }
        return;
      }
      case "log":
        return log("node", ev.text);
      case "sent":
        return;
      case "config": {
        if (!isAdmin()) return; // Config replies only come to the USB admin.
        const config = { ...get().node.config, ...ev.config };
        set((s) => ({ node: { ...s.node, config } }));
        const chipId = get().conn.chipId;
        if (chipId !== undefined && config.apSsid) {
          const prev = get().knownNodes[String(chipId)];
          saveNode({
            chipId, name: config.nodeName ?? `Node ${chipId.toString(16)}`, netId: config.netId ?? 0,
            ssid: config.apEnabled === false ? "" : config.apSsid, psk: config.apOpen ? "" : (config.apPsk ?? ""),
            hidden: !!(config.apHidden || config.stealth), lastIp: prev?.lastIp ?? "192.168.4.1", lastSeen: Date.now(),
          });
        }
        return;
      }
      case "status":
        return set((s) => ({ node: { ...s.node, status: ev.status } }));
      case "sessions":
        if (!isAdmin()) return;
        return set((s) => ({ node: { ...s.node, sessions: ev.sessions } }));
      case "bans":
        if (!isAdmin()) return;
        return set((s) => ({ node: { ...s.node, bans: ev.bans } }));
      case "error":
        get().toast({ level: "error", title: p.ERR_TEXT[ev.code] ?? "Node error", body: ev.text });
        return;
      case "kicked":
        get().toast({ level: "error", title: "Disconnected by the node admin", body: p.ERR_TEXT[ev.reason] ?? "" });
        get().disconnect();
        return;
      case "recv": {
        log("in", `type ${ev.airType} ttl ${ev.ttl} from ${ev.origin.toString(16)} ${hexOf(ev.body)}`);
        if (ev.airType === p.AIR_POLICY) {
          const n = get().networks[netKey(get().conn.netId ?? 0)];
          if (n?.ownerPk) {
            const pol = pl.unpackPolicy(n.netId, ev.body, fromB64(n.ownerPk));
            if (pol && pol.seq > n.policySeq) {
              let bans = [...n.bans];
              for (const e of pol.entries) {
                const id = toHex(e.id);
                bans = bans.filter((b) => !(b.kind === e.kind && b.id === id));
                if (e.op === "ban") bans.push({ kind: e.kind, id, note: "", at: Date.now() });
              }
              saveNetwork({ ...n, bans, policySeq: pol.seq });
            }
          }
          return;
        }
        if (messenger) applyOutputs(messenger.handle(ev));
      }
    }
  };

  /** React to boards being plugged in or out. */
  const onUsb = (devices: UsbDevice[]) => {
    const before = new Set(get().usbDevices.map((d) => d.id));
    set({ usbDevices: devices });
    const s = get().settings;
    for (const d of devices) {
      if (!d.driverMissing || driverTried.has(d.id)) continue;
      driverTried.add(d.id);
      const bundled = get().bundledDrivers.includes(d.bridge);
      if (bundled && s.autoInstallDrivers) {
        get().toast({ level: "info", title: `${d.bridge} board found`, body: "Its USB driver is missing. Installing it now: approve the Windows prompt." });
        get().installDrivers([d.bridge]);
      } else {
        get().toast({
          level: "warning",
          title: `${d.bridge} board needs a driver`,
          body: bundled ? "Install the bundled driver to use this board." : "No driver bundled for this chip. Install it from the chip maker.",
          action: bundled ? { label: "Install driver", run: () => get().installDrivers([d.bridge]) } : undefined,
        });
      }
    }
    const usable = devices.filter((d) => d.com && !d.driverMissing);
    for (const com of autoFailed) if (!usable.some((d) => d.com === com)) autoFailed.delete(com);
    const fresh = usable.find((d) => !autoFailed.has(d.com!) && (!before.has(d.id) || d.com !== lastAutoCom));
    const c = get().conn;
    // A USB board beats Wi-Fi: it makes this app the node's admin.
    const canTake = c.status === "disconnected" || (c.kind === "wifi" && c.status === "connected");
    if (fresh && s.autoConnect && canTake && !get().panels.flasher && get().identity) {
      lastAutoCom = fresh.com;
      get().connectCom(fresh.com!, true);
    }
    if (!usable.some((d) => d.com === lastAutoCom)) lastAutoCom = null;
  };

  /** Keep trying Wi-Fi while nothing is connected and no USB board is usable. */
  const scheduleWifi = (ms: number) => {
    if (wifiLoop) clearTimeout(wifiLoop);
    wifiLoop = setTimeout(async () => {
      wifiLoop = null;
      await get().autoConnectWifi();
      scheduleWifi(30000);
    }, ms);
  };

  const sweepDisappearing = () => {
    const nowS = Math.floor(Date.now() / 1000);
    const convs: [string, number][] = [
      ...Object.entries(get().settings.disappear),
      ...Object.values(get().rooms).map((r) => [roomConv(r.id), r.disappearSecs] as [string, number]),
    ];
    for (const [conv, secs] of convs) {
      if (!secs) continue;
      api.deleteMessagesBefore(conv, nowS - secs);
      set((s) => (s.messages[conv] ? { messages: { ...s.messages, [conv]: s.messages[conv].filter((m) => m.ts >= nowS - secs) } } : {}));
    }
  };

  const withMessenger = <T,>(fn: (m: Messenger) => T): T | null => {
    if (!messenger) {
      get().toast({ level: "warning", title: "Not connected", body: "Connect to a node first." });
      return null;
    }
    return fn(messenger);
  };

  return {
    ready: false,
    identity: null,
    settings: defaultSettings,
    contacts: {},
    rooms: {},
    networks: {},
    knownNodes: {},
    messages: {},
    unread: {},
    selected: null,
    invites: [],
    conn: { status: "disconnected" },
    node: { config: null, status: null, sessions: [], bans: [] },
    neighbors: {},
    toasts: [],
    log: [],
    firmware: null,
    usbDevices: [],
    bundledDrivers: [],
    driverInstall: "idle",
    wifiBusy: null,
    panels: { settings: false, connect: false, details: true, flasher: false, newRoom: false, admin: false, account: false, networks: false },
    roomDialog: null,
    now: Date.now(),

    async init() {
      const [sk, stored, contacts, firmware, reset, bundledDrivers, rooms, networks, nodes] = await Promise.all([
        api.getIdentity(), api.getSettings(), api.listContacts(),
        api.getFirmware().catch(() => null), api.secretsWereReset(), api.availableDrivers(),
        api.listRecords<Room>("room"), api.listRecords<Network>("network"), api.listRecords<KnownNode>("node"),
      ]);
      for (const c of contacts) if (c.signPk) contactsMap.set(c.fp, fromStored(c));
      set({
        ready: true,
        identity: sk ? new Identity(fromB64(sk)) : null,
        settings: { ...defaultSettings, ...(stored as Partial<Settings>) },
        contacts: Object.fromEntries(contactsMap),
        rooms: Object.fromEntries(rooms.map((r) => [r.id, r])),
        networks: Object.fromEntries([[netKey(0), OPEN_NETWORK], ...networks.map((n) => [netKey(n.netId), n] as const)]),
        knownNodes: Object.fromEntries(nodes.map((n) => [String(n.chipId), n])),
        firmware,
        bundledDrivers,
      });
      api.onUsbDevices(onUsb);
      onUsb(await api.listUsbDevices());
      if (reset) {
        get().toast({
          level: "error",
          title: "Key file could not be read",
          body: "It was kept as a backup in the data folder. Restore your account from its recovery phrase or backup.",
        });
      }
      if (get().settings.checkUpdates) {
        api.checkForUpdate().then((u) => {
          if (!u.newer || !u.url) return;
          const url = u.url;
          get().toast({
            level: "info", title: `MeshLink ${u.latest} is available`, body: `You have ${u.current}.`,
            action: { label: "View release", run: () => api.openReleasePage(url) },
          });
        }).catch(() => {});
      }
      setInterval(() => set({ now: Date.now() }), 5000);
      setInterval(() => messenger && applyOutputs(messenger.tick()), 500);
      setInterval(() => {
        if (link && isAdmin()) {
          sendFrame(p.buildStatusReq());
          sendFrame(p.buildSessionsReq());
        }
      }, 5000);
      setInterval(sweepDisappearing, 30000);
      sweepDisappearing();
      // USB gets a head start; Wi-Fi fills in when no board shows up.
      scheduleWifi(4000);
    },

    async createIdentity(name) {
      const id = Identity.generate();
      await api.setIdentity(toB64(id.secretKey));
      get().updateSetting("name", name);
      set({ identity: id });
      onUsb(get().usbDevices);
    },

    async restoreFromPhrase(phrase, name) {
      const id = Identity.fromPhrase(phrase);
      await api.setIdentity(toB64(id.secretKey));
      get().updateSetting("name", name);
      set({ identity: id });
      onUsb(get().usbDevices);
    },

    async exportBackup(passphrase, withMessages) {
      const id = get().identity;
      if (!id) return false;
      const messages: StoredMessage[] = [];
      if (withMessages) {
        const convs = [...Object.keys(get().contacts).map(dmConv), ...Object.keys(get().rooms).map(roomConv)];
        for (const conv of convs) messages.push(...(await api.listMessages(conv, 5000)));
      }
      const content: BackupContent = {
        version: 1, createdAt: Date.now(), identity: toB64(id.secretKey), name: get().settings.name,
        contacts: [...contactsMap.values()].map(toStored),
        rooms: Object.values(get().rooms),
        networks: Object.values(get().networks).filter((n) => n.netId !== 0),
        settings: get().settings as unknown as Record<string, unknown>,
        messages: withMessages ? messages : undefined,
      };
      const file = await createBackup(content, passphrase);
      const day = new Date().toISOString().slice(0, 10);
      return api.saveTextFile(`MeshLink-${get().settings.name || "account"}-${day}.meshlink`, file);
    },

    async importBackup(text, passphrase) {
      const b = await openBackup(text, passphrase);
      const id = new Identity(fromB64(b.identity));
      await api.setIdentity(b.identity);
      for (const old of b.contacts as StoredContact[]) {
        // Backups from before protocol v3 hold the old fingerprint and may lack the signing key.
        if (!old.signPk) continue;
        const fp = toHex(fingerprint(fromB64(old.pubkey), fromB64(old.signPk)));
        const c = fp === old.fp ? old : { ...old, fp, verified: false };
        await api.saveContact(c);
        contactsMap.set(c.fp, fromStored(c));
      }
      for (const r of b.rooms as Room[]) await api.saveRecord("room", r.id, r);
      for (const n of b.networks as Network[]) await api.saveRecord("network", netKey(n.netId), n);
      for (const m of (b.messages ?? []) as StoredMessage[]) await api.addMessage(m);
      const settings = { ...defaultSettings, ...(b.settings as Partial<Settings>), name: b.name };
      for (const [k, v] of Object.entries(settings)) await api.setSetting(k, v);
      set({
        identity: id, settings, contacts: Object.fromEntries(contactsMap),
        rooms: Object.fromEntries((b.rooms as Room[]).map((r) => [r.id, r])),
        networks: Object.fromEntries([[netKey(0), OPEN_NETWORK], ...(b.networks as Network[]).map((n) => [netKey(n.netId), n] as const)]),
        messages: {},
      });
      messenger?.setRooms(b.rooms as Room[]);
      onUsb(get().usbDevices);
    },

    updateSetting(key, value) {
      set((s) => ({ settings: { ...s.settings, [key]: value } }));
      api.setSetting(key, value);
      if (key === "name" && messenger) messenger.name = value as string;
      if (key === "stealth" || key === "announceInterval") scheduleAnnounce();
      if (key === "closeToTray") api.setCloseToTray(value as boolean);
      if (key === "launchAtLogin") api.setLaunchAtLogin(value as boolean);
      if (key === "notifyNative" && value && "Notification" in window) Notification.requestPermission().catch(() => {});
    },

    async select(conv) {
      set((s) => ({ selected: conv, unread: conv ? { ...s.unread, [conv]: 0 } : s.unread }));
      updateBadge();
      if (conv && !get().messages[conv]) {
        const list = await api.listMessages(conv, 500);
        set((s) => ({ messages: { ...s.messages, [conv]: list } }));
      }
    },

    async connect(next, opts) {
      await get().disconnect();
      const identity = get().identity!;
      link = next;
      messenger = new Messenger(identity, contactsMap, get().settings.name, sendFrame);
      messenger.setRooms(Object.values(get().rooms));
      set({ conn: { status: "connecting", kind: next.kind, label: next.label }, neighbors: {}, node: { config: null, status: null, sessions: [], bans: [] } });
      try {
        await next.open({
          onEvent,
          onNotice: (n) => get().toast(n),
          onClose: (reason) => {
            link = null;
            messenger = null;
            scheduleAnnounce();
            set({ conn: { status: "disconnected", error: reason } });
            get().toast({ level: "warning", title: next.kind === "lan" ? "Home Wi-Fi disconnected" : "Node disconnected", body: reason });
            scheduleWifi(3000);
          },
        });
      } catch (e) {
        link = null;
        messenger = null;
        set({ conn: { status: "disconnected", error: String(e) } });
        if (!opts?.quiet) get().toast({ level: "error", title: next.kind === "lan" ? "Could not use Home Wi-Fi" : "Could not open node", body: e instanceof Error ? e.message : String(e) });
        return false;
      }
      setTimeout(() => {
        if (link !== next) return;
        sendFrame(p.buildInfoReq());
        if (!get().settings.stealth) messenger?.announce();
        scheduleAnnounce();
        // Say hello in rooms so members learn our key after a restart.
        for (const r of Object.values(get().rooms)) if (r.kind === "private") messenger?.joinRoom(r);
      }, next.kind === "usb" ? 1500 : 300);
      if (next.kind === "usb") {
        setTimeout(() => {
          if (link !== next || get().conn.chipId !== undefined) return;
          get().toast({
            level: "warning",
            title: "No MeshLink firmware found",
            body: `The board on ${next.label} did not answer. Flash MeshLink onto it to use it.`,
            action: { label: "Flash it", run: () => { get().disconnect(); get().setPanel("flasher", true); } },
          });
        }, 5000);
      }
      return true;
    },

    async disconnect() {
      const l = link;
      link = null;
      messenger = null;
      scheduleAnnounce();
      if (l) await l.close();
      set({ conn: { status: "disconnected" } });
    },

    async connectLan() {
      if (!get().settings.experimentalLan) {
        get().toast({ level: "info", title: "Home Wi-Fi is experimental", body: "Turn it on in Settings → Experimental first." });
        return false;
      }
      const n = get().networks[netKey(get().settings.activeNetId)] ?? OPEN_NETWORK;
      return get().connect(new LanLink({ netId: n.netId, key: fromB64(n.key) }, { stealth: get().settings.stealth }));
    },

    async connectCom(com, auto = false) {
      try {
        const port = await requestPortByName(com);
        const bridge = get().usbDevices.find((d) => d.com === com)?.bridge ?? usbBridgeName(port.getInfo().usbVendorId);
        const l = new WebSerialLink(port, bridge ? `${com} · ${bridge}` : com);
        if (!(await get().connect(l, { quiet: auto }))) throw new Error(`${com} is busy or used by another app`);
      } catch (e) {
        autoFailed.add(com);
        const left = get().usbDevices.some((d) => d.com && !d.driverMissing && !autoFailed.has(d.com));
        if (!auto || !left) get().toast({ level: "error", title: `Could not open ${com}`, body: e instanceof Error ? e.message : String(e) });
        if (get().conn.status === "disconnected") onUsb(get().usbDevices);
      }
    },

    async connectWifi(node, opts) {
      const id = get().identity;
      if (!id) return false;
      let ip = opts?.viaLan;
      if (!ip) {
        if (!node.ssid) {
          if (!opts?.quiet) get().toast({ level: "error", title: "No Wi-Fi on this node", body: "Turn on its hotspot in the admin panel (over USB)." });
          return false;
        }
        set({ wifiBusy: `Joining ${node.ssid}…` });
        const r = await api.wifiConnect(node.ssid, node.psk, node.hidden);
        if (!r.ok) {
          set({ wifiBusy: null });
          if (!opts?.quiet) get().toast({ level: "error", title: `Could not join ${node.ssid}`, body: r.message });
          return false;
        }
        ip = "192.168.4.1";
      }
      set({ wifiBusy: `Connecting to ${node.name}…` });
      const l = new WebSocketLink(`ws://${ip}:81/`, `${node.name} · Wi-Fi`, (hello) => id.guestAuth(hello.netId, hello.nonce, hello.chipId));
      const ok = await get().connect(l, { quiet: opts?.quiet });
      set({ wifiBusy: null });
      if (ok) saveNode({ ...node, lastIp: ip, lastSeen: Date.now() });
      else if (!opts?.viaLan) api.wifiRestore();
      return ok;
    },

    async autoConnectWifi() {
      const s = get().settings;
      if (!s.autoWifi || !get().identity || get().conn.status !== "disconnected") return;
      if (get().usbDevices.some((d) => d.com && !d.driverMissing && !autoFailed.has(d.com))) return;
      const known = Object.values(get().knownNodes);
      const nets = new Set(Object.values(get().networks).map((n) => n.netId));
      // 1. A node on the same LAN (it joined home Wi-Fi): no need to leave the internet.
      set({ wifiBusy: "Looking for nodes…" });
      const lan = await api.discoverNodes(1500);
      const onLan = lan.find((d) => known.some((k) => k.chipId === d.chipId) || nets.has(d.netId));
      if (onLan) {
        const k = get().knownNodes[String(onLan.chipId)];
        const node: KnownNode = k ?? { chipId: onLan.chipId, name: onLan.name, netId: onLan.netId, ssid: "", psk: "", hidden: false, lastIp: onLan.ip, lastSeen: Date.now() };
        if (await get().connectWifi(node, { viaLan: onLan.ip, quiet: true })) return;
      }
      // 2. A known node's own hotspot in range.
      if (s.allowHotspot && known.some((k) => k.ssid)) {
        const { networks } = await api.wifiScan();
        const visible = new Set(networks.map((n) => n.ssid));
        const candidates = known
          .filter((k) => k.ssid && (visible.has(k.ssid) || k.hidden))
          .sort((a, b) => (networks.find((n) => n.ssid === b.ssid)?.signal ?? 0) - (networks.find((n) => n.ssid === a.ssid)?.signal ?? 0));
        for (const k of candidates) {
          if (get().conn.status !== "disconnected") break;
          if (await get().connectWifi(k, { quiet: true })) return;
        }
      }
      set({ wifiBusy: null });
    },

    sendText(text) {
      const conv = get().selected;
      if (!conv || !text.trim()) return;
      withMessenger((m) => {
        if (conv.startsWith("dm:")) {
          const c = contactsMap.get(conv.slice(3));
          if (!c) return;
          const msg = m.sendText(c, text);
          addMessage({ ...msg, uid: msg.id });
        } else {
          const r = get().rooms[conv.slice(5)];
          if (!r) return;
          if (get().conn.perm === p.PERM_DM || get().conn.perm === p.PERM_READ) {
            get().toast({ level: "warning", title: "Rooms are limited on this node", body: "The node admin allows you direct messages only." });
            return;
          }
          const msg = m.sendRoomText(r, text);
          addMessage({ ...msg, uid: msg.id, state: "sent" });
        }
      });
    },

    retry(uid) {
      withMessenger((m) => {
        if (m.retry(uid)) setMessageState(uid, "sending");
        else get().toast({ level: "warning", title: "Cannot retry", body: "This message is no longer in the send queue. Send it again." });
      });
    },

    announceNow() {
      withMessenger((m) => {
        m.announce();
        get().toast({ level: "success", title: "Announced", body: "Nearby MeshLink users can now see you." });
      });
    },

    setVerified(fp, verified) {
      const c = contactsMap.get(fp);
      if (!c) return;
      c.verified = verified;
      api.saveContact(toStored(c));
      syncContacts();
    },

    // ---- Rooms ----

    createRoom(name, kind) {
      const id = get().identity;
      if (!id || !name.trim()) return null;
      const netId = get().conn.netId ?? get().settings.activeNetId ?? 0;
      const r = kind === "public" ? publicRoom(netId, name) : privateRoom(netId, name, toHex(id.fp), get().settings.name, toHex(id.signPk));
      if (get().rooms[r.id]) {
        get().select(roomConv(r.id));
        return get().rooms[r.id];
      }
      saveRoom(r);
      messenger?.putRoom(r);
      messenger?.joinRoom(r);
      get().select(roomConv(r.id));
      return r;
    },

    acceptInvite(code) {
      let inv: pl.RoomInvite;
      try {
        inv = pl.decodeRoomInvite(code);
      } catch (e) {
        get().toast({ level: "error", title: "Invite not accepted", body: (e as Error).message });
        return;
      }
      const r = messenger ? messenger.acceptInvite(inv) : roomFromInvite(inv);
      saveRoom(r);
      set((s) => ({ invites: s.invites.filter((i) => i.code !== code) }));
      get().select(roomConv(r.id));
      if (inv.netId !== (get().conn.netId ?? 0)) {
        const n = get().networks[netKey(inv.netId)];
        get().toast({ level: "warning", title: "Room is on another network", body: `Messages arrive when you are on ${n ? `"${n.name}"` : "that network"}.` });
      }
    },

    declineInvite(code) {
      set((s) => ({ invites: s.invites.filter((i) => i.code !== code) }));
    },

    roomInviteCode(roomId, hours) {
      const r = get().rooms[roomId];
      const id = get().identity!;
      if (!r) return "";
      if (r.kind === "public") return `#${r.name}`;
      // Pass on the creator's signing key so joiners can pin it.
      const mine = !r.creatorFp || r.creatorFp === toHex(id.fp);
      const creatorPkHex = mine ? toHex(id.signPk)
        : (contactsMap.get(r.creatorFp)?.signPk ? toHex(contactsMap.get(r.creatorFp)!.signPk!) : r.creatorSignPk || r.members[r.creatorFp]?.signPk || "");
      return pl.encodeRoomInvite({
        roomId: roomIdBytes(r), key: roomKey(r), epoch: r.epoch, netId: r.netId,
        expires: hours ? Math.floor(Date.now() / 1000) + hours * 3600 : 0, name: r.name, creatorFp: r.creatorFp ? fromHex(r.creatorFp) : id.fp,
        creatorSignPk: creatorPkHex ? fromHex(creatorPkHex) : null,
      }, id);
    },

    inviteContact(roomId, fp) {
      const c = contactsMap.get(fp);
      if (!c) return;
      withMessenger((m) => {
        m.sendRoomInvite(c, get().roomInviteCode(roomId, 72));
        get().toast({ level: "success", title: "Invite sent", body: `${c.name} gets the invite as an encrypted message.` });
      });
    },

    leaveRoom(roomId) {
      const r = get().rooms[roomId];
      if (!r) return;
      messenger?.leaveRoom(r);
      messenger?.removeRoom(roomId);
      api.deleteRecord("room", roomId);
      api.deleteConversation(roomConv(roomId));
      set((s) => {
        const rooms = { ...s.rooms };
        delete rooms[roomId];
        return { rooms, selected: s.selected === roomConv(roomId) ? null : s.selected };
      });
    },

    kickMember(roomId, fp) {
      const r = get().rooms[roomId];
      if (!r) return;
      withMessenger((m) => {
        const { room, unreachable } = m.kickFromRoom(r, fp);
        saveRoom(room);
        get().toast({
          level: unreachable.length ? "warning" : "success", title: "Member removed, new room key sent",
          body: unreachable.length ? `Could not send the new key to: ${unreachable.join(", ")}. Send them a new invite.` : undefined,
        });
      });
    },

    setModerator(roomId, fp, on) {
      const r = get().rooms[roomId];
      if (!r) return;
      withMessenger((m) => {
        m.setModerator(r, fp, on);
        const members = { ...r.members, [fp]: { ...(r.members[fp] ?? { fp, name: contactsMap.get(fp)?.name ?? "", signPk: "", lastSeen: 0 }), role: on ? "moderator" as const : "member" as const } };
        const next = { ...r, members };
        saveRoom(next);
        m.putRoom(next);
      });
    },

    muteMember(roomId, fp, on) {
      const r = get().rooms[roomId];
      if (!r?.members[fp]) return;
      const next = { ...r, members: { ...r.members, [fp]: { ...r.members[fp], muted: on } } };
      saveRoom(next);
      messenger?.putRoom(next);
    },

    deleteMessage(conv, uid) {
      if (conv.startsWith("room:")) {
        const r = get().rooms[conv.slice(5)];
        if (r && messenger) messenger.deleteRoomMessage(r, uid);
      }
      removeMessage(conv, uid);
    },

    updateRoom(roomId, patch) {
      const r = get().rooms[roomId];
      if (!r) return;
      const next = { ...r, ...patch };
      saveRoom(next);
      messenger?.putRoom(next);
    },

    openRoomDialog(roomId, tab = "invite") {
      set({ roomDialog: roomId ? { roomId, tab } : null });
    },

    // ---- Networks ----

    createNetwork(name, channel) {
      const n = createNetwork(name, channel);
      saveNetwork(n);
      get().updateSetting("activeNetId", n.netId);
      return n;
    },

    joinNetwork(code) {
      const n = networkFromInvite(pl.decodeNetworkInvite(code));
      const existing = get().networks[netKey(n.netId)];
      // An invite must not swap the key or owner of a network we already have:
      // a crafted code could otherwise hand ban control to someone else.
      if (existing && (existing.key !== n.key || (existing.ownerPk ?? null) !== (n.ownerPk ?? null))) {
        throw new Error(`This code has a different key for "${existing.name}". Leave that network first if you trust the code.`);
      }
      const merged = existing ? { ...n, ownerSecret: existing.ownerSecret, bans: existing.bans, policySeq: existing.policySeq } : n;
      saveNetwork(merged);
      get().updateSetting("activeNetId", n.netId);
      get().toast({ level: "success", title: `Joined "${n.name}"`, body: "Connect a node on this network, or add one of yours to it over USB." });
      return merged;
    },

    leaveNetwork(netId) {
      if (netId === 0) return;
      api.deleteRecord("network", netKey(netId));
      set((s) => {
        const networks = { ...s.networks };
        delete networks[netKey(netId)];
        return { networks };
      });
      if (get().settings.activeNetId === netId) get().updateSetting("activeNetId", 0);
    },

    networkCode(netId) {
      const n = get().networks[netKey(netId)];
      return n ? pl.encodeNetworkInvite(inviteOf(n)) : "";
    },

    inviteToNetwork(fp, netId) {
      const c = contactsMap.get(fp);
      if (!c) return;
      withMessenger((m) => {
        m.sendNetworkInvite(c, get().networkCode(netId));
        get().toast({ level: "success", title: "Network shared", body: `${c.name} gets the network code as an encrypted message.` });
      });
    },

    provisionNode(netId) {
      if (!isAdmin()) return;
      const n = get().networks[netKey(netId)];
      if (!n) return;
      sendFrame(p.buildConfigSet({
        netId: n.netId, netKey: fromB64(n.key), netName: n.name, ownerPk: n.ownerPk ? fromB64(n.ownerPk) : null,
        policySeq: n.policySeq,
      }));
      if (n.channel !== (get().node.config?.channel ?? 6)) {
        // Channel change restarts the node's radio.
        setTimeout(() => sendFrame(p.buildConfigSet({ channel: n.channel })), 300);
      }
      get().toast({ level: "success", title: `Node joined "${n.name}"`, body: "Only nodes with this network's key can now read its traffic tags." });
      setTimeout(() => sendFrame(p.buildInfoReq()), 600);
    },

    policyBan(netId, kind, idHex, note, unban = false) {
      const n = get().networks[netKey(netId)];
      if (!n?.ownerSecret) {
        get().toast({ level: "error", title: "Only the network owner can do this", body: "Ask the owner, or ban on your own node instead." });
        return;
      }
      const id = fromHex(idHex);
      withMessenger(() => {
        const seq = Math.max(n.policySeq + 1, Math.floor(Date.now() / 1000));
        const body = pl.packPolicy(n.netId, seq, [{ op: unban ? "unban" : "ban", kind, id }], fromB64(n.ownerSecret!));
        sendFrame(p.buildSend(p.AIR_POLICY, body, p.FLAG_PRIORITY));
        const bans = n.bans.filter((b) => !(b.kind === kind && b.id === idHex));
        if (!unban) bans.push({ kind, id: idHex, note, at: Date.now() });
        saveNetwork({ ...n, bans, policySeq: seq });
        get().toast({ level: "success", title: unban ? "Unban sent to the network" : "Ban sent to the network", body: "Every node that hears it applies it." });
      });
    },

    // ---- Node admin (USB) ----

    refreshNode() {
      if (!link || !isAdmin()) return;
      for (const f of [p.buildConfigGet(), p.buildStatusReq(), p.buildSessionsReq(), p.buildBansReq()]) sendFrame(f);
    },

    setNodeConfig(patch) {
      if (!isAdmin()) return;
      sendFrame(p.buildConfigSet(patch));
      const restarts = ["channel", "apSsid", "apPsk", "apHidden", "apEnabled", "apOpen", "staSsid", "staPsk", "stealth"].some((k) => k in patch);
      if (restarts) get().toast({ level: "info", title: "Node restarting", body: "Wi-Fi settings apply after a restart. It reconnects by itself." });
    },

    kickGuest(pseudo) {
      if (isAdmin()) sendFrame(p.buildKick(fromHex(pseudo)));
    },

    banGuest(pseudo) {
      if (isAdmin()) sendFrame(p.buildBan(p.BAN_GUEST, fromHex(pseudo)));
    },

    nodeBan(kind, idHex, unban = false) {
      if (!isAdmin()) return;
      const id = kind === p.BAN_GUEST ? fromHex(idHex) : u32le(parseInt(idHex, 16));
      sendFrame(unban ? p.buildUnban(kind, id) : p.buildBan(kind, id));
    },

    setGuestPerm(pseudo, perm) {
      if (isAdmin()) sendFrame(p.buildSetPerm(fromHex(pseudo), perm));
    },

    rebootNode() {
      if (isAdmin()) sendFrame(p.buildReboot());
    },

    factoryResetNode() {
      if (isAdmin()) sendFrame(p.buildFactoryReset());
    },

    forgetNode(chipId) {
      api.deleteRecord("node", String(chipId));
      set((s) => {
        const knownNodes = { ...s.knownNodes };
        delete knownNodes[String(chipId)];
        return { knownNodes };
      });
    },

    // ---- Misc ----

    setPanel(panel, open) {
      set((s) => ({ panels: { ...s.panels, [panel]: open } }));
    },

    toast(t) {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
      setTimeout(() => get().dismissToast(id), t.level === "warning" || t.level === "error" ? 9000 : 5000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    async installDrivers(bridges) {
      if (get().driverInstall === "running") return;
      set({ driverInstall: "running" });
      const r = await api.installDrivers(bridges);
      set({ driverInstall: "idle" });
      get().toast({ level: r.ok ? "success" : "error", title: r.ok ? "Driver ready" : "Driver not installed", body: r.message });
    },

    async wipe() {
      await get().disconnect();
      await api.wipeAll();
    },
  };
});

export function presence(c: Contact, now: number, announceInterval: number): "online" | "idle" | "offline" {
  const age = (now - c.lastSeen) / 1000;
  if (age < announceInterval * 2.5) return "online";
  if (age < 15 * 60) return "idle";
  return "offline";
}

export { dmConv, roomConv, netKey };
