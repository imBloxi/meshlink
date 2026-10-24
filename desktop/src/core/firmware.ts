// Decide what a node's firmware means for this app: current, outdated, too
// new, or on a chip the bundled image does not fit. Pure functions, no I/O.

export interface Version {
  nums: number[];
  /** Text after "-", for example "rc1". A release without it is newer than any pre-release. */
  pre: string;
}

/** "0.5.0", "v0.5.0-rc1". Returns null if no number can be read. */
export function parseVersion(text: string | undefined | null): Version | null {
  if (!text) return null;
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (!m) return null;
  return { nums: m[1].split(".").map(Number), pre: m[2] ?? "" };
}

/** <0 if a is older than b, 0 if equal, >0 if newer. Unreadable versions count as oldest. */
export function compareVersions(a: string | undefined | null, b: string | undefined | null): number {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

/** "0.2.0" < "0.10.0". Missing version counts as oldest. */
export function isOlder(a: string | undefined, b: string): boolean {
  return compareVersions(a, b) < 0;
}

export type ChipFamily = "ESP8266" | "ESP32" | "unknown";

/** Group chip names: ESP8285 is an ESP8266 with built-in flash; ESP32-S3, -C3, -C6 share the ESP32 toolchain. */
export function chipFamily(chip: string | undefined): ChipFamily {
  if (!chip) return "unknown";
  if (/ESP82(66|85)/i.test(chip)) return "ESP8266";
  if (/ESP32/i.test(chip)) return "ESP32";
  return "unknown";
}

/** Firmware before 0.5.0 did not report its chip, and only an ESP8266 build existed. */
export const FIRST_CHIP_REPORTING_VERSION = "0.5.0";

export type FirmwareState =
  | "current" // same version as the bundled image
  | "outdated" // older than the bundled image
  | "newer" // newer than the bundled image (a newer app, or a custom build)
  | "protocol-old" // speaks an older air protocol: cannot talk to this app's mesh
  | "protocol-new" // speaks a newer air protocol: update the app
  | "unknown"; // no version information at all (v0.1)

export interface FirmwareAssessment {
  state: FirmwareState;
  chip: ChipFamily;
  /** True when the bundled image can be written to this node from the app. */
  canFlash: boolean;
  /** Short sentence for a toast or settings row. */
  message: string;
}

export interface AssessInput {
  nodeFw: string | undefined;
  nodeProtocol: number;
  /** Chip name from INFO, if the node reports one. */
  nodeChip?: string;
  appProtocol: number;
  bundled?: { version: string; chip: string } | null;
}

export function assessFirmware(i: AssessInput): FirmwareAssessment {
  const reported = chipFamily(i.nodeChip);
  const chip: ChipFamily = reported !== "unknown" ? reported : i.nodeFw && compareVersions(i.nodeFw, FIRST_CHIP_REPORTING_VERSION) >= 0 ? "unknown" : "ESP8266";
  const fits = !!i.bundled && chip !== "unknown" && chipFamily(i.bundled.chip) === chip;
  const result = (state: FirmwareState, message: string, canFlashWhenFits = true): FirmwareAssessment => ({
    state, chip, canFlash: fits && canFlashWhenFits, message,
  });

  const hint = i.bundled && !fits && chip !== "unknown"
    ? ` This app only flashes ESP8266 boards: reflash this ${i.nodeChip ?? chip} with PlatformIO (docs/boards.md).`
    : "";
  if (i.nodeProtocol > i.appProtocol) {
    return result("protocol-new", `This node speaks protocol v${i.nodeProtocol}, newer than this app (v${i.appProtocol}). Update the app.`, false);
  }
  if (i.nodeProtocol < i.appProtocol) {
    return result("protocol-old", `This node speaks protocol v${i.nodeProtocol}. Update it to talk to v${i.appProtocol} nodes.${hint}`);
  }
  if (!i.nodeFw) return result("unknown", `This node reports no firmware version (v0.1). Update it.${hint}`);
  if (!i.bundled) return result("current", `Firmware v${i.nodeFw}.`, false);
  const c = compareVersions(i.nodeFw, i.bundled.version);
  if (c < 0) return result("outdated", `Firmware v${i.nodeFw} is older than the bundled v${i.bundled.version}.${hint}`);
  if (c > 0) return result("newer", `Firmware v${i.nodeFw} is newer than the bundled v${i.bundled.version}.`, false);
  return result("current", `Firmware v${i.nodeFw} is up to date.`, false);
}

/** True when the app should offer to update this node. */
export function wantsUpdate(a: FirmwareAssessment): boolean {
  return a.canFlash && (a.state === "outdated" || a.state === "protocol-old" || a.state === "unknown");
}
