// Watch for ESP boards on USB and install missing USB-serial drivers.
//
// Detection: one long-lived PowerShell process polls WMI every 2 s and prints
// a JSON line whenever the set of known USB-serial bridges changes. WMI also
// lists devices whose driver is missing (ConfigManagerErrorCode 28), which the
// Web Serial API cannot see at all.
//
// Drivers: signed vendor INF packages shipped in resources/drivers are added
// with `pnputil /add-driver ... /install`, elevated through one UAC prompt.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { UsbBridge, UsbDevice } from "../shared/api";

const BRIDGES: Record<string, UsbBridge> = {
  "1A86": "CH340",
  "10C4": "CP210x",
  "0403": "FTDI",
  "303A": "Espressif",
};

const WATCH_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$last = ''
while ($true) {
  $devs = @(Get-CimInstance Win32_PnPEntity -Filter "DeviceID LIKE 'USB\\\\VID_1A86%' OR DeviceID LIKE 'USB\\\\VID_10C4%' OR DeviceID LIKE 'FTDIBUS%' OR DeviceID LIKE 'USB\\\\VID_303A%'" |
    ForEach-Object {
      $com = $null
      if ($_.Name -match '\\((COM\\d+)\\)') { $com = $Matches[1] }
      [pscustomobject]@{ id = $_.DeviceID; name = $_.Name; err = [int]$_.ConfigManagerErrorCode; com = $com }
    })
  $json = ConvertTo-Json -InputObject $devs -Compress
  if ($json -ne $last) { [Console]::Out.WriteLine($json); [Console]::Out.Flush(); $last = $json }
  Start-Sleep -Seconds 2
}`;

interface RawDevice {
  id: string;
  name: string | null;
  err: number;
  com: string | null;
}

function toDevice(r: RawDevice): UsbDevice | null {
  const m = r.id.match(/VID_([0-9A-F]{4})[&+]PID_([0-9A-F]{4})/i);
  if (!m) return null;
  const bridge = BRIDGES[m[1].toUpperCase()];
  if (!bridge) return null;
  return {
    id: r.id,
    name: r.name ?? "Unknown USB serial device",
    bridge,
    vid: m[1].toUpperCase(),
    pid: m[2].toUpperCase(),
    com: r.com,
    // 28 = no driver installed; other non-zero codes = driver problem.
    driverMissing: r.err === 28 || r.err === 1 || r.err === 18,
    error: r.err,
  };
}

export class UsbWatcher {
  private proc: ChildProcess | null = null;
  devices: UsbDevice[] = [];

  constructor(private onChange: (devices: UsbDevice[]) => void) {}

  start() {
    if (process.platform !== "win32" || this.proc) return;
    this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WATCH_SCRIPT], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let buf = "";
    this.proc.stdout!.setEncoding("utf8");
    this.proc.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const raw = JSON.parse(line) as RawDevice[] | RawDevice | null;
          const list = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
          // FTDI shows up twice (USB + FTDIBUS); keep the entry with a COM port.
          const devs = list.map(toDevice).filter((d): d is UsbDevice => !!d);
          this.devices = devs.filter((d) => d.com || !devs.some((o) => o !== d && o.vid === d.vid && o.pid === d.pid && o.com));
          this.onChange(this.devices);
        } catch {
          /* partial or noisy line: ignore */
        }
      }
    });
    this.proc.on("exit", () => {
      this.proc = null;
    });
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}

// ---- Drivers ----

function driversDir() {
  return app.isPackaged ? join(process.resourcesPath, "drivers") : join(app.getAppPath(), "resources/drivers");
}

/** Bundled driver INF for a bridge, e.g. resources/drivers/CH340/CH341SER.INF. */
export function bundledDriver(bridge: UsbBridge): string | null {
  const dir = join(driversDir(), bridge);
  if (!existsSync(dir)) return null;
  const inf = readdirSync(dir, { recursive: true, encoding: "utf8" }).find((f) => {
    const lower = f.toLowerCase();
    // SiLabs ships silabser.inf; WCH ships CH341SER.INF.
    return lower.endsWith(".inf") && (bridge !== "CP210x" || lower.includes("silabser"));
  });
  return inf ? join(dir, inf) : null;
}

export function availableDrivers(): UsbBridge[] {
  return (Object.values(BRIDGES) as UsbBridge[]).filter((b) => bundledDriver(b));
}

/**
 * Install drivers with one UAC prompt. Resolves true if pnputil succeeded.
 * The user can decline the prompt; nothing is installed then.
 */
export function installDrivers(bridges: UsbBridge[]): Promise<{ ok: boolean; message: string }> {
  // Only known bridge names: the name becomes part of a path run elevated.
  const known = new Set<string>(Object.values(BRIDGES));
  const infs = [...new Set(bridges)].filter((b) => known.has(b)).map(bundledDriver).filter((p): p is string => !!p);
  if (!infs.length) return Promise.resolve({ ok: false, message: "No bundled driver for this board." });
  // Elevated script: add each INF, remember the first real failure, then rescan.
  // pnputil: 0 ok, 3010 ok + reboot, 259 ok (nothing to update).
  const inner = [
    "$code = 0",
    ...infs.map((p) => `pnputil.exe /add-driver '${p.replace(/'/g, "''")}' /install; if ($LASTEXITCODE -notin 0,259,3010) { $code = $LASTEXITCODE } elseif ($LASTEXITCODE -eq 3010 -and $code -eq 0) { $code = 3010 }`),
    "pnputil.exe /scan-devices | Out-Null",
    "exit $code",
  ].join("\n");
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  const outer = `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
  return new Promise((resolve) => {
    const ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", outer], { windowsHide: true });
    let err = "";
    ps.stderr.on("data", (d) => (err += d));
    ps.on("exit", (code) => {
      if (/canceled by the user|operation was canceled/i.test(err)) {
        resolve({ ok: false, message: "Driver install was cancelled." });
      } else if (code === 0 || code === 259 || code === 3010) {
        resolve({ ok: true, message: code === 3010 ? "Driver installed. Windows asks for a restart." : "Driver installed." });
      } else {
        resolve({ ok: false, message: `Driver install failed (code ${code}). ${err.trim().split("\n")[0] ?? ""}` });
      }
    });
  });
}
