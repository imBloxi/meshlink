import { describe, expect, it } from "vitest";
import { LanFilter } from "./lanpeer";

const ME = 0xaaaa0001;
const frame = (origin: number, msgId: number) => ({ origin, msgId });

describe("LanFilter", () => {
  it("passes a new frame and drops its duplicate", () => {
    const f = new LanFilter(ME);
    expect(f.check(frame(1, 100))).toBe("ok");
    expect(f.check(frame(1, 100))).toBe("dup");
    expect(f.check(frame(1, 101))).toBe("ok");
  });

  it("drops our own broadcast when the socket hears it back", () => {
    const f = new LanFilter(ME);
    expect(f.check(frame(ME, 5))).toBe("echo");
  });

  // Same token bucket as originAllowed() in firmware/src/main.cpp: a burst of two
  // seconds, then originRate frames per second.
  it("allows a burst of two seconds, then originRate frames per second", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 3, now: () => t });
    let id = 0;
    const burst = Array.from({ length: 8 }, () => f.check(frame(7, ++id)));
    expect(burst).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "rate", "rate"]);
    expect(f.check(frame(8, 50))).toBe("ok"); // another origin has its own budget
    t = 1000; // refills 3 tokens
    expect([1, 2, 3, 4].map(() => f.check(frame(7, ++id)))).toEqual(["ok", "ok", "ok", "rate"]);
  });

  it("defaults to the firmware rate of 10 frames per second, so a 20 chunk message gets through", () => {
    const f = new LanFilter(ME, { now: () => 0 });
    const out = Array.from({ length: 22 }, (_, i) => f.check(frame(9, i + 1)));
    expect(out.filter((v) => v === "ok")).toHaveLength(20);
    expect(out.slice(20)).toEqual(["rate", "rate"]);
  });

  it("never banks more than the two second burst", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 5, now: () => t });
    f.check(frame(4, 1));
    t = 3_600_000; // an hour of silence
    const out = Array.from({ length: 12 }, (_, i) => f.check(frame(4, i + 10)));
    expect(out.filter((v) => v === "ok")).toHaveLength(10);
  });

  it("treats a rate-limited frame as seen, so a replay of it stays dropped", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 1, now: () => t });
    f.check(frame(7, 1));
    f.check(frame(7, 2));
    expect(f.check(frame(7, 3))).toBe("rate");
    t = 5000;
    expect(f.check(frame(7, 3))).toBe("dup");
  });

  it("no limit when originRate is 0", () => {
    const f = new LanFilter(ME, { originRate: 0, now: () => 0 });
    for (let i = 1; i <= 200; i++) expect(f.check(frame(3, i))).toBe("ok");
  });

  it("forgets the oldest ids after 512 frames, like a node", () => {
    const f = new LanFilter(ME, { originRate: 0 });
    for (let i = 1; i <= 513; i++) f.check(frame(1, i));
    expect(f.check(frame(1, 1))).toBe("ok"); // evicted
    expect(f.check(frame(1, 513))).toBe("dup");
  });

  it("keeps its origin table bounded", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 5, now: () => t, originsMax: 16 });
    for (let i = 1; i <= 100; i++) {
      t += 1;
      f.check(frame(1000 + i, i));
    }
    expect(f.originCount).toBeLessThanOrEqual(16);
  });

  it("drops idle origins first and keeps one that is still active", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 5, now: () => t, originsMax: 4 });
    for (let i = 1; i <= 4; i++) f.check(frame(100 + i, i)); // four origins, then they go quiet
    t = 10_000;
    f.check(frame(200, 50)); // table is full: the idle ones go
    expect(f.originCount).toBe(1);
    // The active origin kept its spent budget; a flood of new origins cannot reset it.
    for (let i = 0; i < 9; i++) f.check(frame(200, 60 + i));
    for (let i = 1; i <= 3; i++) f.check(frame(300 + i, 90 + i));
    expect(f.check(frame(200, 99))).toBe("rate");
  });

  it("treats a zero or negative origin table size as one", () => {
    const f = new LanFilter(ME, { originsMax: 0, now: () => 0 });
    expect(f.check(frame(1, 1))).toBe("ok");
    expect(f.check(frame(2, 2))).toBe("ok");
    expect(f.originCount).toBe(1);
  });
});
