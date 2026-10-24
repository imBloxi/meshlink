import { describe, expect, it } from "vitest";
import { assessFirmware, chipFamily, compareVersions, isOlder, parseVersion, wantsUpdate } from "./firmware";
import { H_INFO, parseHostFrame } from "./protocol";

const bundled = { version: "0.5.0", chip: "ESP8266" };
const base = { nodeProtocol: 3, appProtocol: 3, bundled };

describe("version compare", () => {
  it("compares numbers, not strings", () => {
    expect(isOlder("0.2.0", "0.10.0")).toBe(true);
    expect(isOlder("0.10.0", "0.2.0")).toBe(false);
    expect(compareVersions("0.5.0", "0.5")).toBe(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });
  it("orders pre-releases before the release", () => {
    expect(compareVersions("0.5.0-rc1", "0.5.0")).toBeLessThan(0);
    expect(compareVersions("0.5.0", "0.5.0-rc1")).toBeGreaterThan(0);
    expect(compareVersions("0.5.0-rc1", "0.5.0-rc2")).toBeLessThan(0);
  });
  it("treats missing or garbled versions as oldest", () => {
    expect(isOlder(undefined, "0.1.0")).toBe(true);
    expect(isOlder("junk", "0.1.0")).toBe(true);
    expect(parseVersion("v0.4.2")?.nums).toEqual([0, 4, 2]);
    expect(parseVersion("")).toBeNull();
  });
});

describe("chip family", () => {
  it("groups chips", () => {
    expect(chipFamily("ESP8266")).toBe("ESP8266");
    expect(chipFamily("ESP8285")).toBe("ESP8266");
    expect(chipFamily("ESP32-C3")).toBe("ESP32");
    expect(chipFamily("ESP32-D0WDQ6")).toBe("ESP32");
    expect(chipFamily(undefined)).toBe("unknown");
  });
});

describe("assessFirmware", () => {
  it("is current at the bundled version", () => {
    const a = assessFirmware({ ...base, nodeFw: "0.5.0", nodeChip: "ESP8266" });
    expect(a.state).toBe("current");
    expect(wantsUpdate(a)).toBe(false);
  });
  it("offers an update for an older ESP8266 node, with or without a chip report", () => {
    const withChip = assessFirmware({ ...base, nodeFw: "0.4.2", nodeChip: "ESP8266" });
    const legacy = assessFirmware({ ...base, nodeFw: "0.4.2" });
    for (const a of [withChip, legacy]) {
      expect(a.state).toBe("outdated");
      expect(a.chip).toBe("ESP8266");
      expect(wantsUpdate(a)).toBe(true);
    }
  });
  it("does not offer the ESP8266 image to an ESP32", () => {
    const a = assessFirmware({ ...base, nodeFw: "0.4.9", nodeChip: "ESP32-C3" });
    expect(a.state).toBe("outdated");
    expect(a.canFlash).toBe(false);
    expect(wantsUpdate(a)).toBe(false);
    expect(a.message).toMatch(/PlatformIO/);
  });
  it("never flashes a node that reports no chip but a new version", () => {
    expect(assessFirmware({ ...base, nodeFw: "0.5.1" }).canFlash).toBe(false);
  });
  it("flags protocol mismatches", () => {
    const old = assessFirmware({ ...base, nodeProtocol: 2, nodeFw: "0.4.1" });
    expect(old.state).toBe("protocol-old");
    expect(wantsUpdate(old)).toBe(true);
    const next = assessFirmware({ ...base, nodeProtocol: 4, nodeFw: "0.9.0", nodeChip: "ESP8266" });
    expect(next.state).toBe("protocol-new");
    expect(wantsUpdate(next)).toBe(false);
  });
  it("leaves a newer node alone", () => {
    const a = assessFirmware({ ...base, nodeFw: "0.6.0", nodeChip: "ESP8266" });
    expect(a.state).toBe("newer");
    expect(wantsUpdate(a)).toBe(false);
  });
  it("handles a v0.1 node and a missing bundle", () => {
    expect(assessFirmware({ ...base, nodeFw: undefined }).state).toBe("unknown");
    expect(assessFirmware({ ...base, nodeFw: "0.4.0", bundled: null }).canFlash).toBe(false);
  });
});

describe("INFO frame", () => {
  const enc = new TextEncoder();
  const frame = (fw: string, name: string, chip?: string) => {
    const bytes = [H_INFO, 3, 1, 2, 3, 4, 1, 2, 3, 4, 5, 6, 6, fw.length, ...enc.encode(fw), 1, 7, 0, 0, 0, 0, name.length, ...enc.encode(name)];
    if (chip !== undefined) bytes.push(chip.length, ...enc.encode(chip));
    return Uint8Array.from(bytes);
  };
  it("reads the chip when present", () => {
    const ev = parseHostFrame(frame("0.5.0", "Roof", "ESP32-C3"));
    expect(ev).toMatchObject({ kind: "info", fwVersion: "0.5.0", nodeName: "Roof", chip: "ESP32-C3" });
  });
  it("accepts older nodes that end the frame after the name", () => {
    const ev = parseHostFrame(frame("0.4.2", "Roof"));
    expect(ev).toMatchObject({ kind: "info", fwVersion: "0.4.2", nodeName: "Roof" });
    expect((ev as { chip?: string }).chip).toBeUndefined();
  });
  it("ignores a truncated chip field", () => {
    const f = frame("0.5.0", "Roof", "ESP32-C3");
    const ev = parseHostFrame(f.subarray(0, f.length - 3));
    expect((ev as { chip?: string }).chip).toBeUndefined();
  });
});
