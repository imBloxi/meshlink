// Serial framing between app and node: COBS + CRC-16, 0x00 delimited.
// Mirrors firmware/src/protocol.h and app/meshlink/framing.py.
import { concat } from "./bytes";

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (const b of data) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return crc;
}

export function cobsEncode(data: Uint8Array): Uint8Array {
  const out: number[] = [0];
  let codePos = 0;
  let code = 1;
  for (const b of data) {
    if (b === 0) {
      out[codePos] = code;
      code = 1;
      codePos = out.length;
      out.push(0);
    } else {
      out.push(b);
      if (++code === 0xff) {
        out[codePos] = code;
        code = 1;
        codePos = out.length;
        out.push(0);
      }
    }
  }
  out[codePos] = code;
  return Uint8Array.from(out);
}

export function cobsDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const code = data[i++];
    if (code === 0 || i + code - 1 > data.length) throw new Error("malformed COBS");
    for (let k = 1; k < code; k++) out.push(data[i++]);
    if (code < 0xff && i < data.length) out.push(0);
  }
  return Uint8Array.from(out);
}

/** Add CRC, COBS encode, add delimiter. Ready to write to the port. */
export function encodeFrame(frame: Uint8Array): Uint8Array {
  const crc = crc16(frame);
  return concat(cobsEncode(concat(frame, Uint8Array.of(crc & 0xff, crc >> 8))), Uint8Array.of(0));
}

/** Collects serial bytes and returns complete, CRC-checked frames. */
export class FrameReader {
  static readonly MAX_ENCODED = 512;
  private buf: number[] = [];
  badFrames = 0;

  feed(data: Uint8Array): Uint8Array[] {
    const frames: Uint8Array[] = [];
    for (const b of data) {
      if (b !== 0) {
        if (this.buf.length < FrameReader.MAX_ENCODED) this.buf.push(b);
        continue;
      }
      const raw = Uint8Array.from(this.buf);
      this.buf = [];
      if (raw.length === 0) continue;
      const frame = FrameReader.check(raw);
      if (frame) frames.push(frame);
      else this.badFrames++;
    }
    return frames;
  }

  private static check(raw: Uint8Array): Uint8Array | null {
    let d: Uint8Array;
    try {
      d = cobsDecode(raw);
    } catch {
      return null;
    }
    if (d.length < 3) return null;
    const body = d.subarray(0, d.length - 2);
    const crc = d[d.length - 2] | (d[d.length - 1] << 8);
    return crc16(body) === crc ? body : null;
  }
}
