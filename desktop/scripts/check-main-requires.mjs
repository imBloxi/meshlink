// The installer carries no node_modules, so the bundled main and preload
// scripts may only require Electron and Node built-ins. A package that stays
// external crashes the installed app at launch ("Cannot find module ...").
// Run after `npm run build`.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const allowed = (name) =>
  name === "electron" || name.startsWith("node:") || builtinModules.includes(name.split("/")[0]);

/** Module names required by a CommonJS bundle that the installer cannot provide. */
export function unresolvedRequires(source) {
  const names = new Set();
  for (const m of source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) names.add(m[1]);
  return [...names].filter((n) => !allowed(n) && !n.startsWith("."));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const out = fileURLToPath(new URL("../out/", import.meta.url));
  let bad = false;
  for (const file of ["main/index.cjs", "preload/index.cjs"]) {
    const missing = unresolvedRequires(readFileSync(out + file, "utf8"));
    if (missing.length) {
      bad = true;
      console.error(`${file} requires packages the installer does not ship: ${missing.join(", ")}`);
    }
  }
  if (bad) process.exitCode = 1;
  else console.log("Main and preload only require Electron and Node built-ins.");
}
