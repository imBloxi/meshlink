import { Button, Input } from "@ui/primitives";
import { isValidPhrase } from "@core/identity";
import { KeyRound, Radio, RotateCcw, ShieldCheck, Upload, WifiOff } from "lucide-react";
import { api } from "../lib/platform";
import { useState } from "react";
import { useApp } from "../lib/store";
import { Logo } from "./Logo";

const points = [
  { icon: <WifiOff />, title: "No internet needed", text: "Messages hop between MeshLink nodes by radio." },
  { icon: <ShieldCheck />, title: "End-to-end encrypted", text: "Nodes only ever relay scrambled data." },
  { icon: <KeyRound />, title: "Your key, your account", text: "Made on this PC. Restore it anywhere with 24 words." },
];

type Mode = "create" | "phrase" | "backup";

export function Onboarding() {
  const { createIdentity, restoreFromPhrase, importBackup } = useApp();
  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = name.trim().length > 0 && new TextEncoder().encode(name.trim()).length <= 32;
  const words = phrase.trim().split(/\s+/).filter(Boolean).length;
  const valid = mode === "create" ? nameOk : mode === "phrase" ? nameOk && words === 24 && isValidPhrase(phrase) : !!file && !!pass;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") await createIdentity(name.trim());
      else if (mode === "phrase") await restoreFromPhrase(phrase, name.trim());
      else await importBackup(file!, pass);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="h-screen grid lg:grid-cols-[1.1fr_1fr] bg-bg">
      <section className="hidden lg:flex flex-col justify-between p-12 bg-surface border-r border-line relative overflow-hidden">
        <div
          aria-hidden
          className="absolute -right-40 -top-40 size-[520px] rounded-full opacity-60"
          style={{ background: "radial-gradient(circle, var(--accent-soft), transparent 65%)" }}
        />
        <Logo />
        <div className="relative space-y-6 max-w-md">
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            Private messages, <span className="text-accent">off the grid.</span>
          </h1>
          <ul className="space-y-5">
            {points.map((p) => (
              <li key={p.title} className="flex gap-4">
                <span className="size-10 shrink-0 grid place-items-center rounded-lg bg-accent-soft text-accent [&_svg]:size-5">{p.icon}</span>
                <div>
                  <p className="font-medium">{p.title}</p>
                  <p className="text-sm text-muted">{p.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-faint">ESP8266 mesh · ESP-NOW · NaCl box</p>
      </section>

      <section className="flex items-center justify-center p-8">
        <form onSubmit={submit} className="w-full max-w-sm space-y-6 animate-enter">
          <div className="lg:hidden"><Logo /></div>
          <div className="space-y-2">
            <div className="size-12 grid place-items-center rounded-xl bg-accent text-accent-fg">
              {mode === "create" ? <Radio className="size-6" /> : <RotateCcw className="size-6" />}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight">
              {mode === "create" ? "Create your account" : mode === "phrase" ? "Restore with your phrase" : "Restore a backup"}
            </h2>
            <p className="text-sm text-muted">
              {mode === "create"
                ? "Pick the name others will see. Your account is a key made on this PC: no email, no phone number, no server."
                : mode === "phrase"
                  ? "Type the 24 words you wrote down. You get the same key back, so contacts recognise you."
                  : "Open a .meshlink backup file and enter its passphrase."}
            </p>
          </div>

          {mode !== "backup" && (
            <div className="space-y-1.5">
              <label htmlFor="display-name" className="text-sm font-medium">Display name</label>
              <Input id="display-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sam" maxLength={32} autoComplete="off" />
            </div>
          )}
          {mode === "phrase" && (
            <div className="space-y-1.5">
              <label htmlFor="phrase" className="text-sm font-medium">Recovery phrase</label>
              <textarea
                id="phrase" rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} spellCheck={false} autoComplete="off"
                className="w-full rounded-md bg-sunken border border-transparent focus:border-accent-line outline-none p-3 font-mono text-sm"
              />
              <p className="text-xs text-muted">{words}/24 words{words === 24 && !isValidPhrase(phrase) ? " · one word is wrong" : ""}</p>
            </div>
          )}
          {mode === "backup" && (
            <div className="space-y-3">
              <Button type="button" className="w-full" icon={<Upload className="size-4" />} onClick={async () => setFile(await api.openTextFile())}>
                {file ? "Backup file chosen" : "Choose backup file"}
              </Button>
              <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Passphrase" aria-label="Backup passphrase" />
            </div>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}

          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={!valid} loading={busy}>
            {mode === "create" ? "Create account" : "Restore account"}
          </Button>
          <div className="flex justify-center gap-4 text-sm">
            {(["create", "phrase", "backup"] as Mode[]).filter((m) => m !== mode).map((m) => (
              <button key={m} type="button" onClick={() => { setMode(m); setError(null); }} className="text-muted hover:text-fg underline-offset-4 hover:underline">
                {m === "create" ? "New account" : m === "phrase" ? "I have a recovery phrase" : "I have a backup file"}
              </button>
            ))}
          </div>
        </form>
      </section>
    </div>
  );
}
