import * as Tabs from "@radix-ui/react-tabs";
import { CopyCode, Field, Qr } from "@ui/form";
import { Identicon } from "@ui/identity";
import { Dialog } from "@ui/overlays";
import { Button, cn, Input, Segmented } from "@ui/primitives";
import { Globe, Hash, Link2, Lock, Send } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useApp } from "../lib/store";

function TabButton({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "flex-1 inline-flex items-center justify-center gap-1.5 h-9 rounded-md text-sm text-muted [&_svg]:size-4",
        "data-[state=active]:bg-raised data-[state=active]:text-fg data-[state=active]:shadow-1",
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}

export function NewRoomDialog() {
  const { panels, setPanel, createRoom, acceptInvite } = useApp();
  const [name, setName] = useState("");
  const [pub, setPub] = useState("");
  const [code, setCode] = useState("");
  const close = () => {
    setPanel("newRoom", false);
    setName("");
    setPub("");
    setCode("");
  };
  const nameOk = (s: string) => s.trim().replace(/^#/, "").length > 0 && new TextEncoder().encode(s.trim()).length <= 32;

  return (
    <Dialog open={panels.newRoom} onOpenChange={(o) => (o ? setPanel("newRoom", true) : close())} title="Rooms"
      description="Talk with a group. Rooms live on your network, not on any server.">
      <Tabs.Root defaultValue="private">
        <Tabs.List aria-label="Room type" className="flex gap-1 p-1 rounded-lg bg-sunken mb-5">
          <TabButton value="private"><Lock />Private</TabButton>
          <TabButton value="public"><Globe />Public</TabButton>
          <TabButton value="invite"><Link2 />Invite code</TabButton>
        </Tabs.List>

        <Tabs.Content value="private" className="space-y-4 outline-none">
          <p className="text-sm text-muted">A new secret key only invited people get. You are the owner: you can add moderators and remove members.</p>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (nameOk(name) && createRoom(name, "private")) close(); }}>
            <Field label="Room name">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Base camp" maxLength={32} />
            </Field>
            <Button type="submit" variant="primary" className="w-full" disabled={!nameOk(name)}>Create private room</Button>
          </form>
        </Tabs.Content>

        <Tabs.Content value="public" className="space-y-4 outline-none">
          <p className="text-sm text-muted">
            Everyone on this network who types the same name lands in the same room. Encrypted on the air, but not secret from
            anyone who guesses the name.
          </p>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (nameOk(pub) && createRoom(pub, "public")) close(); }}>
            <Field label="Room name">
              <Input value={pub} onChange={(e) => setPub(e.target.value)} placeholder="general" maxLength={32} leading={<Hash />} />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {["general", "help", "events", "sos"].map((n) => (
                <button key={n} type="button" onClick={() => setPub(n)} className="px-2.5 h-7 rounded-full bg-sunken text-xs text-muted hover:text-fg">#{n}</button>
              ))}
            </div>
            <Button type="submit" variant="primary" className="w-full" disabled={!nameOk(pub)}>Join public room</Button>
          </form>
        </Tabs.Content>

        <Tabs.Content value="invite" className="space-y-4 outline-none">
          <p className="text-sm text-muted">Paste an invite code (starts with <code className="font-mono">mlr1:</code>) that someone gave you.</p>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); acceptInvite(code.trim()); close(); }}>
            <textarea
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={4}
              placeholder="mlr1:…"
              aria-label="Invite code"
              className="w-full rounded-md bg-sunken border border-transparent focus:border-accent-line outline-none p-3 font-mono text-xs"
            />
            <Button type="submit" variant="primary" className="w-full" disabled={!code.trim().startsWith("mlr1:")}>Join room</Button>
          </form>
        </Tabs.Content>
      </Tabs.Root>
    </Dialog>
  );
}

export function RoomInviteDialog() {
  const { roomDialog, openRoomDialog, rooms, roomInviteCode, contacts, inviteContact, conn } = useApp();
  const [hours, setHours] = useState("72");
  const r = roomDialog?.roomId ? rooms[roomDialog.roomId] : null;
  const [sent, setSent] = useState<Set<string>>(new Set());
  if (!r) return null;
  const code = roomInviteCode(r.id, Number(hours));
  const people = Object.values(contacts).filter((c) => !r.members[c.fp]);

  return (
    <Dialog open={!!roomDialog} onOpenChange={(o) => !o && openRoomDialog(null)} title={`Invite to #${r.name}`}
      description="Anyone with this code can read the room until the key changes. Share it privately." size="lg">
      <div className="grid md:grid-cols-[auto_1fr] gap-6">
        <div className="flex flex-col items-center gap-2">
          <Qr value={code} size={180} label={`Invite QR code for ${r.name}`} />
          <p className="text-xs text-muted">Scan in the MeshLink app</p>
        </div>
        <div className="space-y-4 min-w-0">
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Expires</p>
            <Segmented label="Invite expiry" value={hours} onChange={setHours}
              options={[{ value: "1", label: "1 h" }, { value: "24", label: "1 day" }, { value: "72", label: "3 days" }, { value: "0", label: "Never" }]} />
          </div>
          <CopyCode value={code} label="Copy invite code" />
          <div className="space-y-2">
            <p className="text-sm font-medium">Send to a contact</p>
            <p className="text-xs text-muted">Goes as an encrypted direct message. Best option: nobody else sees the code.</p>
            <ul className="max-h-48 overflow-y-auto space-y-0.5">
              {people.length === 0 && <li className="text-xs text-muted py-2">Everyone you know is already in this room.</li>}
              {people.map((c) => (
                <li key={c.fp} className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-sunken">
                  <Identicon fp={c.fp} size={26} />
                  <span className="flex-1 text-sm truncate">{c.name}</span>
                  <Button size="sm" variant={sent.has(c.fp) ? "ghost" : "secondary"} icon={<Send className="size-3.5" />}
                    disabled={sent.has(c.fp) || conn.status !== "connected"}
                    onClick={() => { inviteContact(r.id, c.fp); setSent(new Set([...sent, c.fp])); }}>
                    {sent.has(c.fp) ? "Sent" : "Send"}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
