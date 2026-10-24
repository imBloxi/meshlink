import { toHex } from "@core/bytes";
import { DM_CHUNK_MAX, ROOM_CHUNK_MAX } from "@core/payloads";
import { canModerate } from "@core/rooms";
import type { StoredMessage } from "@shared/api";
import { Identicon, TrustBadge } from "@ui/identity";
import { Badge, Button, cn, EmptyState, IconButton, StatusDot, Tooltip } from "@ui/primitives";
import {
  AlertTriangle, Check, CheckCheck, Clock, Globe, Hash, Info, Lock, MessagesSquare, RotateCcw, SendHorizontal, Timer,
  Trash2, UserPlus, Usb,
} from "lucide-react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { presence, useApp } from "../lib/store";

const GROUP_GAP_S = 180;

function dayLabel(ts: number) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

const time = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function StateIcon({ m }: { m: StoredMessage }) {
  if (!m.outgoing) return null;
  const map = {
    sending: { icon: <Clock className="size-3" />, text: "Sending" },
    sent: { icon: <Check className="size-3" />, text: m.conv.startsWith("room:") ? "Sent to the mesh" : "Sent, waiting for receipt" },
    delivered: { icon: <CheckCheck className="size-3" />, text: "Delivered" },
    failed: { icon: <AlertTriangle className="size-3" />, text: "Not delivered" },
    received: { icon: null, text: "" },
  }[m.state];
  return <span role="img" aria-label={map.text} title={map.text}>{map.icon}</span>;
}

function Bubble({ m, first, last, showTime, sender, canDelete, onDelete, onRetry }: {
  m: StoredMessage; first: boolean; last: boolean; showTime: boolean;
  sender?: { name: string; fp: string } | null; canDelete: boolean; onDelete: () => void; onRetry: () => void;
}) {
  const failed = m.state === "failed";
  return (
    <div className={cn("group flex gap-2 animate-enter", m.outgoing ? "justify-end" : "justify-start", first ? "mt-3" : "mt-0.5")}>
      {sender !== undefined && !m.outgoing && (
        <span className="w-7 shrink-0 self-end">{last && sender && <Identicon fp={sender.fp} size={28} />}</span>
      )}
      {m.outgoing && canDelete && (
        <span className="self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconButton size="sm" label="Delete for everyone" onClick={onDelete}><Trash2 /></IconButton>
        </span>
      )}
      <div className="max-w-[min(72%,560px)] flex flex-col">
        {sender && first && !m.outgoing && (
          <span className="text-[11.5px] font-medium text-muted px-1 mb-0.5 flex items-center gap-1">
            {sender.name || "Unknown"}
            {m.verified === false && <Badge tone="warning">unverified</Badge>}
          </span>
        )}
        <div
          className={cn(
            "relative px-(--bubble-px) py-(--bubble-py) text-[14.5px] leading-snug shadow-1 whitespace-pre-wrap break-words",
            m.outgoing ? "bg-bubble-out text-accent-fg rounded-2xl rounded-br-md" : "bg-bubble-in border border-line rounded-2xl rounded-bl-md",
            !last && (m.outgoing ? "rounded-br-2xl" : "rounded-bl-2xl"),
            failed && "ring-2 ring-danger/60",
          )}
        >
          {m.text}
          {showTime && last && (
            <span className={cn("ml-2 inline-flex items-center gap-1 align-bottom text-[10.5px] translate-y-0.5",
              m.outgoing ? "text-accent-fg/70" : "text-faint")}>
              {time(m.ts)}
              <StateIcon m={m} />
            </span>
          )}
        </div>
        {failed && (
          <button onClick={onRetry} className="self-end mt-1 inline-flex items-center gap-1 text-[11.5px] text-danger hover:underline">
            <RotateCcw className="size-3" /> Not delivered. Retry
          </button>
        )}
      </div>
      {!m.outgoing && canDelete && (
        <span className="self-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <IconButton size="sm" label="Delete for everyone" onClick={onDelete}><Trash2 /></IconButton>
        </span>
      )}
    </div>
  );
}

function Composer({ disabled, isRoom }: { disabled: boolean; isRoom: boolean }) {
  const { sendText, settings, selected } = useApp();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), [selected]);

  const max = isRoom ? ROOM_CHUNK_MAX : DM_CHUNK_MAX;
  const bytes = new TextEncoder().encode(text).length;
  const parts = Math.max(1, Math.ceil((bytes + (isRoom ? 64 : 0)) / max));

  const send = () => {
    if (!text.trim() || disabled) return;
    sendText(text);
    setText("");
  };

  return (
    <div className="px-5 pb-5 pt-2">
      <div className="flex items-end gap-2 rounded-xl border bg-raised p-2 shadow-1 transition-colors duration-(--dur-fast) border-line focus-within:border-accent-line">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" && !e.shiftKey && settings.enterToSend) || (e.key === "Enter" && e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={disabled ? "Connect a node to send messages" : isRoom ? "Message the room" : "Encrypted message"}
          aria-label="Message"
          className="flex-1 resize-none bg-transparent px-2 py-1.5 text-[14.5px] outline-none placeholder:text-faint [field-sizing:content] min-h-9 max-h-48"
        />
        <IconButton label="Send" onClick={send} disabled={disabled || !text.trim()} className="bg-accent !text-accent-fg hover:brightness-110 hover:!bg-accent">
          <SendHorizontal />
        </IconButton>
      </div>
      <div className="flex justify-between px-1 pt-1.5 text-[11px] text-faint">
        <span className="inline-flex items-center gap-1">
          <Lock className="size-3" /> {isRoom ? "Encrypted with the room key, signed by you" : "End-to-end encrypted, recipient hidden"}
        </span>
        {bytes > 0 && <span>{parts > 1 ? `${parts} radio frames` : `${max - bytes} bytes left in frame`}</span>}
      </div>
    </div>
  );
}

function useAutoScroll(dep: unknown, key: unknown) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep, key]);
  useEffect(() => {
    pinned.current = true;
  }, [key]);
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return { scroller, onScroll };
}

export function Conversation() {
  const {
    selected, contacts, rooms, messages, settings, conn, now, setPanel, panels, identity, retry, deleteMessage, openRoomDialog,
  } = useApp();
  const list = selected ? messages[selected] ?? [] : [];
  const { scroller, onScroll } = useAutoScroll(list.length, selected);
  const myFp = identity ? toHex(identity.fp) : "";

  const isRoom = !!selected?.startsWith("room:");
  const contact = selected?.startsWith("dm:") ? contacts[selected.slice(3)] : null;
  const room = isRoom ? rooms[selected!.slice(5)] : null;

  if (!contact && !room) {
    return (
      <section className="flex-1 grid place-items-center">
        {conn.status === "connected" ? (
          <EmptyState icon={<MessagesSquare />} title="Pick a conversation"
            action={<Button onClick={() => setPanel("newRoom", true)} icon={<Hash className="size-4" />}>Create or join a room</Button>}>
            Contacts appear on the left when their MeshLink app announces itself. Rooms let groups talk together.
          </EmptyState>
        ) : (
          <EmptyState icon={<Usb />} title="Connect a node"
            action={<Button variant="primary" onClick={() => setPanel("connect", true)}>Connect</Button>}>
            Plug a MeshLink node into USB to become its admin, or join a node over Wi-Fi as a guest.
          </EmptyState>
        )}
      </section>
    );
  }

  const disappear = room ? room.disappearSecs : settings.disappear[selected!] ?? 0;
  const iMod = room ? canModerate(room, myFp) : false;
  const offNet = !!room && conn.status === "connected" && room.netId !== (conn.netId ?? 0);

  const header = contact ? (
    <>
      <Identicon fp={contact.fp} size={36} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold truncate">{contact.name}</h2>
          <TrustBadge trust={contact.verified ? "verified" : "unverified"} />
        </div>
        <p className="text-xs text-muted flex items-center gap-1.5">
          {(() => {
            const pres = presence(contact, now, settings.announceInterval);
            return <><StatusDot status={pres} />{pres === "online" ? "In range" : pres === "idle" ? "Seen recently" : "Out of range"}</>;
          })()}
        </p>
      </div>
    </>
  ) : (
    <>
      <span className={cn("size-9 grid place-items-center rounded-[28%] [&_svg]:size-[18px]",
        room!.kind === "private" ? "bg-accent-soft text-accent" : "bg-info/12 text-info")}>
        {room!.kind === "private" ? <Lock /> : <Hash />}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold truncate">{room!.name}</h2>
          {room!.kind === "public" ? <Badge tone="info" icon={<Globe />}>Public</Badge> : <Badge tone="accent" icon={<Lock />}>Private</Badge>}
        </div>
        <p className="text-xs text-muted">
          {Object.keys(room!.members).length} members seen{room!.epoch ? ` · key v${room!.epoch + 1}` : ""}
        </p>
      </div>
      {room!.kind === "private" && (
        <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => openRoomDialog(room!.id, "invite")}>Invite</Button>
      )}
    </>
  );

  return (
    <section className="flex-1 min-w-0 flex flex-col" aria-label={contact ? `Conversation with ${contact.name}` : `Room ${room!.name}`}>
      <header className="h-16 shrink-0 flex items-center gap-3 px-5 border-b border-line bg-surface/60 backdrop-blur">
        {header}
        {disappear > 0 && (
          <Tooltip content={`Messages disappear after ${fmtDuration(disappear)}`}>
            <span className="inline-flex items-center gap-1 text-xs text-muted"><Timer className="size-3.5" />{fmtDuration(disappear)}</span>
          </Tooltip>
        )}
        <IconButton label="Details (Ctrl+I)" active={panels.details} onClick={() => setPanel("details", !panels.details)}>
          <Info />
        </IconButton>
      </header>

      {offNet && (
        <div role="status" className="px-5 py-2 text-xs bg-warning/10 text-warning border-b border-warning/30">
          This room is on another network than your node. You will see messages when you connect to a node on its network.
        </div>
      )}

      <div ref={scroller} onScroll={onScroll} className="flex-1 overflow-y-auto px-5 py-4" role="log" aria-live="polite">
        {list.length === 0 && (
          <div className="h-full grid place-items-center">
            {contact ? (
              <EmptyState icon={<Lock />} title={`Say hi to ${contact.name}`}>
                Only {contact.name}&apos;s key can open these messages. Nodes relaying them do not even see who they are for.
              </EmptyState>
            ) : (
              <EmptyState icon={room!.kind === "private" ? <Lock /> : <Hash />} title={`Welcome to #${room!.name}`}>
                {room!.kind === "private"
                  ? "Only people with the invite can read this room. Removing someone changes the key."
                  : "Anyone on this network who knows the room name can read it. Use a private room for secrets."}
              </EmptyState>
            )}
          </div>
        )}
        {list.map((m, i) => {
          const prev = list[i - 1];
          const next = list[i + 1];
          const newDay = !prev || dayLabel(prev.ts) !== dayLabel(m.ts);
          const same = (a?: StoredMessage) => !!a && a.outgoing === m.outgoing && a.senderFp === m.senderFp;
          const first = newDay || !same(prev) || m.ts - prev!.ts > GROUP_GAP_S;
          const last = !next || !same(next) || next.ts - m.ts > GROUP_GAP_S || dayLabel(next.ts) !== dayLabel(m.ts);
          const sender = room
            ? { fp: m.senderFp, name: contacts[m.senderFp]?.name ?? room.members[m.senderFp]?.name ?? "" }
            : undefined;
          const canDelete = !!room && room.kind === "private" && (m.outgoing || iMod);
          return (
            <Fragment key={m.uid}>
              {newDay && (
                <div className="flex justify-center my-4">
                  <span className="px-2.5 py-0.5 rounded-full bg-sunken text-[11px] font-medium text-muted">{dayLabel(m.ts)}</span>
                </div>
              )}
              <Bubble
                m={m} first={first} last={last} showTime={settings.showTimestamps} sender={sender}
                canDelete={canDelete} onDelete={() => deleteMessage(selected!, m.uid)} onRetry={() => retry(m.uid)}
              />
            </Fragment>
          );
        })}
      </div>

      <Composer disabled={conn.status !== "connected"} isRoom={isRoom} />
    </section>
  );
}

export function fmtDuration(s: number) {
  if (s >= 86400) return `${Math.round(s / 86400)} d`;
  if (s >= 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 60)} min`;
}
