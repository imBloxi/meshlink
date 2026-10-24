// Release version compare, shared by the main process and tests.

/** "v1.2.3" or "1.2.3-beta.1" -> [1, 2, 3]. Pre-release suffixes are ignored. */
export function parseVersion(v: string): number[] | null {
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate), b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
