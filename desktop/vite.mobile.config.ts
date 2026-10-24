import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/mobile",
  base: "./",
  plugins: [react(), {
    name: "mobile-dev-csp",
    apply: "serve",
    // Vite's inline React refresh preamble is development-only. Packaged assets
    // keep their CSP, with a stricter native response header as a second layer.
    transformIndexHtml: (html) => html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/, ""),
  }],
  build: {
    // Packaged CSP allows fonts from the app origin, not inline data URLs.
    assetsInlineLimit: 0,
    outDir: resolve(__dirname, "../mobile/android/app/src/main/assets/public"),
    emptyOutDir: true,
  },
  server: { host: "127.0.0.1", port: 5200 },
});
