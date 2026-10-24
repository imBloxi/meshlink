// Persistent account: recovery phrase and encrypted backup file.
import { toHex } from "@core/bytes";
import { Field, Row, Section } from "@ui/form";
import { FingerprintDisplay, Identicon } from "@ui/identity";
import { Dialog } from "@ui/overlays";
import { Button, Input } from "@ui/primitives";
import { Download, Eye, EyeOff, KeyRound, Upload } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/platform";
import { useApp } from "../lib/store";

function Phrase() {
  const identity = useApp((s) => s.identity);
  const [shown, setShown] = useState(false);
  const [ack, setAck] = useState(false);
  if (!identity) return null;
  const words = identity.phrase().split(" ");
  return (
    <Section title="Recovery phrase">
      <p className="text-[13px] text-muted mb-3">
        These 24 words <strong className="text-fg">are</strong> your account. With them you get the same key, name and contacts back on
        any PC or phone. Anyone who sees them can pretend to be you. Write them on paper; never photograph or paste them.
      </p>
      {!shown ? (
        <div className="p-4 rounded-lg border border-warning/40 bg-warning/5 space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4" />
            Nobody is looking at my screen, and I am not screen sharing.
          </label>
          <Button variant="primary" icon={<Eye className="size-4" />} disabled={!ack} onClick={() => setShown(true)}>Show recovery phrase</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <ol className="grid grid-cols-4 gap-2 p-4 rounded-lg bg-sunken select-none">
            {words.map((w, i) => (
              <li key={i} className="flex gap-2 font-mono text-[13px]">
                <span className="text-faint w-5 text-right">{i + 1}</span>
                <span>{w}</span>
              </li>
            ))}
          </ol>
          <Button icon={<EyeOff className="size-4" />} onClick={() => { setShown(false); setAck(false); }}>Hide</Button>
        </div>
      )}
    </Section>
  );
}

function Backup() {
  const { exportBackup, importBackup, toast } = useApp();
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [withMessages, setWithMessages] = useState(true);
  const [busy, setBusy] = useState<"export" | "import" | null>(null);
  const [importPass, setImportPass] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const ok = pass.length >= 8 && pass === pass2;
  return (
    <>
      <Section title="Encrypted backup file">
        <p className="text-[13px] text-muted mb-3">
          Saves your key, contacts, rooms, networks (with owner keys) and settings in one file, locked with a passphrase
          (Argon2id + XSalsa20-Poly1305). Without the passphrase the file is useless.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Passphrase" hint="8+ characters. A sentence is best.">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Repeat passphrase">
            <Input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm py-3">
          <input type="checkbox" checked={withMessages} onChange={(e) => setWithMessages(e.target.checked)} className="size-4" />
          Include message history
        </label>
        <Button variant="primary" icon={<Download className="size-4" />} disabled={!ok} loading={busy === "export"}
          onClick={async () => {
            setBusy("export");
            try {
              if (await exportBackup(pass, withMessages)) {
                toast({ level: "success", title: "Backup saved", body: "Keep the file and the passphrase in different places." });
                setPass("");
                setPass2("");
              }
            } catch (e) {
              toast({ level: "error", title: "Backup failed", body: (e as Error).message });
            } finally {
              setBusy(null);
            }
          }}>
          Save backup file
        </Button>
      </Section>
      <Section title="Restore from a backup">
        <p className="text-[13px] text-muted mb-3">Replaces the account on this PC with the one in the file.</p>
        <div className="flex gap-2 items-end">
          <Button icon={<Upload className="size-4" />} onClick={async () => setFile(await api.openTextFile())}>
            {file ? "File chosen" : "Choose file"}
          </Button>
          <Input type="password" value={importPass} onChange={(e) => setImportPass(e.target.value)} placeholder="Passphrase" className="flex-1" aria-label="Backup passphrase" />
          <Button variant="primary" disabled={!file || !importPass} loading={busy === "import"}
            onClick={async () => {
              setBusy("import");
              try {
                await importBackup(file!, importPass);
                toast({ level: "success", title: "Account restored" });
                setFile(null);
                setImportPass("");
              } catch (e) {
                toast({ level: "error", title: "Restore failed", body: (e as Error).message });
              } finally {
                setBusy(null);
              }
            }}>
            Restore
          </Button>
        </div>
      </Section>
    </>
  );
}

export function AccountDialog() {
  const { panels, setPanel, identity, settings } = useApp();
  if (!identity) return null;
  const fp = toHex(identity.fp);
  return (
    <Dialog open={panels.account} onOpenChange={(o) => setPanel("account", o)} title="Your account" size="lg"
      description="One key pair is your identity everywhere. Keep a way to get it back.">
      <div className="flex items-center gap-5 p-5 rounded-lg bg-sunken mb-6">
        <Identicon fp={fp} size={56} />
        <div className="space-y-1.5 min-w-0">
          <p className="font-semibold">{settings.name}</p>
          <FingerprintDisplay fp={fp} />
        </div>
        <KeyRound className="size-5 text-accent ml-auto" />
      </div>
      <Phrase />
      <Backup />
      <Row title="Guest identity" text="Wi-Fi nodes see a different pseudonym for you on every network. It is derived from your key, so it survives restores.">
        <span className="text-xs text-muted">Automatic</span>
      </Row>
    </Dialog>
  );
}
