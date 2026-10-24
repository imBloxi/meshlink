// Node admin console. Only shown while the app is on the node's USB port:
// physical access is what makes someone an admin.
import { netIdHex } from "@core/network";
import * as p from "@core/protocol";
import * as Tabs from "@radix-ui/react-tabs";
import { CopyCode, Field, Qr, Row, Section, SwitchRow } from "@ui/form";
import { Identicon } from "@ui/identity";
import { Dialog } from "@ui/overlays";
import { Badge, Button, cn, Input, Segmented } from "@ui/primitives";
import {
  Activity, Ban, Crown, Gauge, Network as NetIcon, Power, RotateCcw, ShieldHalf, SlidersHorizontal, Undo2, UserX, Users, Wifi,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { netKey, useApp } from "../lib/store";

const PERMS: { value: string; label: string }[] = [
  { value: "0", label: "Read only" }, { value: "1", label: "DMs" }, { value: "2", label: "Full" },
];

const fmtUptime = (s: number) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
};

function Stat({ label, value, icon }: { label: string; value: ReactNode; icon: ReactNode }) {
  return (
    <div className="p-4 rounded-lg bg-sunken">
      <p className="flex items-center gap-1.5 text-xs text-muted [&_svg]:size-3.5">{icon}{label}</p>
      <p className="text-xl font-semibold mt-1 tabular-nums">{value}</p>
    </div>
  );
}

function Overview() {
  const { node, conn, neighbors } = useApp();
  const s = node.status;
  return (
    <>
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Uptime" icon={<Activity />} value={s ? fmtUptime(s.uptime) : "…"} />
        <Stat label="Wi-Fi guests" icon={<Users />} value={s ? `${s.guests} / ${node.config?.guestMax ?? 4}` : "…"} />
        <Stat label="Nodes near" icon={<NetIcon />} value={Object.keys(neighbors).length} />
        <Stat label="Frames in" icon={<Gauge />} value={s?.rx ?? "…"} />
        <Stat label="Relayed" icon={<RotateCcw />} value={s?.relayed ?? "…"} />
        <Stat label="Free memory" icon={<SlidersHorizontal />} value={s ? `${(s.freeHeap / 1024).toFixed(1)} KB` : "…"} />
      </div>
      <Section title="Node">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm py-2">
          <dt className="text-muted">Name</dt><dd>{node.config?.nodeName ?? conn.nodeName ?? "—"}</dd>
          <dt className="text-muted">Chip</dt><dd className="font-mono text-[13px]">{conn.chipId?.toString(16).toUpperCase()} · {conn.mac}</dd>
          <dt className="text-muted">Firmware</dt><dd>v{conn.fwVersion}</dd>
          <dt className="text-muted">Network</dt><dd>{node.config?.netName ?? "—"} <span className="font-mono text-xs text-muted">{netIdHex(conn.netId ?? 0)}</span></dd>
          <dt className="text-muted">Radio channel</dt><dd>{s?.channel ?? node.config?.channel}</dd>
          <dt className="text-muted">Hotspot</dt><dd>{node.config?.apEnabled ? `${node.config.apSsid} · ${s?.apIp ?? ""}` : "Off"}</dd>
          <dt className="text-muted">Home Wi-Fi</dt><dd>{s?.sta === "connected" ? `${node.config?.staSsid} · ${s.staIp} · ${s.rssi} dBm` : s?.sta === "connecting" ? "Connecting…" : "Not used"}</dd>
          <dt className="text-muted">Dropped</dt><dd>{s ? `${s.dropTag} wrong network · ${s.dropRate} rate limit` : "—"}</dd>
        </dl>
      </Section>
    </>
  );
}

function Guests() {
  const { node, kickGuest, banGuest, setGuestPerm, setNodeConfig } = useApp();
  const [confirm, setConfirm] = useState<string | null>(null);
  const cfg = node.config;
  return (
    <>
      <Section title={`Connected guests (${node.sessions.length})`}>
        <p className="text-[13px] text-muted mb-3">
          Guests are shown by a pseudonym that is different on every network, so you can manage them without knowing who they are.
        </p>
        {node.sessions.length === 0 && <p className="text-sm text-muted py-4">No one is connected over Wi-Fi.</p>}
        <ul className="space-y-2">
          {node.sessions.map((g) => (
            <li key={g.pseudo} className="p-3 rounded-lg border border-line">
              <div className="flex items-center gap-3">
                <Identicon fp={g.pseudo} size={34} />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[13px]">{g.pseudo.toUpperCase().match(/.{4}/g)!.join(" ")}</p>
                  <p className="text-xs text-muted">Connected {fmtUptime(g.connectedSecs)} · sent {g.tx} · received {g.rx}</p>
                </div>
                <Segmented label="Permission" value={String(g.perm)} onChange={(v) => setGuestPerm(g.pseudo, Number(v) as p.Perm)} options={PERMS} />
              </div>
              <div className="flex gap-2 mt-2 justify-end">
                <Button size="sm" icon={<UserX className="size-3.5" />} onClick={() => kickGuest(g.pseudo)}>Kick</Button>
                {confirm === g.pseudo ? (
                  <>
                    <Button size="sm" variant="danger" onClick={() => { banGuest(g.pseudo); setConfirm(null); }}>Confirm ban</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" icon={<Ban className="size-3.5" />} onClick={() => setConfirm(g.pseudo)}>Ban</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Rules for new guests">
        <Row title="Default permission" text="Read only: receive only. DMs: direct messages, no rooms. Full: everything.">
          <Segmented label="Default permission" value={String(cfg?.guestPerm ?? 2)}
            onChange={(v) => setNodeConfig({ guestPerm: Number(v) as p.Perm })} options={PERMS} />
        </Row>
        <Row title="Max guests" text="The ESP8266 hotspot allows up to 4.">
          <Segmented label="Max guests" value={String(cfg?.guestMax ?? 4)} onChange={(v) => setNodeConfig({ guestMax: Number(v) })}
            options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))} />
        </Row>
        <Row title="Send limit per guest" text="Frames per minute. Stops one guest from flooding the mesh.">
          <Segmented label="Send limit" value={String(cfg?.guestRate ?? 60)} onChange={(v) => setNodeConfig({ guestRate: Number(v) })}
            options={[{ value: "20", label: "20" }, { value: "60", label: "60" }, { value: "120", label: "120" }, { value: "0", label: "∞" }]} />
        </Row>
      </Section>
    </>
  );
}

const KIND_LABEL: Record<number, string> = { 1: "Guest", 2: "Node", 3: "Network" };

function Bans() {
  const { node, nodeBan, networks, conn, policyBan } = useApp();
  const [kind, setKind] = useState<"2" | "3">("2");
  const [id, setId] = useState("");
  const net = networks[netKey(conn.netId ?? 0)];
  const owner = !!net?.ownerSecret;
  const validId = /^[0-9a-f]{1,8}$/i.test(id.trim());
  return (
    <>
      <Section title="Banned on this node">
        {node.bans.length === 0 && <p className="text-sm text-muted py-3">Nothing banned.</p>}
        <ul className="space-y-1.5">
          {node.bans.map((b) => (
            <li key={`${b.kind}-${b.id}`} className="flex items-center gap-3 p-2.5 rounded-lg bg-sunken">
              <Badge tone={b.kind === 1 ? "warning" : "danger"}>{KIND_LABEL[b.kind]}</Badge>
              <code className="flex-1 font-mono text-[13px]">
                {b.kind === 1 ? b.id.toUpperCase() : new DataView(Uint8Array.from(b.id.match(/../g)!.map((h) => parseInt(h, 16))).buffer).getUint32(0, true).toString(16).toUpperCase()}
              </code>
              <Button size="sm" variant="ghost" icon={<Undo2 className="size-3.5" />}
                onClick={() => nodeBan(b.kind, b.kind === 1 ? b.id : new DataView(Uint8Array.from(b.id.match(/../g)!.map((h) => parseInt(h, 16))).buffer).getUint32(0, true).toString(16), true)}>
                Unban
              </Button>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Block a node or network">
        <p className="text-[13px] text-muted mb-3">
          Block a rogue node by its chip id, so this node ignores its frames. Block a network id to stop relaying it for others.
        </p>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (validId) { nodeBan(Number(kind) as p.BanKind, id.trim()); setId(""); } }}>
          <Segmented label="Block type" value={kind} onChange={setKind} options={[{ value: "2", label: "Node" }, { value: "3", label: "Network" }]} />
          <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="Hex id, e.g. 52B1F3" className="flex-1 font-mono" aria-label="Id to block" />
          <Button type="submit" variant="danger" disabled={!validId}>Block</Button>
        </form>
      </Section>
      {net && net.netId !== 0 && (
        <Section title={`Network-wide bans · ${net.name}`}>
          {owner ? (
            <>
              <p className="text-[13px] text-muted mb-3">
                You own this network. Bans you send are signed and every node on the network applies them, even nodes you have no cable to.
              </p>
              <ul className="space-y-1.5 mb-3">
                {node.sessions.map((g) => (
                  <li key={g.pseudo} className="flex items-center gap-3 p-2.5 rounded-lg bg-sunken">
                    <Identicon fp={g.pseudo} size={24} />
                    <code className="flex-1 font-mono text-[13px]">{g.pseudo.toUpperCase()}</code>
                    <Button size="sm" variant="danger" onClick={() => policyBan(net.netId, p.BAN_GUEST, g.pseudo, "")}>Ban everywhere</Button>
                  </li>
                ))}
              </ul>
              {net.bans.length > 0 && (
                <ul className="space-y-1.5">
                  {net.bans.map((b) => (
                    <li key={`${b.kind}-${b.id}`} className="flex items-center gap-3 p-2.5 rounded-lg border border-line text-sm">
                      <Badge tone="danger">{KIND_LABEL[b.kind]}</Badge>
                      <code className="flex-1 font-mono text-[13px]">{b.id.toUpperCase()}</code>
                      <span className="text-xs text-muted">{new Date(b.at).toLocaleDateString()}</span>
                      <Button size="sm" variant="ghost" onClick={() => policyBan(net.netId, b.kind, b.id, "", true)}>Lift</Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-[13px] text-muted">Only the network owner can ban across the whole network. Your bans above apply to this node.</p>
          )}
        </Section>
      )}
    </>
  );
}

function WifiTab() {
  const { node, setNodeConfig } = useApp();
  const cfg = node.config;
  const [ssid, setSsid] = useState("");
  const [psk, setPsk] = useState("");
  const [sta, setSta] = useState("");
  const [staPsk, setStaPsk] = useState("");
  useEffect(() => {
    setSsid(cfg?.apSsid ?? "");
    setPsk(cfg?.apPsk ?? "");
    setSta(cfg?.staSsid ?? "");
    setStaPsk(cfg?.staPsk ?? "");
  }, [cfg?.apSsid, cfg?.apPsk, cfg?.staSsid, cfg?.staPsk]);
  if (!cfg) return <p className="text-sm text-muted">Reading node settings…</p>;
  const pskOk = cfg.apOpen || psk.length >= 8;
  const joinQr = cfg.apOpen ? `WIFI:T:nopass;S:${cfg.apSsid};${cfg.apHidden ? "H:true;" : ""};` : `WIFI:T:WPA;S:${cfg.apSsid};P:${cfg.apPsk};${cfg.apHidden ? "H:true;" : ""};`;
  const newPsk = () => {
    const abc = "abcdefghjkmnpqrstuvwxyz23456789";
    const r = crypto.getRandomValues(new Uint8Array(14));
    setPsk(Array.from(r, (b) => abc[b % abc.length]).join(""));
  };
  return (
    <>
      <Section title="Node hotspot">
        <SwitchRow title="Hotspot on" text="Lets laptops and phones connect to this node over Wi-Fi as guests."
          checked={!!cfg.apEnabled} onChange={(v) => setNodeConfig({ apEnabled: v })} />
        <div className="grid grid-cols-2 gap-4 py-4">
          <Field label="Name (SSID)"><Input value={ssid} onChange={(e) => setSsid(e.target.value)} maxLength={32} /></Field>
          <Field label="Password" hint={cfg.apOpen ? "Open hotspot: no password." : "At least 8 characters."}>
            <div className="flex gap-2">
              <Input value={psk} onChange={(e) => setPsk(e.target.value)} disabled={cfg.apOpen} className="flex-1 font-mono" />
              <Button type="button" onClick={newPsk} disabled={cfg.apOpen}>New</Button>
            </div>
          </Field>
        </div>
        <div className="flex justify-end pb-3">
          <Button variant="primary" disabled={!ssid.trim() || !pskOk || (ssid === cfg.apSsid && psk === cfg.apPsk)}
            onClick={() => setNodeConfig({ apSsid: ssid.trim(), apPsk: psk })}>Save and restart</Button>
        </div>
        <SwitchRow title="Hide the hotspot name" text="Not listed in Wi-Fi scans. Guests need the name to join." checked={!!cfg.apHidden} onChange={(v) => setNodeConfig({ apHidden: v })} />
        <SwitchRow title="Open hotspot (no password)" text="Anyone nearby can join as a guest. Messages stay end-to-end encrypted." checked={!!cfg.apOpen} onChange={(v) => setNodeConfig({ apOpen: v })} />
      </Section>
      {cfg.apEnabled && (
        <Section title="Share with a phone or laptop">
          <div className="flex gap-5 items-start">
            <Qr value={joinQr} size={150} label="Wi-Fi join QR code" />
            <div className="space-y-2 text-[13px] text-muted min-w-0">
              <p>Scan with the phone camera to join the hotspot, then open <code className="font-mono text-fg">http://192.168.4.1</code>.</p>
              <p>Another PC with MeshLink joins automatically once it knows this node.</p>
              <CopyCode value={`${cfg.apSsid} / ${cfg.apOpen ? "(open)" : cfg.apPsk}`} label="Copy Wi-Fi name and password" />
            </div>
          </div>
        </Section>
      )}
      <Section title="Home Wi-Fi (optional)">
        <p className="text-[13px] text-muted mb-3">
          The node can also join your router, so PCs on your home network reach it without leaving the internet.
          The node then uses the router&apos;s radio channel, and every node of the mesh must use that channel too.
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Network name"><Input value={sta} onChange={(e) => setSta(e.target.value)} placeholder="Leave empty for off" /></Field>
          <Field label="Password"><Input type="password" value={staPsk} onChange={(e) => setStaPsk(e.target.value)} /></Field>
        </div>
        <div className="flex justify-end pt-3">
          <Button disabled={sta === cfg.staSsid && staPsk === cfg.staPsk} onClick={() => setNodeConfig({ staSsid: sta.trim(), staPsk })}>Save and restart</Button>
        </div>
        <SwitchRow title="Guests from home Wi-Fi" text="Let devices on your router network connect as guests. Anyone on that network can then send into the mesh. Off: only the node's hotspot."
          checked={!!cfg.lanGuests} onChange={(v) => setNodeConfig({ lanGuests: v })} />
      </Section>
    </>
  );
}

function NetworkTab() {
  const { node, networks, conn, provisionNode, setPanel, setNodeConfig } = useApp();
  const [name, setName] = useState("");
  useEffect(() => setName(node.config?.nodeName ?? ""), [node.config?.nodeName]);
  const current = networks[netKey(conn.netId ?? 0)];
  const list = Object.values(networks);
  return (
    <>
      <Section title="Node name">
        <form className="flex gap-2 py-2" onSubmit={(e) => { e.preventDefault(); setNodeConfig({ nodeName: name.trim() }); }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} className="flex-1" aria-label="Node name" />
          <Button type="submit" disabled={!name.trim() || name === node.config?.nodeName}>Rename</Button>
        </form>
      </Section>
      <Section title="Network of this node" action={<Button size="sm" variant="ghost" onClick={() => setPanel("networks", true)}>Manage networks</Button>}>
        <p className="text-[13px] text-muted mb-3">
          A node only accepts and delivers traffic of its own network. Nodes of other networks cannot read the tags or inject frames.
        </p>
        <ul className="space-y-2">
          {list.map((n) => {
            const here = n.netId === (conn.netId ?? 0);
            return (
              <li key={n.netId} className={cn("flex items-center gap-3 p-3 rounded-lg border", here ? "border-accent-line bg-accent-soft/40" : "border-line")}>
                <NetIcon className={cn("size-5", here ? "text-accent" : "text-faint")} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium flex items-center gap-2">
                    {n.name}
                    {n.ownerSecret && <Badge tone="accent" icon={<Crown />}>Owner</Badge>}
                  </p>
                  <p className="text-xs text-muted font-mono">{netIdHex(n.netId)} · channel {n.channel}</p>
                </div>
                {here ? <Badge tone="success">This node</Badge> : <Button size="sm" onClick={() => provisionNode(n.netId)}>Move node here</Button>}
              </li>
            );
          })}
        </ul>
        {!current && conn.netId !== 0 && (
          <p className="text-[13px] text-warning mt-3">This node is on a network you have not joined ({netIdHex(conn.netId ?? 0)}).</p>
        )}
      </Section>
    </>
  );
}

function Advanced() {
  const { node, setNodeConfig, rebootNode, factoryResetNode } = useApp();
  const [confirm, setConfirm] = useState("");
  const cfg = node.config;
  if (!cfg) return <p className="text-sm text-muted">Reading node settings…</p>;
  return (
    <>
      <Section title="Radio">
        <Row title="Channel" text="All nodes of a mesh must share it. Changing it restarts the node.">
          <select value={cfg.channel} onChange={(e) => setNodeConfig({ channel: Number(e.target.value) })}
            className="h-9 px-3 rounded-md bg-sunken border border-line text-sm" aria-label="Radio channel">
            {Array.from({ length: 13 }, (_, i) => i + 1).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Row>
        <Row title="Hops (TTL)" text="How many times a message is relayed. More reach, more airtime.">
          <Segmented label="Hops" value={String(cfg.ttl)} onChange={(v) => setNodeConfig({ ttl: Number(v) })}
            options={["1", "2", "3", "5", "7"].map((v) => ({ value: v, label: v }))} />
        </Row>
        <Row title="Relay delay" text="Random wait before relaying, so nearby nodes do not collide.">
          <Segmented label="Relay delay" value={String(cfg.jitterMs)} onChange={(v) => setNodeConfig({ jitterMs: Number(v) })}
            options={[{ value: "0", label: "Off" }, { value: "20", label: "20 ms" }, { value: "40", label: "40 ms" }, { value: "100", label: "100 ms" }]} />
        </Row>
        <Row title="Relay limit per node" text="Frames per second relayed for any one origin node.">
          <Segmented label="Relay limit" value={String(cfg.originRate)} onChange={(v) => setNodeConfig({ originRate: Number(v) })}
            options={[{ value: "5", label: "5/s" }, { value: "10", label: "10/s" }, { value: "25", label: "25/s" }, { value: "0", label: "∞" }]} />
        </Row>
        <Row title="Beacon" text="How often the node says it is here.">
          <Segmented label="Beacon" value={String(cfg.beaconSec)} onChange={(v) => setNodeConfig({ beaconSec: Number(v) })}
            options={[{ value: "5", label: "5 s" }, { value: "10", label: "10 s" }, { value: "30", label: "30 s" }, { value: "0", label: "Off" }]} />
        </Row>
        <SwitchRow title="Help other networks" text="Relay frames of other MeshLink networks without reading them. Blocked networks are skipped."
          checked={!!cfg.relayForeign} onChange={(v) => setNodeConfig({ relayForeign: v })} />
        <SwitchRow title="Stealth node" text="No beacons and a hidden hotspot. The node still relays."
          checked={!!cfg.stealth} onChange={(v) => setNodeConfig({ stealth: v })} />
      </Section>
      <Section title="Maintenance">
        <Row title="Restart node" text="Guests reconnect by themselves.">
          <Button icon={<Power className="size-4" />} onClick={rebootNode}>Restart</Button>
        </Row>
        <div className="p-4 mt-2 rounded-lg border border-danger/40 bg-danger/5 space-y-3">
          <div>
            <p className="text-sm font-medium">Factory reset</p>
            <p className="text-[13px] text-muted">Removes the network, Wi-Fi settings, bans and the hotspot password from this node.</p>
          </div>
          <div className="flex gap-2">
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder='Type "RESET"' className="w-40" aria-label='Type RESET to confirm' />
            <Button variant="danger" disabled={confirm !== "RESET"} onClick={() => { factoryResetNode(); setConfirm(""); }}>Reset node</Button>
          </div>
        </div>
      </Section>
    </>
  );
}

const tabs = [
  { id: "overview", label: "Overview", icon: <Activity />, body: <Overview /> },
  { id: "guests", label: "Guests", icon: <Users />, body: <Guests /> },
  { id: "bans", label: "Bans", icon: <Ban />, body: <Bans /> },
  { id: "wifi", label: "Wi-Fi", icon: <Wifi />, body: <WifiTab /> },
  { id: "network", label: "Network", icon: <NetIcon />, body: <NetworkTab /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontal />, body: <Advanced /> },
];

export function AdminDialog() {
  const { panels, setPanel, conn, refreshNode } = useApp();
  const open = panels.admin && conn.role === "admin" && conn.status === "connected";
  useEffect(() => {
    if (open) refreshNode();
  }, [open, refreshNode]);
  return (
    <Dialog open={open} onOpenChange={(o) => setPanel("admin", o)} title="Node admin" size="xl"
      description="You control this node because it is plugged into this PC.">
      <Tabs.Root defaultValue="overview" orientation="vertical" className="flex gap-6 h-full">
        <Tabs.List aria-label="Admin sections" className="w-44 shrink-0 flex flex-col gap-0.5">
          <div className="flex items-center gap-2 px-3 pb-3 text-xs text-muted"><ShieldHalf className="size-4 text-accent" /> USB admin</div>
          {tabs.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id}
              className="flex items-center gap-2.5 h-9 px-3 rounded-md text-sm text-muted text-left [&_svg]:size-4 hover:text-fg hover:bg-sunken data-[state=active]:bg-accent-soft data-[state=active]:text-accent">
              {t.icon}{t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {tabs.map((t) => (
          <Tabs.Content key={t.id} value={t.id} className="flex-1 min-w-0 outline-none">{t.body}</Tabs.Content>
        ))}
      </Tabs.Root>
    </Dialog>
  );
}
