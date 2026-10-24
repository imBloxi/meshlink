// Render MeshLink social images (minimal style) with Electron.
//
//   cd desktop
//   npx electron ../marketing/social/build.cjs
//
// Optional: PRIZE="$500" adds the prize to the challenge card.
// ONLY=launch or ONLY=launch-x renders a subset.
// Output: marketing/social/out/<design>-<size>.png
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const here = __dirname;
const repo = path.resolve(here, "../..");
const out = path.join(here, "out");
const fonts = path.join(repo, "desktop/node_modules/@fontsource-variable");
const inter = pathToFileURL(path.join(fonts, "inter/files/inter-latin-wght-normal.woff2")).href;
const mono = pathToFileURL(path.join(fonts, "jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2")).href;
const version = JSON.parse(fs.readFileSync(path.join(repo, "desktop/package.json"), "utf8")).version;
const prize = process.env.PRIZE || "";

const SIZES = {
  x: [1600, 900], // X / Twitter, Bluesky, Mastodon
  linkedin: [1200, 627],
  square: [1080, 1080], // Instagram, LinkedIn square
  portrait: [1080, 1350], // Instagram feed portrait
  github: [1280, 640], // GitHub social preview
};

const LOGO = `<svg viewBox="0 0 32 32" class="logo"><rect width="32" height="32" rx="9" fill="#2ee6a6"/>
  <path d="M10 21 16 10 22 21Z" fill="none" stroke="#03140d" stroke-width="2" stroke-linejoin="round" opacity=".55"/>
  <g fill="#03140d"><circle cx="16" cy="10" r="3.2"/><circle cx="10" cy="21" r="3.2"/><circle cx="22" cy="21" r="3.2"/></g></svg>`;

const page = (w, h, body) => {
  const u = Math.min(w, h) / 100;
  return `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(${inter}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: Mono; src: url(${mono}) format("woff2"); font-weight: 100 800; }
* { margin: 0; box-sizing: border-box; }
html, body { width: ${w}px; height: ${h}px; overflow: hidden; background: #0b0f14; color: #e6edf3; font-family: Inter, sans-serif; }
.wrap { height: 100%; padding: ${8 * u}px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: ${1.6 * u}px; font-weight: 600; font-size: ${3.4 * u}px; letter-spacing: -.02em; }
.logo { width: ${5.4 * u}px; height: ${5.4 * u}px; }
.main { margin: auto 0; }
h1 { font-weight: 700; font-size: ${9.5 * u}px; line-height: 1.02; letter-spacing: -.045em; }
.g { color: #2ee6a6; }
.r { color: #ff5d73; }
p { margin-top: ${3 * u}px; color: #8b98a5; font-size: ${3.3 * u}px; line-height: 1.4; max-width: ${Math.min(w * 0.7, 62 * u * 1.6)}px; }
code { font-family: Mono, monospace; color: #2ee6a6; font-size: .92em; }
.foot { display: flex; justify-content: space-between; font-family: Mono, monospace; font-size: ${2.3 * u}px; color: #5c6a77; }
</style><body><div class="wrap">
  <div class="brand">${LOGO}MeshLink</div>
  <div class="main">${body}</div>
  <div class="foot"><span>github.com/imBloxi/meshlink</span><span>v${version}</span></div>
</div></body>`;
};

const DESIGNS = {
  launch: () => `<h1>Messages that don't<br>need <span class="g">the internet.</span></h1>
    <p>Encrypted chat over $3 ESP8266 boards. Now open source.</p>`,
  challenge: () => `<h1>Break <span class="r">MeshLink.</span></h1>
    <p>Every radio frame of a private chat is public. Decrypt <code>MESHLINK{…}</code> and win${prize ? ` ${prize}` : ""}.</p>`,
  how: () => `<h1>Nodes carry it.<br><span class="g">Only your friend reads it.</span></h1>
    <p>End-to-end encrypted. Relays see ciphertext only.</p>`,
};

// Windows caps windows at screen size and applies display scaling. Pin scale 1
// and let DevTools set the exact viewport and capture it (beyond the window).
app.commandLine.appendSwitch("force-device-scale-factor", "1");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {}); // keep running between renders
app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const tmp = path.join(app.getPath("temp"), "meshlink-social");
  fs.mkdirSync(tmp, { recursive: true });
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  for (const [name, design] of Object.entries(DESIGNS)) {
    for (const [size, [w, h]] of Object.entries(SIZES)) {
      if (only && !only.includes(`${name}-${size}`) && !only.includes(name)) continue;
      try {
        const file = path.join(tmp, `${name}-${size}.html`);
        fs.writeFileSync(file, page(w, h, design(w, h)));
        const win = new BrowserWindow({ width: w, height: h, show: false, useContentSize: true, enableLargerThanScreen: true, webPreferences: { offscreen: true } });
        await win.loadFile(file);
        win.webContents.setZoomFactor(1); // Chromium remembers zoom per origin
        const dbg = win.webContents.debugger;
        dbg.attach("1.3");
        await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await win.webContents.executeJavaScript("document.fonts.ready.then(() => new Promise(r => setTimeout(r, 300)))");
        const shot = await dbg.sendCommand("Page.captureScreenshot", {
          format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
        });
        dbg.detach();
        const png = path.join(out, `${name}-${size}.png`);
        fs.writeFileSync(png, Buffer.from(shot.data, "base64"));
        console.log("OK", png);
        win.destroy();
      } catch (e) {
        console.log("FAIL", name, size, e && e.message);
      }
    }
  }
  app.quit();
});
