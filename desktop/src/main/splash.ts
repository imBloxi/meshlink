// Launch screen: a small window that appears at once while the main window
// loads (secrets through DPAPI, the database, the renderer). It has no
// preload, no Node and no network: a static page from a data: URL.
import { app, BrowserWindow, nativeTheme } from "electron";

const LOGO = `<svg viewBox="0 0 32 32" width="64" height="64" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#2ee6a6"/>
<path d="M10 21 16 10 22 21Z" fill="none" stroke="#03140d" stroke-width="2" stroke-linejoin="round" opacity=".55"/>
<g fill="#03140d"><circle class="n n1" cx="16" cy="10" r="3.2"/><circle class="n n2" cx="10" cy="21" r="3.2"/><circle class="n n3" cx="22" cy="21" r="3.2"/></g></svg>`;

function page(dark: boolean) {
  const bg = dark ? "#0b0f14" : "#f6f8fa";
  const fg = dark ? "#e6edf3" : "#0b0f14";
  const muted = dark ? "#8b98a5" : "#57606a";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>MeshLink</title><style>
html, body { margin: 0; height: 100%; background: ${bg}; color: ${fg}; font: 14px "Segoe UI Variable", "Segoe UI", system-ui, sans-serif;
  -webkit-user-select: none; cursor: default; overflow: hidden; }
body { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; -webkit-app-region: drag; }
h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -.01em; }
p { margin: 0; color: ${muted}; font-size: 12.5px; }
.bar { width: 120px; height: 3px; border-radius: 3px; background: ${dark ? "#1c2530" : "#d8dee4"}; overflow: hidden; margin-top: 6px; }
.bar::after { content: ""; display: block; width: 40%; height: 100%; border-radius: 3px; background: #2ee6a6; animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.n { animation: pulse 1.5s ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
.n2 { animation-delay: .25s; } .n3 { animation-delay: .5s; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) { .n, .bar::after { animation: none; } }
.ver { position: fixed; bottom: 12px; font-size: 11px; color: ${muted}; }
</style></head><body>${LOGO}<h1>MeshLink</h1><p>Starting your private mesh…</p><div class="bar"></div>
<div class="ver">v${app.getVersion()}</div></body></html>`;
}

/** Show the launch screen. Call close() when the main window is ready. */
export function showSplash() {
  const shownAt = Date.now();
  const win = new BrowserWindow({
    width: 360,
    height: 260,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    center: true,
    show: false,
    title: "MeshLink",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0f14" : "#f6f8fa",
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => win.show());
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(nativeTheme.shouldUseDarkColors))}`);
  return {
    /** Close the splash, keeping it up at least briefly so it does not flicker. */
    close(then?: () => void) {
      const wait = Math.max(0, 500 - (Date.now() - shownAt));
      setTimeout(() => {
        then?.();
        if (!win.isDestroyed()) win.destroy();
      }, wait);
    },
  };
}
