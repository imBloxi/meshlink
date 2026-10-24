import { create } from "zustand";
import { fromHex, toB64 } from "../core/bytes";
import type { Contact } from "../core/contacts";
import { Identity } from "../core/identity";
import { Messenger, type ChatMessage, type MessengerOutput } from "../core/messenger";
import type { Perm } from "../core/protocol";
import { AndroidTransport, isAndroid, loadVault, saveVault, wipeVault } from "./host";
import { NodeLink, nodeAddress } from "./link";
import { displayName, restoreSnapshot, saveContacts, serializeSnapshot, type Snapshot } from "./vault";

interface State {
  loaded: boolean;
  identity: Identity | null;
  name: string;
  host: string;
  contacts: Contact[];
  messages: ChatMessage[];
  status: "offline" | "connecting" | "connected";
  node: string;
  permission: Perm;
  error: string;
  storageError: boolean;
}
export const useMobile = create<State>(() => ({ loaded: false, identity: null, name: "", host: "192.168.4.1", contacts: [], messages: [],
  status: "offline", node: "", permission: 0, error: "", storageError: false }));
let contacts = new Map<string, Contact>();
let link: NodeLink | null = null;
let messenger: Messenger | null = null;
let clock: ReturnType<typeof setInterval> | null = null;
let announce: ReturnType<typeof setInterval> | null = null;
let generation = 0;
const state = () => useMobile.getState();
const set = useMobile.setState;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";

function persist() {
  const s = state();
  if (!s.identity) return;
  const snapshot: Snapshot = { version: 1, secret: toB64(s.identity.secretKey), name: s.name, host: s.host,
    contacts: saveContacts(contacts), messages: s.messages.slice(-1000) };
  const serialized = serializeSnapshot(snapshot);
  saveVault(serialized.json);
  if (serialized.messages.length !== s.messages.length) set({ messages: serialized.messages });
}
function storageFailed(error: unknown) {
  disconnect();
  set({ storageError: true, error: `Secure storage failed: ${errorText(error)} Your account has not been reset.` });
}
function outputs(events: MessengerOutput[]) {
  let changed = false;
  for (const event of events) {
    if (event.kind === "contact") {
      contacts.set(event.contact.fp, event.contact);
      set({ contacts: [...contacts.values()] });
      changed = true;
    } else if (event.kind === "message") {
      if (!state().messages.some((m) => m.id === event.message.id)) {
        set({ messages: [...state().messages, event.message].slice(-1000) });
        changed = true;
      }
    } else if (event.kind === "state") {
      set({ messages: state().messages.map((m) => m.id === event.id ? { ...m, state: event.state } : m) });
      changed = true;
    } else if (event.kind === "notice") set({ error: event.text });
    else if (event.kind === "roomInvite" || event.kind === "networkInvite") {
      set({ error: "Room and network invites are not supported in this Android version. Use the desktop app." });
    }
  }
  if (changed) { try { persist(); } catch (error) { storageFailed(error); } }
}
export function initialize() {
  if (state().loaded) return;
  if (!isAndroid()) { set({ loaded: true }); return; }
  try {
    const json = loadVault();
    if (json) {
      const restored = restoreSnapshot(json);
      contacts = restored.contacts;
      set({ identity: restored.identity, name: restored.snapshot.name, host: restored.snapshot.host,
        contacts: [...contacts.values()], messages: restored.snapshot.messages });
    }
    set({ loaded: true });
  } catch (error) { set({ loaded: true, storageError: true, error: errorText(error) }); }
}
export function createAccount(nameInput: string, phrase: string) {
  if (state().storageError) throw new Error("Resolve the storage error before creating an account.");
  const name = displayName(nameInput);
  const identity = phrase.trim() ? Identity.fromPhrase(phrase) : Identity.generate();
  const snapshot: Snapshot = { version: 1, secret: toB64(identity.secretKey), name, host: "192.168.4.1", contacts: [], messages: [] };
  saveVault(JSON.stringify(snapshot));
  contacts = new Map();
  set({ identity, name, contacts: [], messages: [], error: "" });
}
export function disconnect() {
  generation++;
  if (clock) clearInterval(clock);
  if (announce) clearInterval(announce);
  clock = null; announce = null;
  const oldLink = link;
  link = null; messenger = null;
  oldLink?.close();
  const pending = state().messages.some((m) => m.state === "sending" || m.state === "sent");
  set({ status: "offline", node: "", permission: 0, messages: state().messages.map((m) =>
    m.state === "sending" || m.state === "sent" ? { ...m, state: "failed" } : m) });
  if (pending) {
    try { persist(); }
    catch (error) { set({ storageError: true, error: `Secure storage failed: ${errorText(error)} Your account has not been reset.` }); }
  }
}
export async function connect(hostInput: string) {
  const identity = state().identity;
  if (!identity || state().storageError) return;
  disconnect();
  const attempt = generation;
  try {
    const host = nodeAddress(hostInput);
    set({ status: "connecting", error: "", host });
    persist();
    const session = new NodeLink(new AndroidTransport(), identity);
    link = session;
    const info = await session.open(host, (event) => {
      if (attempt !== generation) return;
      if (event.kind === "error") set({ error: event.text || "The node refused a message. Check its guest permissions or rate limit." });
      else if (messenger) outputs(messenger.handle(event));
    }, (reason) => {
      if (attempt !== generation) return;
      disconnect();
      set({ error: reason });
    });
    if (attempt !== generation) return;
    messenger = new Messenger(identity, contacts, state().name, (frame) => session.send(frame), info.netId);
    set({ status: "connected", node: info.nodeName || `Node ${info.chipId.toString(16).toUpperCase()}`, permission: info.perm ?? 0 });
    if (info.perm !== 0) messenger.announce();
    announce = setInterval(() => { try { if (state().permission !== 0) messenger?.announce(); } catch (error) { disconnect(); set({ error: errorText(error) }); } }, 60000);
    clock = setInterval(() => { try { if (messenger) outputs(messenger.tick()); } catch (error) { disconnect(); set({ error: errorText(error) }); } }, 500);
  } catch (error) {
    if (attempt !== generation) return;
    disconnect();
    set({ error: errorText(error) });
  }
}
export function sendMessage(fp: string, text: string) {
  const contact = contacts.get(fp);
  if (!messenger || !contact || state().status !== "connected") throw new Error("Connect to a node before sending.");
  if (!state().permission) throw new Error("This node gives you read-only access.");
  const trimmed = text.trim();
  if (!trimmed || [...trimmed].length > 500) throw new Error("Use 1–500 characters per message.");
  const message = messenger.sendText(contact, trimmed);
  set({ messages: [...state().messages, message].slice(-1000) });
  try { persist(); } catch (error) { storageFailed(error); }
}
export function verifyContact(fp: string, verified: boolean) {
  const contact = contacts.get(fp);
  if (!contact) return;
  const previous = contact.verified;
  contact.verified = verified;
  try { persist(); set({ contacts: [...contacts.values()] }); }
  catch (error) { contact.verified = previous; storageFailed(error); }
}
export function contactBytes(fp: string) { return fromHex(fp); }
export function clearError() { if (!state().storageError) set({ error: "" }); }
export function eraseAccount() {
  disconnect();
  wipeVault();
  contacts = new Map();
  set({ identity: null, name: "", contacts: [], messages: [], host: "192.168.4.1", error: "", storageError: false });
}
// No promise of background delivery: close cleanly when Android suspends the UI.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.hidden && state().status !== "offline") { disconnect(); set({ error: "Connection paused while the app was in the background. Reconnect to receive messages." }); }
});
