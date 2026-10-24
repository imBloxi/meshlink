import { netIdHex } from "@core/network";
import { CopyCode, Field, Qr, Section } from "@ui/form";
import { Dialog } from "@ui/overlays";
import { Badge, Button, cn, Input } from "@ui/primitives";
import { Check, Crown, LogOut, Network, Plus, QrCode, Star } from "lucide-react";
import { useState } from "react";
import { useApp } from "../lib/store";

export function NetworksDialog() {
  const { panels, setPanel, networks, settings, updateSetting, createNetwork, joinNetwork, networkCode, leaveNetwork, conn, provisionNode, toast } = useApp();
  const [mode, setMode] = useState<"list" | "create" | "join">("list");
  const [name, setName] = useState("");
  const [channel, setChannel] = useState(6);
  const [code, setCode] = useState("");
  const [show, setShow] = useState<number | null>(null);
  const list = Object.values(networks).sort((a, b) => a.netId === 0 ? -1 : b.netId === 0 ? 1 : a.name.localeCompare(b.name));
  const admin = conn.role === "admin" && conn.status === "connected";

  const close = () => {
    setPanel("networks", false);
    setMode("list");
    setShow(null);
  };

  return (
    <Dialog open={panels.networks} onOpenChange={(o) => (o ? setPanel("networks", true) : close())} title="Networks" size="lg"
      description="A network is a group of nodes that share a secret key. Outsiders cannot inject into it or read its traffic tags.">
      {mode === "list" && (
        <>
          <div className="flex gap-2 mb-5">
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setMode("create")}>Create network</Button>
            <Button icon={<Network className="size-4" />} onClick={() => setMode("join")}>Join with a code</Button>
          </div>
          <ul className="space-y-2">
            {list.map((n) => {
              const active = settings.activeNetId === n.netId;
              const here = conn.status === "connected" && conn.netId === n.netId;
              return (
                <li key={n.netId} className={cn("p-4 rounded-lg border", active ? "border-accent-line bg-accent-soft/30" : "border-line")}>
                  <div className="flex items-center gap-3">
                    <Network className={cn("size-5", active ? "text-accent" : "text-faint")} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium flex items-center gap-2 flex-wrap">
                        {n.name}
                        {n.netId === 0 && <Badge>Public</Badge>}
                        {n.ownerSecret && <Badge tone="accent" icon={<Crown />}>Owner</Badge>}
                        {here && <Badge tone="success">Your node</Badge>}
                      </p>
                      <p className="text-xs text-muted font-mono">{netIdHex(n.netId)} · channel {n.channel}{n.bans.length ? ` · ${n.bans.length} bans` : ""}</p>
                    </div>
                    {!active && <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => updateSetting("activeNetId", n.netId)}>Make default</Button>}
                    {active && <span className="text-xs text-accent inline-flex items-center gap-1"><Check className="size-3.5" />Default</span>}
                  </div>
                  {n.netId !== 0 && (
                    <div className="flex flex-wrap gap-2 mt-3">
                      <Button size="sm" icon={<QrCode className="size-3.5" />} onClick={() => setShow(show === n.netId ? null : n.netId)}>
                        {show === n.netId ? "Hide code" : "Share code"}
                      </Button>
                      {admin && !here && <Button size="sm" onClick={() => provisionNode(n.netId)}>Put my USB node on it</Button>}
                      <Button size="sm" variant="ghost" icon={<LogOut className="size-3.5" />} onClick={() => leaveNetwork(n.netId)}>Forget</Button>
                    </div>
                  )}
                  {show === n.netId && (
                    <div className="flex gap-4 mt-4 items-start animate-enter">
                      <Qr value={networkCode(n.netId)} size={140} label={`Network code for ${n.name}`} />
                      <div className="flex-1 min-w-0 space-y-2">
                        <p className="text-[13px] text-muted">
                          The code holds the network key. Anyone with it can run nodes on this network. It does not let them read your chats:
                          those have their own keys.
                        </p>
                        <CopyCode value={networkCode(n.netId)} label="Copy network code" />
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {mode === "create" && (
        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault();
          const n = createNetwork(name, channel);
          toast({ level: "success", title: `Network "${n.name}" created`, body: "You own it. Put your nodes on it from the admin panel (USB)." });
          if (admin) provisionNode(n.netId);
          setName("");
          setMode("list");
        }}>
          <Section title="New network">
            <p className="text-[13px] text-muted mb-4">
              You become its owner. The owner key stays on this PC (include it in your backups) and signs bans that every node obeys.
            </p>
            <div className="grid grid-cols-[1fr_auto] gap-4">
              <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="e.g. Family mesh" /></Field>
              <Field label="Radio channel">
                <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} className="h-10 px-3 rounded-md bg-sunken border border-line text-sm">
                  {[1, 6, 11].map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
            </div>
          </Section>
          {admin && <p className="text-[13px] text-accent">Your USB node joins it right away.</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setMode("list")}>Back</Button>
            <Button type="submit" variant="primary" disabled={!name.trim()}>Create</Button>
          </div>
        </form>
      )}

      {mode === "join" && (
        <form className="space-y-4" onSubmit={(e) => {
          e.preventDefault();
          try {
            joinNetwork(code);
            setCode("");
            setMode("list");
          } catch (err) {
            toast({ level: "error", title: "Code not accepted", body: (err as Error).message });
          }
        }}>
          <Field label="Network code" hint="Starts with mln1: — get it from the network owner.">
            <textarea value={code} onChange={(e) => setCode(e.target.value)} rows={3} autoFocus placeholder="mln1:…"
              className="w-full rounded-md bg-sunken border border-transparent focus:border-accent-line outline-none p-3 font-mono text-xs" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setMode("list")}>Back</Button>
            <Button type="submit" variant="primary" disabled={!code.trim().startsWith("mln1:")}>Join network</Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
