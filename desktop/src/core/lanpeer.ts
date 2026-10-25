// Duplicate and rate filter for the LAN transport, for frames whose tag has
// already been checked. The duplicate rule (last 512 msgIds) and the per-origin
// token bucket (a burst of two seconds, then originRate frames per second) are
// the ones in firmware/src/main.cpp (seenAdd, originAllowed).

export type FilterVerdict = "ok" | "echo" | "dup" | "rate";

export interface LanFilterOptions {
  /** Frames per second from one origin. 0 means no limit. Firmware default. */
  originRate?: number;
  /** Milliseconds from a clock that never goes backwards. */
  now?: () => number;
  originsMax?: number;
}

const SEEN_MAX = 512;
const BURST_SECONDS = 2;

interface Bucket {
  tokens: number;
  at: number;
}

export class LanFilter {
  private seen = new Set<number>();
  private order: number[] = [];
  private origins = new Map<number, Bucket>();
  private readonly rate: number;
  private readonly now: () => number;
  private readonly originsMax: number;

  constructor(private ownOrigin: number, opts: LanFilterOptions = {}) {
    this.rate = opts.originRate ?? 10;
    // Not Date.now: a clock step backwards (NTP, manual change) would freeze refills.
    this.now = opts.now ?? (() => performance.now());
    this.originsMax = Math.max(1, opts.originsMax ?? 256);
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
    return this.take(f.origin) ? "ok" : "rate";
  }

  private take(origin: number): boolean {
    if (this.rate === 0) return true;
    const t = this.now();
    const cap = this.rate * BURST_SECONDS;
    let b = this.origins.get(origin);
    if (!b) {
      if (this.origins.size >= this.originsMax) this.prune(t, cap);
      b = { tokens: cap, at: t };
      this.origins.set(origin, b);
    }
    b.tokens = Math.min(cap, b.tokens + ((t - b.at) * this.rate) / 1000);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drop origins whose budget is full again (idle), then the oldest, so fake origins cannot grow the table. */
  private prune(t: number, cap: number) {
    for (const [o, b] of this.origins) {
      if (b.tokens + ((t - b.at) * this.rate) / 1000 >= cap) this.origins.delete(o);
    }
    while (this.origins.size >= this.originsMax) this.origins.delete(this.origins.keys().next().value!);
  }
}
