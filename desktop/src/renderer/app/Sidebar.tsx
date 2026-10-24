import { toHex } from "@core/bytes";
import { netIdHex } from "@core/network";
import type { Room } from "@core/rooms";
import { Identicon, TrustBadge } from "@ui/identity";
import { Badge, Button, cn, IconButton, Input, Kbd, StatusDot, Tooltip } from "@ui/primitives";
import {
  Crown, Globe, Hash, KeyRound, Lock, Megaphone, Network, Plus, Radio, Search, Settings, ShieldHalf, Usb, Wifi,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { isOlder } from "../lib/flasher";
import { dmConv, netKey, presence, roomConv, useApp } from "../lib/store";
import { Logo } from "./Logo";

function ConnectionPill() {
  const conn = useApp((s) => s.conn);
  const neighbors = useApp((s) => Object.keys(s.neighbors).length);
  const setPanel = useApp((s) => s.setPanel);
  const bundled = useApp((s) => s.firmware?.manifest.version);
  const detected = useApp((s) => s.usbDevices.find((d) => d.com && !d.driverMissing));
  const needsDriver = useApp((s) => s.usbDevices.some((d) => d.driverMissing));
  const wifiBusy = useApp((s) => s.wifiBusy);
  const network = useApp((s) => s.networks[netKey(s.conn.netId ?? 0)]);
  const outdated = conn.status === "connected" && conn.kind === "usb" && !!bundled && isOlder(conn.fwVersion, bundled);
  const on = conn.status === "connected";
  const label = on
    ? conn.nodeName || `Node ${conn.chipId?.toString(16).toUpperCase().slice(-4) ?? ""}`
    : conn.status === "connecting" ? "Connecting…" : wifiBusy ?? "Not connected";
  const icon = conn.kind === "sim" ? <Radio /> : conn.kind === "wifi" ? <Wifi /> : <Usb />;
  const sub = on
    ? `${network ? network.name : `Network ${netIdHex(conn.netId ?? 0)}`} · ${neighbors} ${neighbors === 1 ? "node" : "nodes"} near`
    : needsDriver ? "Board found: USB driver missing"
      : detected ? `Board detected on ${detected.com}`
        : "Plug in a node, or click to connect";
  return (
    <button
      onClick={() => setPanel("connect", true)}
      className={cn(
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors duration-(--dur-fast)",
        on ? "border-accent-line bg-accent-soft hover:bg-accent-soft" : "border-line bg-raised hover:border-line-strong",
      )}
    >
      <span
        className={cn(
          "size-8 grid place-items-center rounded-md [&_svg]:size-4",
          on ? "bg-accent text-accent-fg" : "bg-sunken text-muted",
          (conn.status === "connecting" || wifiBusy) && "animate-pulse-ring",
        )}
      >
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{label}</span>
          {on && conn.role === "admin" && <Badge tone="accent" icon={<Crown />}>Admin</Badge>}
          {on && conn.role === "guest" && conn.kind === "wifi" && <Badge>Guest</Badge>}
          {outdated && <Badge tone="warning">Update</Badge>}
        </span>
        <span className="block text-xs text-muted truncate">{sub}</span>
      </span>
    </button>
  );
}

function SectionHead({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="px-4 pt-3 pb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-faint">
      <span>{title}{count !== undefined && <span className="ml-1.5 font-normal">{count}</span>}</span>
      {action}
    </div>
  );
}

function UnreadPill({ n }: { n: number }) {
  if (!n) return null;
  return (
    <span aria-label={`${n} unread`} className="min-w-5 h-5 px-1.5 grid place-items-center rounded-full bg-accent text-accent-fg text-[11px] font-bold">
      {n > 99 ? "99+" : n}
    </span>
  );
}

function RoomRow({ r, active, unread, last, onClick, offNet }: {
  r: Room; active: boolean; unread: number; last?: string; onClick: () => void; offNet: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "w-full flex items-center gap-3 px-2.5 py-(--row-py) rounded-lg text-left transition-colors duration-(--dur-fast)",
        active ? "bg-sunken" : "hover:bg-sunken/60",
        offNet && "opacity-60",
      )}
    >
      <span className={cn(
        "size-[38px] shrink-0 grid place-items-center rounded-[28%] [&_svg]:size-[18px]",
        r.kind === "private" ? "bg-accent-soft text-accent" : "bg-info/12 text-info",
      )}>
        {r.kind === "private" ? <Lock /> : <Hash />}
      </span>
      <span className="flex-1 min-w-0">
        <span className="flex items-center gap-1.5">
          <span className={cn("truncate text-sm", unread ? "font-semibold" : "font-medium")}>{r.name}</span>
          {r.kind === "public" && <Tooltip content="Public room"><Globe className="size-3 text-faint" aria-label="Public" /></Tooltip>}
          {r.muted && <span className="text-[10px] text-faint">muted</span>}
        </span>
        <span className={cn("block truncate text-xs", unread ? "text-fg" : "text-muted")}>
          {offNet ? "On another network" : last ?? `${Object.keys(r.members).length} ${Object.keys(r.members).length === 1 ? "member" : "members"} seen`}
        </span>
      </span>
      <UnreadPill n={r.muted ? 0 : unread} />
    </button>
  );
}

export function Sidebar() {
  const {
    contacts, rooms, messages, unread, selected, select, settings, now, identity, setPanel, conn, announceNow, invites,
    acceptInvite, declineInvite,
  } = useApp();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const netId = conn.netId ?? settings.activeNetId;

  const dms = useMemo(() => Object.values(contacts)
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.fp.includes(q.replace(/\s/g, "")))
    .sort((a, b) => {
      const la = messages[dmConv(a.fp)]?.at(-1)?.ts ?? a.lastSeen / 1000;
      const lb = messages[dmConv(b.fp)]?.at(-1)?.ts ?? b.lastSeen / 1000;
      return lb - la;
    }), [contacts, messages, q]);

  const roomList = useMemo(() => Object.values(rooms)
    .filter((r) => !q || r.name.toLowerCase().includes(q))
    .sort((a, b) => (messages[roomConv(b.id)]?.at(-1)?.ts ?? b.joinedAt / 1000) - (messages[roomConv(a.id)]?.at(-1)?.ts ?? a.joinedAt / 1000)),
  [rooms, messages, q]);

  return (
    <aside className="w-[300px] shrink-0 flex flex-col bg-surface border-r border-line">
      <div className="px-4 pt-4 pb-3 flex items-center justify-between">
        <Logo />
        <div className="flex">
          <IconButton label="Networks" onClick={() => setPanel("networks", true)}><Network /></IconButton>
          {conn.role === "admin" && conn.status === "connected" && (
            <IconButton label="Node admin" onClick={() => setPanel("admin", true)}><ShieldHalf /></IconButton>
          )}
          <IconButton label="Announce me now" onClick={announceNow} disabled={conn.status !== "connected"}>
            <Megaphone />
          </IconButton>
        </div>
      </div>
      <div className="px-3 pb-2 space-y-3">
        <ConnectionPill />
        <Input
          id="contact-search"
          leading={<Search />}
          placeholder="Search chats"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search chats"
        />
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto px-2 pb-2">
        {invites.length > 0 && (
          <>
            <SectionHead title="Invites" count={invites.length} />
            <ul className="space-y-1.5 px-1">
              {invites.map((i) => (
                <li key={i.code} className="p-3 rounded-lg border border-accent-line bg-accent-soft/50 text-sm animate-enter">
                  <p className="font-medium flex items-center gap-1.5"><Lock className="size-3.5 text-accent" />#{i.invite.name}</p>
                  <p className="text-xs text-muted mt-0.5">From {contacts[i.fromFp]?.name ?? "a contact"}</p>
                  <div className="flex gap-2 mt-2">
                    <Button size="sm" variant="primary" onClick={() => acceptInvite(i.code)}>Join</Button>
                    <Button size="sm" variant="ghost" onClick={() => declineInvite(i.code)}>Decline</Button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        <SectionHead
          title="Rooms"
          count={roomList.length}
          action={<IconButton size="sm" label="New or join room" onClick={() => setPanel("newRoom", true)}><Plus /></IconButton>}
        />
        {roomList.length === 0 && (
          <button onClick={() => setPanel("newRoom", true)} className="mx-1 w-[calc(100%-0.5rem)] px-3 py-3 rounded-lg border border-dashed border-line text-sm text-muted hover:text-fg hover:border-line-strong text-left">
            Create a private room or join a public one.
          </button>
        )}
        <ul className="space-y-0.5">
          {roomList.map((r) => {
            const conv = roomConv(r.id);
            const last = messages[conv]?.at(-1);
            return (
              <li key={r.id}>
                <RoomRow
                  r={r}
                  active={selected === conv}
                  unread={unread[conv] ?? 0}
                  last={last ? `${last.outgoing ? "You" : contacts[last.senderFp]?.name ?? r.members[last.senderFp]?.name ?? "Someone"}: ${last.text}` : undefined}
                  onClick={() => select(conv)}
                  offNet={conn.status === "connected" && r.netId !== netId}
                />
              </li>
            );
          })}
        </ul>

        <SectionHead title="Direct messages" count={dms.length} />
        {dms.length === 0 && (
          <p className="px-3 py-3 text-sm text-muted leading-relaxed">
            {q ? "No match." : "People appear here when their MeshLink app announces itself on your mesh."}
          </p>
        )}
        <ul className="space-y-0.5">
          {dms.map((c) => {
            const conv = dmConv(c.fp);
            const last = messages[conv]?.at(-1);
            const n = unread[conv] ?? 0;
            const pres = presence(c, now, settings.announceInterval);
            return (
              <li key={c.fp}>
                <button
                  onClick={() => select(conv)}
                  aria-current={selected === conv ? "page" : undefined}
                  className={cn(
                    "w-full flex items-center gap-3 px-2.5 py-(--row-py) rounded-lg text-left transition-colors duration-(--dur-fast)",
                    selected === conv ? "bg-sunken" : "hover:bg-sunken/60",
                  )}
                >
                  <span className="relative">
                    <Identicon fp={c.fp} size={38} />
                    <StatusDot status={pres} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-surface" />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className={cn("truncate text-sm", n ? "font-semibold" : "font-medium")}>{c.name}</span>
                      <TrustBadge trust={c.verified ? "verified" : "unverified"} compact />
                    </span>
                    <span className={cn("block truncate text-xs", n ? "text-fg" : "text-muted")}>
                      {last ? `${last.outgoing ? "You: " : ""}${last.text}` : pres === "online" ? "Online now" : "No messages yet"}
                    </span>
                  </span>
                  <UnreadPill n={n} />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-line p-3 flex items-center gap-3">
        {identity && <Identicon fp={toHex(identity.fp)} size={34} />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{settings.name}</p>
          <p className="text-xs text-muted truncate">{settings.stealth ? "Stealth mode" : "Visible on mesh"}</p>
        </div>
        <IconButton label="Account & backup" onClick={() => setPanel("account", true)}><KeyRound /></IconButton>
        <IconButton label="Settings (Ctrl+,)" onClick={() => setPanel("settings", true)}><Settings /></IconButton>
      </div>
      <p className="sr-only">
        Shortcuts: <Kbd>Ctrl K</Kbd> search, <Kbd>Ctrl ,</Kbd> settings, <Kbd>Ctrl I</Kbd> details, <Kbd>Ctrl N</Kbd> new room.
      </p>
    </aside>
  );
}
