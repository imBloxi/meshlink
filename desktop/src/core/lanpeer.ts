// Duplicate and rate filter for the LAN transport. It applies the node rules from
// PROTOCOL.md section 1 (last 512 msgIds, per-origin rate limit) to frames whose
// tag has already been checked.

export type FilterVerdict = "ok" | "echo" | "dup" | "rate";

export interface LanFilterOptions {
  /** Frames per second from one origin. 0 means no limit. Firmware default. */
  originRate?: number;
  now?: () => number;
  originsMax?: number;
}

const SEEN_MAX = 512;

export class LanFilter {
  private seen = new Set<number>();
  private order: number[] = [];
  private origins = new Map<number, number[]>(); // origin -> send times (ms) in the last second
  private readonly rate: number;
  private readonly now: () => number;
  private readonly originsMax: number;

  constructor(private ownOrigin: number, opts: LanFilterOptions = {}) {
    this.rate = opts.originRate ?? 10;
    this.now = opts.now ?? (() => performance.now());
    this.originsMax = opts.originsMax ?? 256;
  }

  get originCount() {
    return this.origins.size;
  }

  check(f: { origin: number; msgId: number }): FilterVerdict {
    if (f.origin === this.ownOrigin) return "echo";
    if (this.seen.has(f.msgId)) return "dup";
    this.seen.add(f.msgId);
    this.order.push(f.msgId);
    if (this.order.length > SEEN_MAX) this.seen.delete(this.order.shift()!);
    return this.withinRate(f.origin) ? "ok" : "rate";
  }

  private withinRate(origin: number): boolean {
    if (this.rate === 0) return true;
    const t = this.now();
    let times = this.origins.get(origin);
    if (!times) {
      if (this.origins.size >= this.originsMax) this.prune(t);
      times = [];
      this.origins.set(origin, times);
    }
    while (times.length && t - times[0] >= 1000) times.shift();
    if (times.length >= this.rate) return false;
    times.push(t);
    return true;
  }

  /** Drop idle origins first, then the oldest one, so a flood of fake origins cannot grow the table. */
  private prune(t: number) {
    for (const [o, times] of this.origins) {
      if (!times.length || t - times[times.length - 1] >= 1000) this.origins.delete(o);
    }
    while (this.origins.size >= this.originsMax) this.origins.delete(this.origins.keys().next().value!);
  }
}
