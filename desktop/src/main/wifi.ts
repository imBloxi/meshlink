// Wi-Fi control on Windows through netsh, and LAN discovery of nodes.
//
// netsh output is localized, so parsing relies only on stable tokens:
// "SSID <n> :" lines, "<number>%" signal values and the interface "SSID :" line.
import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredNode, WifiNetwork } from "../shared/api";

function netsh(args: string[], timeout = 15000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("netsh.exe", args, { windowsHide: true, timeout, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

export async function scan(): Promise<{ networks: WifiNetwork[]; error?: string }> {
  if (process.platform !== "win32") return { networks: [], error: "no-wifi" };
  const { code, out } = await netsh(["wlan", "show", "networks", "mode=bssid"]);
  // Windows 11 24H2+: Wi-Fi scans need Location services turned on.
  if (/location/i.test(out) && !/SSID \d+/.test(out)) return { networks: [], error: "location" };
  if (code !== 0 && !/SSID \d+/.test(out)) return { networks: [], error: /wlansvc|not running|no wireless/i.test(out) ? "no-wifi" : out.trim().split("\n")[0] };
  const networks: WifiNetwork[] = [];
  let cur: WifiNetwork | null = null;
  for (const line of out.split(/\r?\n/)) {
    const ssid = line.match(/^SSID \d+ : (.*)$/);
    if (ssid) {
      cur = { ssid: ssid[1].trim(), signal: 0, secured: true };
      networks.push(cur);
      continue;
    }
    if (!cur) continue;
    const pct = line.match(/:\s*(\d{1,3})%\s*$/);
    if (pct) cur.signal = Math.max(cur.signal, Number(pct[1]));
    if (/:\s*(Open|Open system|Openen|Ouvrir|Offen)\s*$/i.test(line)) cur.secured = false;
  }
  return { networks: networks.filter((n) => n.ssid) };
}

export async function current(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  const { out } = await netsh(["wlan", "show", "interfaces"]);
  const m = out.match(/^\s*SSID\s*: (.+)$/m); // "BSSID" lines do not match: they start with B.
  return m ? m[1].trim() : null;
}

const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function profileXml(ssid: string, psk: string, hidden: boolean) {
  const hex = Buffer.from(ssid, "utf8").toString("hex").toUpperCase();
  const security = psk
    ? `<authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
       <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(psk)}</keyMaterial></sharedKey>`
    : `<authEncryption><authentication>open</authentication><encryption>none</encryption><useOneX>false</useOneX></authEncryption>`;
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${xmlEscape(ssid)}</name>
  <SSIDConfig><SSID><hex>${hex}</hex><name>${xmlEscape(ssid)}</name></SSID><nonBroadcast>${hidden}</nonBroadcast></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>manual</connectionMode>
  <MSM><security>${security}</security></MSM>
</WLANProfile>`;
}

let previous: string | null = null;
let joinedNode = false;
// Wi-Fi profile we added for a node. Removed again when we leave, so Windows
// does not keep the node's name and password (or offer to rejoin it).
let addedProfile: string | null = null;

async function forgetProfile() {
  if (!addedProfile) return;
  const name = addedProfile;
  addedProfile = null;
  await netsh(["wlan", "delete", "profile", `name=${name}`]);
}

/** True when Windows hides Wi-Fi details because Location is off (Windows 11 24H2+). */
async function locationBlocked(): Promise<boolean> {
  const { out } = await netsh(["wlan", "show", "interfaces"]);
  return /location/i.test(out) && !/^\s*SSID\s*:/m.test(out);
}

/** Join a node's hotspot. Remembers the Wi-Fi the PC was on. */
export async function connect(ssid: string, psk: string, hidden: boolean): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== "win32") return { ok: false, message: "Wi-Fi control needs Windows." };
  const now = await current();
  if (now === ssid) return { ok: true, message: `Already on ${ssid}.` };
  if (now && !now.startsWith("MeshLink-")) previous = now;
  // The profile file holds the password: write it to temp, import, delete at once.
  const file = join(tmpdir(), `ml-wifi-${process.pid}-${Date.now()}.xml`);
  try {
    writeFileSync(file, profileXml(ssid, psk, hidden), { encoding: "utf8", mode: 0o600 });
    const add = await netsh(["wlan", "add", "profile", `filename=${file}`, "user=current"]);
    if (add.code !== 0) return { ok: false, message: add.out.trim().split("\n")[0] || "Could not add the Wi-Fi profile." };
    addedProfile = ssid;
  } finally {
    rmSync(file, { force: true });
  }
  const res = await netsh(["wlan", "connect", `name=${ssid}`, `ssid=${ssid}`]);
  if (res.code !== 0) {
    await forgetProfile();
    return { ok: false, message: res.out.trim().split("\n")[0] || "Could not connect." };
  }
  joinedNode = true;
  // Wait for association and DHCP. Without Location access Windows hides the
  // SSID, so ask the node itself (UDP discovery on its hotspot address).
  const blind = await locationBlocked();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 750));
    const ok = blind
      ? (await discover(600)).some((d) => d.ip === "192.168.4.1")
      : (await current()) === ssid;
    if (ok) {
      await new Promise((r) => setTimeout(r, blind ? 300 : 1500));
      return { ok: true, message: `Connected to ${ssid}.` };
    }
  }
  await restore();
  return { ok: false, message: `${ssid} did not accept the connection. Is the node in range?` };
}

/** Go back to the Wi-Fi the PC used before joining a node. */
export async function restore(): Promise<void> {
  if (!joinedNode || process.platform !== "win32") return;
  joinedNode = false;
  const name = previous;
  previous = null;
  // Unknown previous network (Location off): disconnect, and Windows rejoins
  // its usual network by itself. Node profiles are manual, so it never picks those.
  await netsh(name ? ["wlan", "connect", `name=${name}`] : ["wlan", "disconnect"]);
  await forgetProfile();
}

/** Ask nodes on the local network to identify themselves (UDP 4210). */
export function discover(timeoutMs: number): Promise<DiscoveredNode[]> {
  return new Promise((resolve) => {
    const found = new Map<string, DiscoveredNode>();
    const sock = createSocket({ type: "udp4", reuseAddr: true });
    const done = () => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve([...found.values()]);
    };
    sock.on("error", done);
    sock.on("message", (msg, rinfo) => {
      if (msg.length < 15 || msg.subarray(0, 6).toString() !== "MLNODE") return;
      const nameLen = msg[14];
      found.set(rinfo.address, {
        ip: rinfo.address, chipId: msg.readUInt32LE(6), netId: msg.readUInt32LE(10),
        name: msg.subarray(15, 15 + nameLen).toString("utf8"),
      });
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const probe = Buffer.from("MLDISCOVER");
      // Broadcast on the LAN, plus the address a node has on its own hotspot.
      for (const host of ["255.255.255.255", "192.168.4.1"]) sock.send(probe, 4210, host, () => {});
      setTimeout(done, timeoutMs);
    });
  });
}
