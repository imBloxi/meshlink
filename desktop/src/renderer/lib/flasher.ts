// Flash the bundled MeshLink firmware onto an ESP8266 over Web Serial,
// using Espressif's esptool-js (same protocol as esptool.py).
import { ESPLoader, Transport } from "esptool-js";

export type FlashPhase = "connecting" | "writing" | "resetting";

export interface FlashCallbacks {
  onPhase(phase: FlashPhase, detail?: string): void;
  onProgress(fraction: number): void;
  onLog(line: string): void;
}

async function attempt(port: SerialPort, image: Uint8Array, offset: number, baud: number, cb: FlashCallbacks) {
  const transport = new Transport(port, false);
  const loader = new ESPLoader({
    transport,
    baudrate: baud,
    romBaudrate: 115200,
    terminal: { clean() {}, write: (d: string) => cb.onLog(d), writeLine: (d: string) => cb.onLog(d) },
  });
  try {
    cb.onPhase("connecting");
    const chip = await loader.main("default_reset");
    if (!/ESP8266/i.test(chip)) {
      throw new Error(`Found ${chip}. MeshLink firmware only runs on ESP8266 boards.`);
    }
    cb.onPhase("writing", chip);
    await loader.writeFlash({
      fileArray: [{ data: image, address: offset }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_i, written, total) => cb.onProgress(written / total),
    });
    cb.onPhase("resetting");
    await loader.after("hard_reset");
    return chip;
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

/**
 * Write image at offset. Tries a fast baud rate first, then falls back to
 * 115200, which cheap USB-serial chips and long cables handle better.
 */
export async function flashFirmware(port: SerialPort, image: Uint8Array, offset: number, cb: FlashCallbacks) {
  try {
    return await attempt(port, image, offset, 460800, cb);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Found ")) throw e;
    cb.onLog(`Fast flash failed (${e instanceof Error ? e.message : e}). Retrying at 115200 baud.`);
    cb.onProgress(0);
    return await attempt(port, image, offset, 115200, cb);
  }
}

/** "0.2.0" < "0.10.0". Missing version counts as oldest. */
export function isOlder(a: string | undefined, b: string): boolean {
  if (!a) return true;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}
