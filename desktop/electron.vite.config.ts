import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import pkg from "./package.json" with { type: "json" };

// Strict CSP for packaged builds only (dev needs Vite's inline HMR scripts).
const csp = {
  name: "meshlink-csp",
  apply: "build" as const,
  transformIndexHtml: (html: string) => html.replace(
    "<head>",
    `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws:; object-src 'none'; base-uri 'none'" />`,
  ),
};

const alias = {
  "@core": resolve(__dirname, "src/core"),
  "@ui": resolve(__dirname, "src/renderer/ui"),
  "@shared": resolve(__dirname, "src/shared"),
};

export default defineConfig({
  main: {
    // The installer ships no node_modules ("files" excludes them), so anything the
    // main process imports from core/ must be bundled, not required at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ["tweetnacl", "@noble/hashes", "@scure/bip39"] })],
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
    resolve: { alias },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    // Sandboxed preloads must be CommonJS.
    build: { rollupOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss(), csp],
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    resolve: { alias },
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
  },
});
