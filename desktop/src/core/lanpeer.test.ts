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

  it("limits each origin to originRate frames per second", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 3, now: () => t });
    expect([1, 2, 3, 4, 5].map((id) => f.check(frame(7, id)))).toEqual(["ok", "ok", "ok", "rate", "rate"]);
    expect(f.check(frame(8, 50))).toBe("ok"); // another origin has its own budget
    t = 1001;
    expect(f.check(frame(7, 6))).toBe("ok");
  });

  it("defaults to the firmware rate of 10 frames per second", () => {
    const f = new LanFilter(ME, { now: () => 0 });
    const out = Array.from({ length: 12 }, (_, i) => f.check(frame(9, i + 1)));
    expect(out.filter((v) => v === "ok")).toHaveLength(10);
    expect(out.slice(10)).toEqual(["rate", "rate"]);
  });

  it("treats a rate-limited frame as seen, so a replay of it stays dropped", () => {
    let t = 0;
    const f = new LanFilter(ME, { originRate: 1, now: () => t });
    f.check(frame(7, 1));
    expect(f.check(frame(7, 2))).toBe("rate");
    t = 5000;
    expect(f.check(frame(7, 2))).toBe("dup");
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
});
