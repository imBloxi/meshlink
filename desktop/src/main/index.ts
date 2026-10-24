import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainEvent, type IpcMainInvokeEvent,
} from "electron";
import type { FirmwareManifest, MessageState, RecordKind, StoredContact, StoredMessage, UsbBridge } from "../shared/api";
import { Store } from "./store";
import * as updates from "./updates";
import { availableDrivers, installDrivers, UsbWatcher } from "./usb";
import * as wifi from "./wifi";

// --profile=<name>: separate identity and data, e.g. to run two nodes on one PC.
const profile = process.argv.find((a) => a.startsWith("--profile="))?.slice(10);
if (profile && /^[\w-]{1,32}$/.test(profile)) {
  app.setPath("userData", join(app.getPath("appData"), "MeshLink", "profiles", profile));
}
// --test-hooks: expose app internals on window for automated hardware tests.
const testHooks = process.argv.includes("--test-hooks");

let store: Store;
let pendingSerial: ((portId: string) => void) | null = null;
let autoPick: string | null = null; // COM name to answer the next requestPort() with
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let closeToTray = false;
let quitting = false;
const usb = new UsbWatcher((devices) => mainWindow?.webContents.send("usb:devices", devices));

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: "#0B0F14",
    title: profile ? `MeshLink (${profile})` : "MeshLink",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (mainWindow = null));
  // Keep running in the tray so messages keep arriving.
  win.on("close", (e) => {
    if (closeToTray && !quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  const ses = win.webContents.session;
  // Web Serial: let the renderer draw its own port picker.
  ses.on("select-serial-port", (event, portList, _wc, callback) => {
    event.preventDefault();
    if (autoPick) {
      // Auto-connect: answer silently with the port Windows reported for the board.
      const port = portList.find((p) => p.portName === autoPick);
      autoPick = null;
      callback(port?.portId ?? "");
      return;
    }
    pendingSerial?.("");
    pendingSerial = callback;
    win.webContents.send("serial:ports", portList.map((p) => ({
      portId: p.portId, portName: p.portName, displayName: p.displayName,
      vendorId: p.vendorId, productId: p.productId,
    })));
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === "serial");
  ses.setDevicePermissionHandler((details) => details.deviceType === "serial");

  // Never navigate away from the app; open links in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  const query = { ...(testHooks ? { testHooks: "1" } : {}), ...(profile ? { profile } : {}) };
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${new URLSearchParams(query)}`);
  else win.loadFile(join(__dirname, "../renderer/index.html"), { query });
}

/** Firmware shipped next to the app: resources/firmware in dev, <install>/resources/firmware when packaged. */
function loadFirmware() {
  const dir = app.isPackaged ? join(process.resourcesPath, "firmware") : join(app.getAppPath(), "resources/firmware");
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as FirmwareManifest;
  const data = readFileSync(join(dir, manifest.file));
  if (createHash("sha256").update(data).digest("hex") !== manifest.sha256) {
    throw new Error("Bundled firmware is corrupted (sha256 mismatch). Reinstall MeshLink.");
  }
  return { manifest, data: new Uint8Array(data) };
}

/**
 * Only our own top-level page may call the main process. Defense in depth: if
 * an iframe or a page we navigated to by mistake ever ran script, it still
 * could not read keys or run netsh/pnputil.
 */
function trustedSender(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  if (!mainWindow || e.sender !== mainWindow.webContents || !frame || frame.parent) return false;
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev && !app.isPackaged) return frame.url.startsWith(dev);
  return frame.url.startsWith(pathToFileURL(join(__dirname, "../renderer/index.html")).href);
}

type Handler = (e: IpcMainInvokeEvent, ...args: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
type Listener = (e: IpcMainEvent, ...args: any[]) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trustedSender(e)) throw new Error(`Blocked IPC "${channel}" from ${e.senderFrame?.url ?? "unknown"}`);
    return fn(e, ...args);
  });
}

function on(channel: string, fn: Listener) {
  ipcMain.on(channel, (e, ...args) => {
    if (trustedSender(e)) fn(e, ...args);
  });
}

function registerIpc() {
  handle("app:info", () => updates.appInfo());
  handle("update:check", () => updates.checkForUpdate());
  handle("update:open", (_e, url: string) => updates.openReleasePage(String(url)));
  handle("firmware:get", () => loadFirmware());
  handle("secrets:reset", () => store.secretsReset);
  handle("identity:get", () => store.getIdentity());
  handle("identity:set", (_e, sk: string) => store.setIdentity(sk));
  handle("settings:get", () => store.getSettings());
  handle("settings:set", (_e, key: string, value: unknown) => store.setSetting(key, value));
  handle("contacts:list", () => store.listContacts());
  handle("contacts:save", (_e, c: StoredContact) => store.saveContact(c));
  handle("messages:list", (_e, conv: string, limit: number) => store.listMessages(conv, limit));
  handle("messages:add", (_e, m: StoredMessage) => store.addMessage(m));
  handle("messages:state", (_e, uid: string, state: MessageState) => store.updateMessageState(uid, state));
  handle("messages:delete", (_e, uid: string) => store.deleteMessage(uid));
  handle("messages:deleteBefore", (_e, conv: string, ts: number) => store.deleteMessagesBefore(conv, ts));
  handle("messages:deleteConv", (_e, conv: string) => store.deleteConversation(conv));
  handle("records:list", (_e, kind: RecordKind) => store.listRecords(kind));
  handle("records:save", (_e, kind: RecordKind, id: string, data: unknown) => store.saveRecord(kind, id, data));
  handle("records:delete", (_e, kind: RecordKind, id: string) => store.deleteRecord(kind, id));
  handle("wifi:scan", () => wifi.scan());
  handle("wifi:current", () => wifi.current());
  handle("wifi:connect", (_e, ssid: string, psk: string, hidden: boolean) => wifi.connect(ssid, psk, hidden));
  handle("wifi:restore", () => wifi.restore());
  handle("nodes:discover", (_e, ms: number) => wifi.discover(Math.min(ms, 5000)));
  handle("file:save", async (_e, name: string, text: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: name, filters: [{ name: "MeshLink backup", extensions: ["meshlink"] }],
    });
    if (r.canceled || !r.filePath) return false;
    writeFileSync(r.filePath, text, "utf8");
    return true;
  });
  handle("file:open", async () => {
    const r = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"], filters: [{ name: "MeshLink backup", extensions: ["meshlink", "json"] }],
    });
    return r.canceled || !r.filePaths[0] ? null : readFileSync(r.filePaths[0], "utf8");
  });
  handle("app:openLocationSettings", () => shell.openExternal("ms-settings:privacy-location"));
  handle("app:loginItem", (_e, on: boolean) => app.setLoginItemSettings({ openAtLogin: on, args: ["--hidden"] }));
  handle("app:closeToTray", (_e, on: boolean) => {
    closeToTray = on;
    if (on) ensureTray();
    else {
      tray?.destroy();
      tray = null;
    }
  });
  on("app:badge", (_e, count: number) => {
    tray?.setToolTip(count ? `MeshLink: ${count} unread` : "MeshLink");
    if (mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(count > 0);
  });
  handle("wipe", () => {
    store.wipeAll();
    app.relaunch();
    app.exit(0);
  });
  handle("usb:list", () => usb.devices);
  handle("drivers:available", () => availableDrivers());
  handle("drivers:install", (_e, bridges: UsbBridge[]) => installDrivers(bridges));
  on("serial:autopick", (e, portName: string) => {
    autoPick = portName;
    // requestPort() needs a user gesture; this call is made on behalf of the app's own auto-connect.
    e.sender.executeJavaScript("window.__meshlinkAutoPick && window.__meshlinkAutoPick()", true);
  });
  on("serial:choose", (_e, portId: string) => {
    pendingSerial?.(portId);
    pendingSerial = null;
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  mainWindow?.show();
  mainWindow?.focus();
}

const TRAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="#2EE6A6"/></svg>';

function ensureTray() {
  if (tray) return;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(TRAY_SVG).toString("base64")}`);
  tray = new Tray(icon);
  tray.setToolTip("MeshLink");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open MeshLink", click: showWindow },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

// One app instance per profile: a second launch focuses the first window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(() => {
    store = new Store(join(app.getPath("userData"), "data"));
    closeToTray = !!store.getSettings().closeToTray;
    registerIpc();
    createWindow();
    if (closeToTray) ensureTray();
    if (closeToTray && process.argv.includes("--hidden")) mainWindow?.once("ready-to-show", () => mainWindow?.hide());
    usb.start();
  });
}

// No <webview> tags and no extra windows, ever.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-attach-webview", (e) => e.preventDefault());
});

app.on("before-quit", () => (quitting = true));
app.on("window-all-closed", () => {
  usb.stop();
  wifi.restore().finally(() => app.quit());
});
