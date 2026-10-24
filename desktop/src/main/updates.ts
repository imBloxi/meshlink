// Update check against GitHub Releases. Notify only: nothing is downloaded or
// installed. The app makes this request only when the user asks for it or
// turned on "Check for updates on start", because for an off-grid messenger
// even "this IP runs MeshLink" is information.
import { app, net, shell } from "electron";
import type { AppInfo, UpdateInfo } from "../shared/api";
import { isNewer } from "../shared/version";

export const REPO = "imBloxi/meshlink";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/`;

export function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    repo: `https://github.com/${REPO}`,
  };
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await net.fetch(RELEASES_API, {
      signal: ctrl.signal,
      headers: { Accept: "application/vnd.github+json", "User-Agent": "MeshLink-update-check" },
      credentials: "omit",
    });
    if (res.status === 404) return { current, latest: null, newer: false, error: "No release published yet." };
    if (!res.ok) return { current, latest: null, newer: false, error: `GitHub answered ${res.status}.` };
    const r = (await res.json()) as { tag_name?: string; html_url?: string; body?: string; published_at?: string; draft?: boolean; prerelease?: boolean };
    const latest = typeof r.tag_name === "string" ? r.tag_name.replace(/^v/, "") : null;
    if (!latest || r.draft || r.prerelease) return { current, latest: null, newer: false, error: "No stable release found." };
    // Only ever link to this repo's release pages, whatever the API returned.
    const url = typeof r.html_url === "string" && r.html_url.startsWith(RELEASES_PAGE) ? r.html_url : `${RELEASES_PAGE}latest`;
    return {
      current, latest, newer: isNewer(latest, current), url,
      notes: typeof r.body === "string" ? r.body.slice(0, 4000) : "",
      publishedAt: typeof r.published_at === "string" ? r.published_at : undefined,
    };
  } catch (e) {
    const offline = (e as Error).name === "AbortError" || /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ENOTFOUND/.test(String(e));
    return { current, latest: null, newer: false, error: offline ? "No internet connection." : String((e as Error).message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export function openReleasePage(url: string) {
  if (url.startsWith(RELEASES_PAGE)) return shell.openExternal(url);
  return Promise.resolve();
}
