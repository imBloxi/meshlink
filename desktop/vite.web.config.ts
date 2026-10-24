// Renderer only, in a normal browser, for fast UI work. Storage falls back to
// localStorage and the node link to the BroadcastChannel simulator.
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  root: "src/renderer",
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      "@core": resolve(__dirname, "src/core"),
      "@ui": resolve(__dirname, "src/renderer/ui"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  server: { port: 5199 },
});
