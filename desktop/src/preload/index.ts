import { contextBridge, ipcRenderer } from "electron";
import type { MeshlinkApi, SerialPortChoice, UsbDevice } from "../shared/api";

const api: MeshlinkApi = {
  platform: "electron",
  getAppInfo: () => ipcRenderer.invoke("app:info"),
  checkForUpdate: () => ipcRenderer.invoke("update:check"),
  openReleasePage: (url) => ipcRenderer.invoke("update:open", url),
  getIdentity: () => ipcRenderer.invoke("identity:get"),
  setIdentity: (sk) => ipcRenderer.invoke("identity:set", sk),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSetting: (key, value) => ipcRenderer.invoke("settings:set", key, value),
  listContacts: () => ipcRenderer.invoke("contacts:list"),
  saveContact: (c) => ipcRenderer.invoke("contacts:save", c),
  listMessages: (conv, limit) => ipcRenderer.invoke("messages:list", conv, limit),
  addMessage: (m) => ipcRenderer.invoke("messages:add", m),
  updateMessageState: (uid, state) => ipcRenderer.invoke("messages:state", uid, state),
  deleteMessage: (uid) => ipcRenderer.invoke("messages:delete", uid),
  deleteMessagesBefore: (conv, ts) => ipcRenderer.invoke("messages:deleteBefore", conv, ts),
  deleteConversation: (conv) => ipcRenderer.invoke("messages:deleteConv", conv),
  listRecords: (kind) => ipcRenderer.invoke("records:list", kind),
  saveRecord: (kind, id, data) => ipcRenderer.invoke("records:save", kind, id, data),
  deleteRecord: (kind, id) => ipcRenderer.invoke("records:delete", kind, id),
  wifiScan: () => ipcRenderer.invoke("wifi:scan"),
  wifiCurrent: () => ipcRenderer.invoke("wifi:current"),
  wifiConnect: (ssid, psk, hidden) => ipcRenderer.invoke("wifi:connect", ssid, psk, hidden),
  wifiRestore: () => ipcRenderer.invoke("wifi:restore"),
  discoverNodes: (ms) => ipcRenderer.invoke("nodes:discover", ms),
  saveTextFile: (name, text) => ipcRenderer.invoke("file:save", name, text),
  openTextFile: () => ipcRenderer.invoke("file:open"),
  openLocationSettings: () => ipcRenderer.invoke("app:openLocationSettings"),
  setLaunchAtLogin: (on) => ipcRenderer.invoke("app:loginItem", on),
  setCloseToTray: (on) => ipcRenderer.invoke("app:closeToTray", on),
  setUnreadBadge: (n) => ipcRenderer.send("app:badge", n),
  getFirmware: () => ipcRenderer.invoke("firmware:get"),
  secretsWereReset: () => ipcRenderer.invoke("secrets:reset"),
  listUsbDevices: () => ipcRenderer.invoke("usb:list"),
  onUsbDevices: (cb) => {
    const handler = (_e: unknown, devices: UsbDevice[]) => cb(devices);
    ipcRenderer.on("usb:devices", handler);
    return () => ipcRenderer.off("usb:devices", handler);
  },
  availableDrivers: () => ipcRenderer.invoke("drivers:available"),
  installDrivers: (bridges) => ipcRenderer.invoke("drivers:install", bridges),
  autoPickPort: (portName) => ipcRenderer.send("serial:autopick", portName),
  wipeAll: () => ipcRenderer.invoke("wipe"),
  onSerialPorts: (cb) => {
    const handler = (_e: unknown, ports: SerialPortChoice[]) => cb(ports);
    ipcRenderer.on("serial:ports", handler);
    return () => ipcRenderer.off("serial:ports", handler);
  },
  chooseSerialPort: (portId) => ipcRenderer.send("serial:choose", portId),
};

contextBridge.exposeInMainWorld("meshlink", api);
