import { toHex } from "@core/bytes";
import * as Tabs from "@radix-ui/react-tabs";
import { FingerprintDisplay, Identicon } from "@ui/identity";
import { Dialog, Switch } from "@ui/overlays";
import { Button, cn, Input, Kbd, Segmented } from "@ui/primitives";
import {
  Bug, Info, Monitor, Moon, Network, Palette, ShieldCheck, Sun, Trash2, UserRound,
} from "lucide-react";
import { VERSION } from "@core/protocol";
import type { AppInfo, UpdateInfo } from "@shared/api";
import { useEffect, useId, useState, type ReactNode } from "react";
import { assessFirmware, wantsUpdate } from "@core/firmware";
import { api } from "../lib/platform";
import { useApp, type Accent } from "../lib/store";

const accents: { value: Accent; label: string; swatch: string }[] = [
  { value: "teal", label: "Signal teal", swatch: "#2ee6a6" },
  { value: "blue", label: "Blue", swatch: "#4da3ff" },
  { value: "violet", label: "Violet", swatch: "#a78bfa" },
  { value: "amber", label: "Amber", swatch: "#f5b83d" },
  { value: "rose", label: "Rose", swatch: "#fb7185" },
  { value: "lime", label: "Lime", swatch: "#a3e635" },
];

function Row({ title, text, children }: { title: string; text?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 py-4 border-b border-line last:border-0">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {text && <p className="text-[13px] text-muted mt-0.5 leading-relaxed">{text}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SwitchRow({ title, text, checked, onChange }: { title: string; text?: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId();
  return (
    <Row title={title} text={text}>
      <Switch id={id} label={title} checked={checked} onCheckedChange={onChange} />
    </Row>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-faint mb-1">{title}</h3>
      <div>{children}</div>
    </section>
  );
}

function Appearance() {
  const { settings: s, updateSetting } = useApp();
  return (
    <>
      <Section title="Theme">
        <Row title="Color mode" text="System follows your Windows setting.">
          <Segmented
            label="Color mode"
            value={s.theme}
            onChange={(v) => updateSetting("theme", v)}
            options={[
              { value: "system", label: "System", icon: <Monitor /> },
              { value: "light", label: "Light", icon: <Sun /> },
              { value: "dark", label: "Dark", icon: <Moon /> },
            ]}
          />
        </Row>
        <Row title="Accent color">
          <div role="radiogroup" aria-label="Accent color" className="flex gap-2">
            {accents.map((a) => (
              <button
                key={a.value}
                role="radio"
                aria-checked={s.accent === a.value}
                aria-label={a.label}
                title={a.label}
                onClick={() => updateSetting("accent", a.value)}
                className={cn(
                  "size-7 rounded-full ring-offset-2 ring-offset-surface transition-shadow duration-(--dur-fast)",
                  s.accent === a.value ? "ring-2 ring-fg" : "hover:ring-2 hover:ring-line-strong",
                )}
                style={{ background: a.swatch }}
              />
            ))}
          </div>
        </Row>
      </Section>
      <Section title="Layout">
        <Row title="Density">
          <Segmented
            label="Density"
            value={s.density}
            onChange={(v) => updateSetting("density", v)}
            options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]}
          />
        </Row>
        <Row title="Text size">
          <Segmented
            label="Text size"
            value={String(s.fontScale)}
            onChange={(v) => updateSetting("fontScale", Number(v))}
            options={[
              { value: "0.9", label: "S" }, { value: "1", label: "M" },
              { value: "1.1", label: "L" }, { value: "1.25", label: "XL" },
            ]}
          />
        </Row>
        <SwitchRow title="Show timestamps" checked={s.showTimestamps} onChange={(v) => updateSetting("showTimestamps", v)} />
      </Section>
    </>
  );
}

function Profile() {
  const { settings: s, updateSetting, identity } = useApp();
  const [name, setName] = useState(s.name);
  const fp = identity ? toHex(identity.fp) : "";
  const valid = name.trim().length > 0 && new TextEncoder().encode(name.trim()).length <= 32;
  return (
    <>
      <Section title="Profile">
        <Row title="Display name" text="Sent in announcements. Anyone can pick any name, so names are not proof.">
          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (valid) updateSetting("name", name.trim()); }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} aria-label="Display name" className="w-44" />
            <Button type="submit" disabled={!valid || name.trim() === s.name}>Save</Button>
          </form>
        </Row>
      </Section>
      <Section title="Your key">
        <div className="flex items-center gap-5 p-5 rounded-lg bg-sunken">
          <Identicon fp={fp} size={64} />
          <div className="space-y-2">
            <FingerprintDisplay fp={fp} size="lg" />
            <p className="text-[13px] text-muted">
              Show this to contacts when you meet. Your private key never leaves this PC
              {api.platform === "electron" ? " and is locked to your Windows account." : "."}
            </p>
          </div>
        </div>
      </Section>
    </>
  );
}

function UsbSection() {
  const { settings: s, updateSetting, usbDevices, bundledDrivers, installDrivers, driverInstall } = useApp();
  return (
    <Section title="USB boards">
      <SwitchRow
        title="Connect automatically"
        text="When a board is plugged in and nothing is connected, open it."
        checked={s.autoConnect}
        onChange={(v) => updateSetting("autoConnect", v)}
      />
      <SwitchRow
        title="Install missing USB drivers"
        text="If a board has no driver, install the bundled one. Windows asks for permission first."
        checked={s.autoInstallDrivers}
        onChange={(v) => updateSetting("autoInstallDrivers", v)}
      />
      <div className="py-3 space-y-2">
        {usbDevices.length === 0 && <p className="text-[13px] text-muted">No ESP USB boards plugged in.</p>}
        {usbDevices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 p-3 rounded-lg bg-sunken text-sm">
            <span className={cn("size-2 rounded-full", d.driverMissing ? "bg-danger" : "bg-success")} aria-hidden />
            <span className="flex-1 min-w-0">
              <span className="block font-medium truncate">{d.name}</span>
              <span className="block text-xs text-muted">
                {d.bridge} · {d.driverMissing ? "driver missing" : d.com ?? "no COM port"}
              </span>
            </span>
            {d.driverMissing && (
              <Button
                size="sm"
                variant="primary"
                loading={driverInstall === "running"}
                disabled={!bundledDrivers.includes(d.bridge)}
                onClick={() => installDrivers([d.bridge])}
              >
                {bundledDrivers.includes(d.bridge) ? "Install driver" : "No bundled driver"}
              </Button>
            )}
          </div>
        ))}
      </div>
      <Row
        title="Pre-install drivers"
        text={bundledDrivers.length
          ? `Bundled: ${bundledDrivers.join(", ")}. Install now so any board works on first plug-in.`
          : "No drivers are bundled with this build."}
      >
        <Button
          disabled={!bundledDrivers.length}
          loading={driverInstall === "running"}
          onClick={() => installDrivers(bundledDrivers)}
        >
          Install all
        </Button>
      </Row>
    </Section>
  );
}

function NetworkTab() {
  const { settings: s, updateSetting, conn, neighbors, firmware, setPanel } = useApp();
  const bundled = firmware?.manifest.version;
  const fw = conn.status === "connected" && conn.kind === "usb"
    ? assessFirmware({ nodeFw: conn.fwVersion, nodeProtocol: conn.protocol ?? VERSION, nodeChip: conn.chip, appProtocol: VERSION, bundled: firmware?.manifest })
    : null;
  const outdated = !!fw && wantsUpdate(fw);
  return (
    <>
      <Section title="Presence">
        <Row title="Announce interval" text="How often your name and key are broadcast so others can find you.">
          <Segmented
            label="Announce interval"
            value={String(s.announceInterval)}
            onChange={(v) => updateSetting("announceInterval", Number(v))}
            options={[{ value: "15", label: "15 s" }, { value: "30", label: "30 s" }, { value: "60", label: "1 min" }, { value: "300", label: "5 min" }]}
          />
        </Row>
      </Section>
      <Section title="Current node">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm py-3">
          <dt className="text-muted">Status</dt><dd className="capitalize">{conn.status}</dd>
          <dt className="text-muted">Link</dt><dd>{conn.label ?? "—"}</dd>
          <dt className="text-muted">Node id</dt><dd className="font-mono text-[13px]">{conn.chipId?.toString(16).toUpperCase() ?? "—"}</dd>
          <dt className="text-muted">Firmware</dt>
          <dd>{conn.status === "connected" ? (conn.fwVersion ? `v${conn.fwVersion}` : "v0.1 (no version info)") : "—"}</dd>
          <dt className="text-muted">Chip</dt>
          <dd>{conn.status === "connected" ? (conn.chip ?? (fw?.chip && fw.chip !== "unknown" ? `${fw.chip} (assumed)` : "unknown")) : "—"}</dd>
          <dt className="text-muted">MAC</dt><dd className="font-mono text-[13px]">{conn.mac ?? "—"}</dd>
          <dt className="text-muted">Nodes in range</dt>
          <dd className="font-mono text-[13px]">
            {Object.keys(neighbors).length ? Object.keys(neighbors).map((n) => Number(n).toString(16).toUpperCase()).join(", ") : "—"}
          </dd>
        </dl>
      </Section>
      {api.platform === "electron" && <UsbSection />}
      <Section title="Node firmware">
        <Row
          title={bundled ? `Bundled firmware v${bundled}` : "No firmware bundled"}
          text={fw && fw.state !== "current"
            ? fw.message
            : "Install MeshLink on a new ESP8266, or update an existing node."}
        >
          <Button
            variant={outdated ? "primary" : "secondary"}
            disabled={!firmware}
            onClick={() => { setPanel("settings", false); setPanel("flasher", true); }}
          >
            {outdated ? "Update node" : "Flash a board"}
          </Button>
        </Row>
      </Section>
      <WifiSection />
    </>
  );
}

function WifiSection() {
  const { settings: s, updateSetting, knownNodes, forgetNode, connectWifi, conn } = useApp();
  const nodes = Object.values(knownNodes);
  return (
    <Section title="Wi-Fi nodes">
      <SwitchRow
        title="Connect over Wi-Fi automatically"
        text="With no USB board, look for known nodes on your network, then for their hotspots."
        checked={s.autoWifi}
        onChange={(v) => updateSetting("autoWifi", v)}
      />
      <SwitchRow
        title="Allow joining a node's hotspot"
        text="The PC leaves its current Wi-Fi (and internet) while connected, and goes back afterwards."
        checked={s.allowHotspot}
        onChange={(v) => updateSetting("allowHotspot", v)}
      />
      <div className="py-3 space-y-2">
        {nodes.length === 0 && <p className="text-[13px] text-muted">No known nodes yet. Plug a node in once over USB, and the app remembers its Wi-Fi.</p>}
        {nodes.map((n) => (
          <div key={n.chipId} className="flex items-center gap-3 p-3 rounded-lg bg-sunken text-sm">
            <span className="flex-1 min-w-0">
              <span className="block font-medium truncate">{n.name}</span>
              <span className="block text-xs text-muted truncate">{n.ssid || "Hotspot off"} · last seen {new Date(n.lastSeen).toLocaleDateString()}</span>
            </span>
            <Button size="sm" disabled={conn.status === "connected" && conn.chipId === n.chipId} onClick={() => connectWifi(n)}>Connect</Button>
            <Button size="sm" variant="ghost" onClick={() => forgetNode(n.chipId)}>Forget</Button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Privacy() {
  const { settings: s, updateSetting, wipe } = useApp();
  const [confirm, setConfirm] = useState("");
  return (
    <>
      <Section title="Visibility">
        <SwitchRow
          title="Stealth mode"
          text="Never announce automatically. You can still announce by hand from the sidebar."
          checked={s.stealth}
          onChange={(v) => updateSetting("stealth", v)}
        />
        <SwitchRow
          title="Message pop-ups"
          text="Show a notification with message text when a chat is not open."
          checked={s.notifyToasts}
          onChange={(v) => updateSetting("notifyToasts", v)}
        />
        <SwitchRow
          title="Windows notifications"
          text="When MeshLink is in the background, show a Windows notification."
          checked={s.notifyNative}
          onChange={(v) => updateSetting("notifyNative", v)}
        />
        <SwitchRow
          title="Show message text in Windows notifications"
          text={'Off: Windows only shows "New message", so nothing is readable on the lock screen or in notification history.'}
          checked={s.notifyPreview}
          onChange={(v) => updateSetting("notifyPreview", v)}
        />
      </Section>
      {api.platform === "electron" && (
        <Section title="Background">
          <SwitchRow
            title="Keep running in the tray"
            text="Closing the window keeps MeshLink running, so messages and receipts still arrive."
            checked={s.closeToTray}
            onChange={(v) => updateSetting("closeToTray", v)}
          />
          <SwitchRow
            title="Start with Windows"
            text="Opens hidden in the tray when you sign in (needs the tray option)."
            checked={s.launchAtLogin}
            onChange={(v) => updateSetting("launchAtLogin", v)}
          />
        </Section>
      )}
      <Section title="Storage">
        <Row title="Encryption at rest" text={api.platform === "electron"
          ? "Your key and message history are encrypted with Windows DPAPI."
          : "Browser preview: data is stored unencrypted. Use the desktop app for real use."}>
          <ShieldCheck className={cn("size-5", api.platform === "electron" ? "text-success" : "text-warning")} />
        </Row>
      </Section>
      <Section title="Danger zone">
        <div className="p-4 rounded-lg border border-danger/40 bg-danger/5 space-y-3">
          <div>
            <p className="text-sm font-medium">Panic wipe</p>
            <p className="text-[13px] text-muted">Delete your key, contacts, messages and settings from this PC. This cannot be undone.</p>
          </div>
          <div className="flex gap-2">
            <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder='Type "WIPE"' aria-label="Type WIPE to confirm" className="w-40" />
            <Button variant="danger" icon={<Trash2 className="size-4" />} disabled={confirm !== "WIPE"} onClick={wipe}>
              Wipe everything
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}

function Advanced() {
  const { settings: s, updateSetting, log } = useApp();
  return (
    <>
      <Section title="Input">
        <SwitchRow title="Enter sends" text="Off: Enter adds a new line, Ctrl+Enter sends." checked={s.enterToSend} onChange={(v) => updateSetting("enterToSend", v)} />
      </Section>
      <Section title="Diagnostics">
        <SwitchRow title="Frame log" text="Record raw radio frames. Content stays encrypted." checked={s.frameLog} onChange={(v) => updateSetting("frameLog", v)} />
        {s.frameLog && (
          <pre className="mt-2 h-56 overflow-auto rounded-md bg-sunken p-3 font-mono text-[11px] leading-relaxed text-muted">
            {log.length === 0 ? "No frames yet." : log.slice(-200).map((l) =>
              `${new Date(l.t).toLocaleTimeString()} ${l.dir.padEnd(4)} ${l.text}`).join("\n")}
          </pre>
        )}
      </Section>
      <Section title="Shortcuts">
        <ul className="text-sm space-y-2 py-2">
          <li className="flex justify-between"><span>Search contacts</span><Kbd>Ctrl K</Kbd></li>
          <li className="flex justify-between"><span>Settings</span><Kbd>Ctrl ,</Kbd></li>
          <li className="flex justify-between"><span>Details panel</span><Kbd>Ctrl I</Kbd></li>
          <li className="flex justify-between"><span>New room</span><Kbd>Ctrl N</Kbd></li>
        </ul>
      </Section>
    </>
  );
}

function Versions() {
  const { settings: s, updateSetting, conn, firmware } = useApp();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    api.getAppInfo().then(setInfo).catch(() => {});
  }, []);
  const check = async () => {
    setChecking(true);
    try {
      setUpdate(await api.checkForUpdate());
    } finally {
      setChecking(false);
    }
  };
  const nodeFw = conn.status === "connected" ? (conn.fwVersion ? `v${conn.fwVersion}` : "v0.1") : "not connected";
  return (
    <>
      <Section title="Versions">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm py-3">
          <dt className="text-muted">App</dt><dd className="font-mono text-[13px]">v{info?.version ?? __APP_VERSION__}</dd>
          <dt className="text-muted">Bundled firmware</dt><dd className="font-mono text-[13px]">{firmware ? `v${firmware.manifest.version}` : "—"}</dd>
          <dt className="text-muted">Node firmware</dt><dd className="font-mono text-[13px]">{nodeFw}{conn.status === "connected" && conn.chip ? ` · ${conn.chip}` : ""}</dd>
          <dt className="text-muted">Protocol</dt><dd className="font-mono text-[13px]">v{VERSION}</dd>
          {info?.electron && (<><dt className="text-muted">Electron</dt><dd className="font-mono text-[13px]">{info.electron} · Chromium {info.chrome}</dd></>)}
          <dt className="text-muted">Platform</dt><dd className="font-mono text-[13px]">{info?.platform ?? "—"}</dd>
        </dl>
      </Section>
      {api.platform === "electron" && (
        <Section title="Updates">
          <Row
            title={update?.newer ? `MeshLink ${update.latest} is available` : "Check for updates"}
            text={update
              ? update.error ?? (update.newer ? `You have ${update.current}. Download it from GitHub; nothing installs by itself.` : `You run the latest release (${update.current}).`)
              : "Asks GitHub Releases once. Nothing is downloaded or installed automatically."}
          >
            {update?.newer && update.url
              ? <Button variant="primary" onClick={() => api.openReleasePage(update.url!)}>View release</Button>
              : <Button loading={checking} onClick={check}>Check now</Button>}
          </Row>
          {update?.newer && update.notes && (
            <pre className="text-xs text-muted whitespace-pre-wrap max-h-40 overflow-auto bg-sunken rounded-md p-3 font-mono">{update.notes}</pre>
          )}
          <SwitchRow
            title="Check for updates on start"
            text="Off by default. When on, the app contacts api.github.com at every start, which reveals to GitHub that this IP address runs MeshLink."
            checked={s.checkUpdates}
            onChange={(v) => updateSetting("checkUpdates", v)}
          />
        </Section>
      )}
    </>
  );
}

function About() {
  return (
    <div className="space-y-3 text-sm text-muted leading-relaxed">
      <Versions />
      <p><strong className="text-fg">MeshLink {__APP_VERSION__}</strong> · protocol v{VERSION} · free software under GPL-3.0</p>
      <p>Private, off-grid messaging over ESP8266 nodes. Direct messages use NaCl box (X25519 + XSalsa20-Poly1305) with the
        recipient hidden; rooms use a shared key with signed messages (Ed25519). Nodes relay ciphertext only.</p>
      <p>Networks tag every radio frame with a keyed BLAKE2s hash, so outsiders cannot inject into your mesh.</p>
      <p>Limits: anyone nearby can see that radio traffic exists and roughly how much. There is no forward secrecy: keep your key safe.</p>
      <p>
        Source code, security policy and releases:{" "}
        <a className="text-accent underline" href="https://github.com/imBloxi/meshlink" target="_blank" rel="noreferrer">github.com/imBloxi/meshlink</a>.
        Found a vulnerability? Please report it privately, see SECURITY.md.
      </p>
    </div>
  );
}

const tabs = [
  { id: "appearance", label: "Appearance", icon: <Palette />, body: <Appearance /> },
  { id: "profile", label: "Profile & key", icon: <UserRound />, body: <Profile /> },
  { id: "network", label: "Network", icon: <Network />, body: <NetworkTab /> },
  { id: "privacy", label: "Privacy & security", icon: <ShieldCheck />, body: <Privacy /> },
  { id: "advanced", label: "Advanced", icon: <Bug />, body: <Advanced /> },
  { id: "about", label: "About", icon: <Info />, body: <About /> },
];

export function SettingsDialog() {
  const { panels, setPanel } = useApp();
  return (
    <Dialog open={panels.settings} onOpenChange={(o) => setPanel("settings", o)} title="Settings" size="xl">
      <Tabs.Root defaultValue="appearance" orientation="vertical" className="flex gap-6 h-full">
        <Tabs.List aria-label="Settings sections" className="w-48 shrink-0 flex flex-col gap-0.5">
          {tabs.map((t) => (
            <Tabs.Trigger
              key={t.id}
              value={t.id}
              className={cn(
                "flex items-center gap-2.5 h-9 px-3 rounded-md text-sm text-muted text-left [&_svg]:size-4",
                "hover:text-fg hover:bg-sunken data-[state=active]:bg-accent-soft data-[state=active]:text-accent",
              )}
            >
              {t.icon}
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {tabs.map((t) => (
          <Tabs.Content key={t.id} value={t.id} className="flex-1 min-w-0 outline-none">
            {t.body}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </Dialog>
  );
}
