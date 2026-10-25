// Host API: Electron preload when available, otherwise a localStorage fallback
// so the renderer also runs in a plain browser for UI development.
// The fallback is NOT secure: it stores keys and messages in plain text.
import type { MeshlinkApi, RecordKind, StoredContact, StoredMessage } from "@shared/api";

function webFallback(): MeshlinkApi {
  const ns = `meshlink:${new URLSearchParams(location.search).get("profile") ?? "default"}:`;
  const get = <T,>(k: string, d: T): T => {
    try {
      const v = localStorage.getItem(ns + k);
      return v ? (JSON.parse(v) as T) : d;
    } catch {
      return d;
    }
  };
  const set = (k: string, v: unknown) => {
    try {
      localStorage.setItem(ns + k, JSON.stringify(v));
    } catch {
      /* storage blocked: session only */
    }
  };
  return {
    platform: "web",
    getAppInfo: async () => ({ version: __APP_VERSION__, platform: "browser", packaged: false, repo: "https://github.com/imBloxi/meshlink" }),
    checkForUpdate: async () => ({ current: __APP_VERSION__, latest: null, newer: false, error: "Update checks need the desktop app." }),
    openReleasePage: async () => {},
    getIdentity: async () => get<string | null>("identity", null),
    setIdentity: async (sk) => set("identity", sk),
    getSettings: async () => get("settings", {}),
    setSetting: async (k, v) => set("settings", { ...get("settings", {}), [k]: v }),
    listContacts: async () => get<StoredContact[]>("contacts", []),
    saveContact: async (c) => set("contacts", [...get<StoredContact[]>("contacts", []).filter((x) => x.fp !== c.fp), c]),
    listMessages: async (conv, limit) => get<StoredMessage[]>("messages", []).filter((m) => m.conv === conv).slice(-limit),
    addMessage: async (m) => {
      const all = get<StoredMessage[]>("messages", []);
      if (!all.some((x) => x.uid === m.uid)) set("messages", [...all, m]);
    },
    updateMessageState: async (uid, state) => set("messages", get<StoredMessage[]>("messages", []).map((m) => (m.uid === uid ? { ...m, state } : m))),
    deleteMessage: async (uid) => set("messages", get<StoredMessage[]>("messages", []).filter((m) => m.uid !== uid)),
    deleteMessagesBefore: async (conv, ts) => {
      const all = get<StoredMessage[]>("messages", []);
      const keep = all.filter((m) => m.conv !== conv || m.ts >= ts);
      set("messages", keep);
      return all.length - keep.length;
    },
    deleteConversation: async (conv) => set("messages", get<StoredMessage[]>("messages", []).filter((m) => m.conv !== conv)),
    listRecords: async <T,>(kind: RecordKind) => Object.values(get<Record<string, T>>(`rec:${kind}`, {})),
    saveRecord: async (kind, id, data) => set(`rec:${kind}`, { ...get(`rec:${kind}`, {}), [id]: data }),
    deleteRecord: async (kind, id) => {
      const all = get<Record<string, unknown>>(`rec:${kind}`, {});
      delete all[id];
      set(`rec:${kind}`, all);
    },
    wifiScan: async () => ({ networks: [], error: "no-wifi" }),
    wifiCurrent: async () => null,
    wifiConnect: async () => ({ ok: false, message: "Wi-Fi control needs the desktop app." }),
    wifiRestore: async () => {},
    discoverNodes: async () => [],
    lanOpen: async () => ({ ok: false, message: "Home Wi-Fi needs the desktop app." }),
    lanSend: () => {},
    lanClose: () => {},
    onLanDatagram: () => () => {},
    onLanClosed: () => () => {},
    saveTextFile: async (name, text) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      a.download = name;
      a.click();
      return true;
    },
    openTextFile: () => new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.onchange = () => input.files?.[0]?.text().then(resolve) ?? resolve(null);
      input.click();
    }),
    openLocationSettings: async () => {},
    setLaunchAtLogin: async () => {},
    setCloseToTray: async () => {},
    setUnreadBadge: () => {},
    getFirmware: async () => null,
    listUsbDevices: async () => [],
    onUsbDevices: () => () => {},
    availableDrivers: async () => [],
    installDrivers: async () => ({ ok: false, message: "Driver install needs the desktop app." }),
    autoPickPort: () => {},
    secretsWereReset: async () => false,
    wipeAll: async () => {
      for (const k of Object.keys(localStorage)) if (k.startsWith(ns)) localStorage.removeItem(k);
      location.reload();
    },
    onSerialPorts: () => () => {},
    chooseSerialPort: () => {},
  };
}

export const api: MeshlinkApi = window.meshlink ?? webFallback();
