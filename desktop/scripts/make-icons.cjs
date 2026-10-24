// Render the app icon and the installer images from the MeshLink logo.
//
//   cd desktop
//   npx electron scripts/make-icons.cjs
//
// Output in desktop/build (electron-builder's resources folder):
//   icon.ico, icon.png             app, installer and uninstaller icon
//   installerSidebar.bmp           welcome and finish pages (164 x 314)
//   uninstallerSidebar.bmp
//   installerHeader.bmp            top of the other pages (150 x 57)
// and desktop/resources/icons/tray.png, tray@2x.png (tray icon at runtime).
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const iconsDir = path.join(root, "resources", "icons");
const inter = pathToFileURL(path.join(root, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2")).href;

const ACCENT = "#2ee6a6";
const INK = "#03140d";
const BG = "#0b0f14";

// Same mark as src/renderer/app/Logo.tsx.
const logoSvg = (opts = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  ${opts.noTile ? "" : `<rect width="32" height="32" rx="${opts.rx ?? 9}" fill="${ACCENT}"/>`}
  <path d="M10 21 16 10 22 21Z" fill="none" stroke="${opts.ink ?? INK}" stroke-width="${opts.stroke ?? 2}" stroke-linejoin="round" opacity=".55"/>
  <g fill="${opts.ink ?? INK}"><circle cx="16" cy="10" r="3.2"/><circle cx="10" cy="21" r="3.2"/><circle cx="22" cy="21" r="3.2"/></g></svg>`;

// Page with helpers that draw onto canvases and return RGBA or PNG data.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(${inter}) format("woff2"); font-weight: 100 900; }
body { margin: 0; }
</style><body><script>
const img = (svg) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad;
  i.src = "data:image/svg+xml;base64," + btoa(svg); });
window.icon = async (svg, size) => {
  const c = document.createElement("canvas"); c.width = c.height = size;
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
  // Small sizes: a little margin and a full tile read better in the taskbar.
  g.drawImage(await img(svg), 0, 0, size, size);
  return c.toDataURL("image/png");
};
window.panel = async (w, h, kind, logo) => {
  await document.fonts.load("600 20px Inter"); await document.fonts.load("400 12px Inter");
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  if (kind === "sidebar") {
    g.fillStyle = "${BG}"; g.fillRect(0, 0, w, h);
    // Faint mesh: nodes and links, the product's idea.
    const pts = [[22,250],[70,214],[128,258],[104,296],[40,300],[150,206]];
    g.strokeStyle = "rgba(46,230,166,.22)"; g.lineWidth = 1.2;
    for (const [a,b] of [[0,1],[1,2],[2,3],[3,4],[4,0],[1,3],[2,5],[1,5]]) { g.beginPath(); g.moveTo(...pts[a]); g.lineTo(...pts[b]); g.stroke(); }
    g.fillStyle = "rgba(46,230,166,.55)";
    for (const [x,y] of pts) { g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill(); }
    g.drawImage(await img(logo), 22, 30, 44, 44);
    g.fillStyle = "#e6edf3"; g.font = "600 21px Inter"; g.fillText("MeshLink", 22, 104);
    g.fillStyle = "#8b98a5"; g.font = "400 11.5px Inter";
    ["Private messaging", "with no internet."].forEach((t, i) => g.fillText(t, 22, 128 + i * 17));
  } else {
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h);
    g.drawImage(await img(logo), w - 46, 11, 34, 34);
  }
  return Array.from(g.getImageData(0, 0, w, h).data);
};
</script>`;

/** Windows ICO with PNG-compressed images (supported since Vista). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head[e] = size >= 256 ? 0 : size; head[e + 1] = size >= 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/** 24-bit bottom-up BMP, the format NSIS expects for installer images. */
function bmp(w, h, rgba) {
  const row = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * h);
  out.write("BM", 0); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(row * h, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = 54 + (h - 1 - y) * row + x * 3;
      out[d] = rgba[s + 2]; out[d + 1] = rgba[s + 1]; out[d + 2] = rgba[s];
    }
  }
  return out;
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(iconsDir, { recursive: true });
  const tmp = path.join(app.getPath("temp"), "meshlink-icons.html");
  fs.writeFileSync(tmp, PAGE);
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadFile(tmp);
  const run = (js) => win.webContents.executeJavaScript(js);
  const png = async (svg, size) => Buffer.from((await run(`icon(${JSON.stringify(svg)}, ${size})`)).split(",")[1], "base64");

  // App icon: rounder tile at small sizes, so it stays a recognisable shape.
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) pngs.push({ size, data: await png(logoSvg({ rx: size <= 32 ? 8 : 9, stroke: size <= 24 ? 2.6 : 2 }), size) });
  fs.writeFileSync(path.join(buildDir, "icon.ico"), ico(pngs));
  fs.writeFileSync(path.join(buildDir, "icon.png"), await png(logoSvg(), 512));

  // Tray: the tile, sized for 100% and 200% display scaling.
  fs.writeFileSync(path.join(iconsDir, "tray.png"), await png(logoSvg({ rx: 8, stroke: 2.6 }), 16));
  fs.writeFileSync(path.join(iconsDir, "tray@2x.png"), await png(logoSvg({ rx: 8, stroke: 2.4 }), 32));
  fs.writeFileSync(path.join(iconsDir, "app.png"), await png(logoSvg(), 256));

  const panel = async (w, h, kind) => bmp(w, h, await run(`panel(${w}, ${h}, ${JSON.stringify(kind)}, ${JSON.stringify(logoSvg())})`));
  const sidebar = await panel(164, 314, "sidebar");
  fs.writeFileSync(path.join(buildDir, "installerSidebar.bmp"), sidebar);
  fs.writeFileSync(path.join(buildDir, "uninstallerSidebar.bmp"), sidebar);
  fs.writeFileSync(path.join(buildDir, "installerHeader.bmp"), await panel(150, 57, "header"));

  for (const f of fs.readdirSync(buildDir)) console.log("OK build/" + f);
  for (const f of fs.readdirSync(iconsDir)) console.log("OK resources/icons/" + f);
  fs.rmSync(tmp, { force: true });
  app.quit();
});
