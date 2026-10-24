import { Dialog } from "@ui/overlays";
import { Badge, Button, Input } from "@ui/primitives";
import type { DiscoveredNode, KnownNode, WifiNetwork } from "@shared/api";
import { CircleAlert, LoaderCircle, MapPin, Radio, RefreshCw, Unplug, Usb, Wifi, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../lib/platform";
import { SimLink, usbBridgeName, WebSerialLink } from "../lib/links";
import { useApp } from "../lib/store";
import { ChoiceCard, PortList, useSerialPicker } from "./PortPicker";

function WifiPane({ onDone }: { onDone: () => void }) {
  const { knownNodes, connectWifi, wifiBusy } = useApp();
  const [scan, setScan] = useState<{ lan: DiscoveredNode[]; nets: WifiNetwork[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ ssid: string; psk: string } | null>(null);
  const known = Object.values(knownNodes);

  const look = async () => {
    setBusy(true);
    const [lan, wifi] = await Promise.all([api.discoverNodes(1500), api.wifiScan()]);
    setScan({ lan, nets: wifi.networks.filter((n) => n.ssid.startsWith("MeshLink-") || known.some((k) => k.ssid === n.ssid)), error: wifi.error });
    setBusy(false);
  };

  const go = async (node: KnownNode, viaLan?: string) => {
    if (await connectWifi(node, { viaLan })) onDone();
  };

  const card = (key: string, title: string, text: string, action: ReactNode) => (
    <li key={key} className="flex items-center gap-3 p-3 rounded-lg border border-line bg-raised">
      <Wifi className="size-4 text-accent shrink-0" />
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium truncate">{title}</span>
        <span className="block text-xs text-muted truncate">{text}</span>
      </span>
      {action}
    </li>
  );

  return (
    <div className="space-y-4">
      {wifiBusy && <p className="flex items-center gap-2 text-sm text-accent"><LoaderCircle className="size-4 animate-spin" />{wifiBusy}</p>}
      {known.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-faint">Known nodes</p>
          <ul className="space-y-1.5">
            {known.map((k) => card(String(k.chipId), k.name, k.ssid ? `Hotspot ${k.ssid}` : "Hotspot off",
              <Button size="sm" variant="primary" disabled={!!wifiBusy || !k.ssid} onClick={() => go(k)}>Connect</Button>))}
          </ul>
        </div>
      )}
      <Button className="w-full" icon={busy ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} onClick={look} disabled={busy}>
        Look for nodes
      </Button>
      {scan && (
        <div className="space-y-2">
          {scan.error === "location" && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-warning/10 text-xs text-warning">
              <span className="flex-1">Windows only lists Wi-Fi networks when Location is on. Known nodes still connect without it.</span>
              <Button size="sm" onClick={() => api.openLocationSettings()}>Open settings</Button>
            </div>
          )}
          <ul className="space-y-1.5">
            {scan.lan.map((d) => card(`lan-${d.ip}`, d.name, `On your network · ${d.ip}`,
              <Button size="sm" variant="primary" disabled={!!wifiBusy} onClick={() => go(
                knownNodes[String(d.chipId)] ?? { chipId: d.chipId, name: d.name, netId: d.netId, ssid: "", psk: "", hidden: false, lastIp: d.ip, lastSeen: Date.now() }, d.ip,
              )}>Connect</Button>))}
            {scan.nets.map((n) => {
              const k = known.find((x) => x.ssid === n.ssid);
              return card(`ap-${n.ssid}`, n.ssid, `${n.signal}% signal${k ? " · known" : n.secured ? " · needs password" : " · open"}`,
                <Button size="sm" disabled={!!wifiBusy} onClick={() => (k ? go(k) : setManual({ ssid: n.ssid, psk: "" }))}>{k ? "Connect" : "Join"}</Button>);
            })}
            {!scan.lan.length && !scan.nets.length && <li className="text-sm text-muted py-2">No MeshLink nodes found nearby.</li>}
          </ul>
        </div>
      )}
      {manual && (
        <form className="space-y-2 p-3 rounded-lg bg-sunken" onSubmit={(e) => {
          e.preventDefault();
          go({ chipId: 0, name: manual.ssid, netId: 0, ssid: manual.ssid, psk: manual.psk, hidden: false, lastIp: "192.168.4.1", lastSeen: Date.now() });
          setManual(null);
        }}>
          <p className="text-sm font-medium">Password for {manual.ssid}</p>
          <p className="text-xs text-muted">Ask the node&apos;s admin. Leave empty for an open hotspot.</p>
          <div className="flex gap-2">
            <Input type="password" value={manual.psk} onChange={(e) => setManual({ ...manual, psk: e.target.value })} className="flex-1" aria-label="Hotspot password" />
            <Button type="submit" variant="primary">Join</Button>
          </div>
        </form>
      )}
      <p className="flex gap-2 text-xs text-muted"><MapPin className="size-3.5 shrink-0 mt-0.5" />
        Over Wi-Fi you are a guest: the node&apos;s admin can limit or remove you. Your messages stay end-to-end encrypted either way.
      </p>
    </div>
  );
}

export function ConnectDialog() {
  const { panels, setPanel, connect, disconnect, conn, firmware } = useApp();
  const open = panels.connect;
  const { ports, cancel, choose } = useSerialPicker(open);
  const [error, setError] = useState<string | null>(null);
  const [wifi, setWifi] = useState(false);
  const serialSupported = "serial" in navigator;

  const close = () => {
    cancel();
    setError(null);
    setWifi(false);
    setPanel("connect", false);
  };

  const pickUsb = async () => {
    setError(null);
    try {
      const port = await navigator.serial.requestPort();
      const name = usbBridgeName(port.getInfo().usbVendorId) ?? "USB serial";
      setPanel("connect", false);
      await connect(new WebSerialLink(port, name));
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return; // cancelled
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const useSim = async () => {
    setPanel("connect", false);
    await connect(new SimLink());
  };

  const openFlasher = () => {
    setPanel("connect", false);
    setPanel("flasher", true);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? setPanel("connect", true) : close())}
      title={ports ? "Choose a port" : "Connect a node"}
      description={ports ? "Pick the COM port of your MeshLink ESP8266." : "The app talks to the mesh through a MeshLink node."}
    >
      {ports ? (
        <PortList ports={ports} onChoose={choose} onBack={cancel} />
      ) : wifi ? (
        <div className="space-y-4">
          <WifiPane onDone={close} />
          <Button variant="ghost" onClick={() => setWifi(false)}>Back</Button>
        </div>
      ) : (
        <div className="space-y-3">
          {conn.status !== "disconnected" && (
            <div className="flex items-center gap-3 p-3 rounded-lg bg-sunken text-sm">
              <span className="flex-1">
                Connected to <strong>{conn.label}</strong>
                {conn.mac && <span className="text-muted font-mono text-xs"> · {conn.mac}</span>}
              </span>
              <Button size="sm" variant="secondary" icon={<Unplug className="size-3.5" />} onClick={() => { disconnect(); setPanel("connect", false); }}>
                Disconnect
              </Button>
            </div>
          )}
          <ChoiceCard
            icon={<Usb />}
            title="USB node"
            text={serialSupported ? "Plugged into this PC. You become the node's admin." : "Web Serial is not available here"}
            onClick={pickUsb}
            disabled={!serialSupported}
          />
          <ChoiceCard
            icon={<Wifi />}
            title="Wi-Fi node"
            text={api.platform === "electron" ? "Join a node's hotspot, or one on your network, as a guest" : "Needs the desktop app"}
            onClick={() => setWifi(true)}
            disabled={api.platform !== "electron"}
          />
          <ChoiceCard
            icon={<Zap />}
            title="Flash a new board"
            text={firmware
              ? `Install MeshLink firmware v${firmware.manifest.version} on an ESP8266`
              : "Available in the desktop app"}
            badge={firmware ? <Badge tone="accent">v{firmware.manifest.version}</Badge> : undefined}
            onClick={openFlasher}
            disabled={!firmware || !serialSupported}
          />
          <ChoiceCard
            icon={<Radio />}
            title="Simulator"
            text="Chat with other MeshLink windows on this PC. No hardware."
            badge={<Badge>Test</Badge>}
            onClick={useSim}
          />
          {error && (
            <p role="alert" className="flex gap-2 text-sm text-danger">
              <CircleAlert className="size-4 shrink-0 mt-0.5" /> {error}
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
