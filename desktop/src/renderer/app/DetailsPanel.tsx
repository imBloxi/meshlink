import { fromHex, toHex } from "@core/bytes";
import { safetyNumber } from "@core/identity";
import { canModerate, type Room, type RoomMember } from "@core/rooms";
import { FingerprintDisplay, Identicon, TrustBadge } from "@ui/identity";
import { Badge, Button, cn, IconButton, Segmented } from "@ui/primitives";
import {
  Crown, DoorOpen, EyeOff, Hash, Lock, MoreHorizontal, Network, ShieldCheck, ShieldOff, Star, UserMinus, UserPlus, Volume2, VolumeX,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useApp } from "../lib/store";

const when = (ms: number) =>
  ms ? new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

const DISAPPEAR = [
  { value: "0", label: "Off" }, { value: "3600", label: "1 h" }, { value: "86400", label: "1 d" }, { value: "604800", label: "7 d" },
];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="px-6 py-5 space-y-3 border-b border-line">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h4>
      {children}
    </section>
  );
}

function ContactDetails({ fp }: { fp: string }) {
  const { contacts, identity, setVerified, settings, updateSetting, rooms, inviteContact, inviteToNetwork, networks, conn } = useApp();
  const [roomPick, setRoomPick] = useState(false);
  const c = contacts[fp];
  if (!c || !identity) return null;
  const conv = `dm:${fp}`;
  const myFp = toHex(identity.fp);
  const privateRooms = Object.values(rooms).filter((r) => r.kind === "private");
  const ownNets = Object.values(networks).filter((n) => n.netId !== 0);

  return (
    <>
      <div className="flex flex-col items-center text-center gap-3 px-6 pt-8 pb-6 border-b border-line">
        <Identicon fp={c.fp} size={72} />
        <div>
          <h3 className="text-lg font-semibold">{c.name}</h3>
          <div className="mt-1.5"><TrustBadge trust={c.verified ? "verified" : "unverified"} /></div>
        </div>
      </div>

      <Block title="Verify in person">
        <p className="text-xs text-muted leading-relaxed">
          Meet {c.name} and compare this safety number. Both screens must show the same digits.
        </p>
        <code className="block p-3 rounded-lg bg-sunken font-mono text-[13px] leading-6 tracking-wider text-center">
          {safetyNumber(identity.fp, fromHex(c.fp)).split(" ").map((g, i) => (
            <span key={i} className="inline-block w-[4.2em]">{g}</span>
          ))}
        </code>
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Show raw keys</summary>
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2"><Identicon fp={c.fp} size={22} /><FingerprintDisplay fp={c.fp} size="sm" /></div>
            <div className="flex items-center gap-2"><Identicon fp={myFp} size={22} /><FingerprintDisplay fp={myFp} size="sm" /></div>
          </div>
        </details>
        {c.verified ? (
          <Button className="w-full" icon={<ShieldOff className="size-4" />} onClick={() => setVerified(c.fp, false)}>Remove verification</Button>
        ) : (
          <Button variant="primary" className="w-full" icon={<ShieldCheck className="size-4" />} onClick={() => setVerified(c.fp, true)}>
            Numbers match: mark verified
          </Button>
        )}
      </Block>

      <Block title="Disappearing messages">
        <Segmented
          label="Disappearing messages"
          value={String(settings.disappear[conv] ?? 0)}
          onChange={(v) => updateSetting("disappear", { ...settings.disappear, [conv]: Number(v) })}
          options={DISAPPEAR}
        />
        <p className="text-xs text-muted">Deletes messages on this PC after the time. {c.name}&apos;s device keeps its own setting.</p>
      </Block>

      <Block title="Share">
        <Button className="w-full" icon={<UserPlus className="size-4" />} disabled={!privateRooms.length || conn.status !== "connected"} onClick={() => setRoomPick(!roomPick)}>
          Invite to a room
        </Button>
        {roomPick && (
          <ul className="space-y-1">
            {privateRooms.map((r) => (
              <li key={r.id}>
                <button onClick={() => { inviteContact(r.id, c.fp); setRoomPick(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-sunken text-left">
                  <Lock className="size-3.5 text-accent" /> {r.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        {ownNets.map((n) => (
          <Button key={n.netId} className="w-full" icon={<Network className="size-4" />} disabled={conn.status !== "connected"} onClick={() => inviteToNetwork(c.fp, n.netId)}>
            Share network “{n.name}”
          </Button>
        ))}
      </Block>

      <dl className="px-6 py-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
        <dt className="text-muted">First seen</dt><dd className="text-right">{when(c.firstSeen)}</dd>
        <dt className="text-muted">Last seen</dt><dd className="text-right">{when(c.lastSeen)}</dd>
        <dt className="text-muted">Signed identity</dt><dd className="text-right">{c.signPk ? "Yes (Ed25519)" : "Not yet"}</dd>
        <dt className="text-muted">Encryption</dt><dd className="text-right">X25519 · XSalsa20-Poly1305</dd>
      </dl>
    </>
  );
}

function MemberRow({ m, room, me, iMod }: { m: RoomMember; room: Room; me: string; iMod: boolean }) {
  const { contacts, kickMember, setModerator, muteMember, select } = useApp();
  const [open, setOpen] = useState(false);
  const isMe = m.fp === me;
  const name = isMe ? "You" : contacts[m.fp]?.name ?? m.name ?? "Unknown";
  const roleBadge = m.role === "creator" ? <Badge tone="accent" icon={<Crown />}>Owner</Badge>
    : m.role === "moderator" ? <Badge tone="info" icon={<Star />}>Mod</Badge> : null;
  const iOwn = room.creatorFp === me;
  return (
    <li className="rounded-lg hover:bg-sunken/60">
      <div className="flex items-center gap-2.5 px-2 py-1.5">
        <Identicon fp={m.fp} size={28} />
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-1.5 text-sm">
            <span className={cn("truncate", m.muted && "line-through text-muted")}>{name || "Unknown"}</span>
            {roleBadge}
          </span>
          {!m.signPk && <span className="block text-[11px] text-warning">Key not yet seen</span>}
        </span>
        {!isMe && <IconButton size="sm" label="Member actions" onClick={() => setOpen(!open)}><MoreHorizontal /></IconButton>}
      </div>
      {open && !isMe && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-2 animate-enter">
          {contacts[m.fp] && <Button size="sm" variant="ghost" onClick={() => select(`dm:${m.fp}`)}>Message</Button>}
          <Button size="sm" variant="ghost" icon={m.muted ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
            onClick={() => muteMember(room.id, m.fp, !m.muted)}>{m.muted ? "Unmute" : "Mute for me"}</Button>
          {iOwn && m.role !== "creator" && (
            <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => setModerator(room.id, m.fp, m.role !== "moderator")}>
              {m.role === "moderator" ? "Remove mod" : "Make mod"}
            </Button>
          )}
          {iMod && m.role !== "creator" && (
            <Button size="sm" variant="danger" icon={<UserMinus className="size-3.5" />} onClick={() => { kickMember(room.id, m.fp); setOpen(false); }}>
              Remove
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function RoomDetails({ id }: { id: string }) {
  const { rooms, identity, updateRoom, leaveRoom, openRoomDialog } = useApp();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const r = rooms[id];
  if (!r || !identity) return null;
  const me = toHex(identity.fp);
  const iMod = canModerate(r, me);
  const members = Object.values(r.members).sort((a, b) =>
    ["creator", "moderator", "member"].indexOf(a.role) - ["creator", "moderator", "member"].indexOf(b.role) || b.lastSeen - a.lastSeen);

  return (
    <>
      <div className="flex flex-col items-center text-center gap-3 px-6 pt-8 pb-6 border-b border-line">
        <span className={cn("size-16 grid place-items-center rounded-[28%] [&_svg]:size-7",
          r.kind === "private" ? "bg-accent-soft text-accent" : "bg-info/12 text-info")}>
          {r.kind === "private" ? <Lock /> : <Hash />}
        </span>
        <div>
          <h3 className="text-lg font-semibold">{r.name}</h3>
          <p className="text-xs text-muted mt-1">
            {r.kind === "private" ? "Private room · invite only" : "Public room · anyone who knows the name"}
          </p>
        </div>
        {r.kind === "private" && (
          <Button size="sm" variant="primary" icon={<UserPlus className="size-4" />} onClick={() => openRoomDialog(r.id, "invite")}>Invite people</Button>
        )}
      </div>

      <Block title={`Members seen (${members.length})`}>
        {r.kind === "public" && <p className="text-xs text-muted">Public rooms have no owner. You can mute people for yourself.</p>}
        <ul className="space-y-0.5 -mx-2">
          {members.map((m) => <MemberRow key={m.fp} m={m} room={r} me={me} iMod={iMod} />)}
        </ul>
        {!members.length && <p className="text-xs text-muted">Members appear when they post or join.</p>}
      </Block>

      <Block title="Room settings">
        <label className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">{r.muted ? <EyeOff className="size-4" /> : <Volume2 className="size-4" />} Mute notifications</span>
          <input type="checkbox" checked={r.muted} onChange={(e) => updateRoom(r.id, { muted: e.target.checked })} className="size-4" />
        </label>
        <div className="space-y-1.5">
          <p className="text-sm">Disappearing messages</p>
          <Segmented label="Disappearing messages" value={String(r.disappearSecs)}
            onChange={(v) => updateRoom(r.id, { disappearSecs: Number(v) })} options={DISAPPEAR} />
        </div>
      </Block>

      <section className="px-6 py-5">
        {confirmLeave ? (
          <div className="space-y-2">
            <p className="text-sm">Leave #{r.name}? {r.kind === "private" ? "You need a new invite to come back." : ""}</p>
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => leaveRoom(r.id)}>Leave</Button>
              <Button variant="ghost" onClick={() => setConfirmLeave(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button className="w-full" icon={<DoorOpen className="size-4" />} onClick={() => setConfirmLeave(true)}>Leave room</Button>
        )}
      </section>
    </>
  );
}

export function DetailsPanel() {
  const selected = useApp((s) => s.selected);
  if (!selected) return null;
  return (
    <aside aria-label="Details" className="w-[300px] shrink-0 border-l border-line bg-surface overflow-y-auto">
      {selected.startsWith("dm:") ? <ContactDetails fp={selected.slice(3)} /> : <RoomDetails id={selected.slice(5)} />}
    </aside>
  );
}
