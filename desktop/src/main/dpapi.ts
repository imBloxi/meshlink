// Windows DPAPI (CurrentUser scope) through Windows PowerShell.
//
// Electron safeStorage keeps its key in Chromium's "Local State" file, which is
// only written on a clean exit. A crash right after first launch then makes
// every secret unreadable. DPAPI proper has no such file: Windows derives the
// key from the user's logon credentials.
import { execFileSync } from "node:child_process";
import { safeStorage } from "electron";

function ps(script: string, input: string): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command",
      `Add-Type -AssemblyName System.Security; $in = [Console]::In.ReadToEnd().Trim(); ${script}`],
    { input, encoding: "utf8", windowsHide: true, timeout: 20_000 },
  ).trim();
}

export function protect(data: Buffer): Buffer {
  if (process.platform !== "win32") return safeStorage.encryptString(data.toString("base64"));
  const out = ps(
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($in), $null, 'CurrentUser'))",
    data.toString("base64"),
  );
  return Buffer.from(out, "base64");
}

export function unprotect(blob: Buffer): Buffer {
  if (process.platform !== "win32") return Buffer.from(safeStorage.decryptString(blob), "base64");
  const out = ps(
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in), $null, 'CurrentUser'))",
    blob.toString("base64"),
  );
  return Buffer.from(out, "base64");
}
