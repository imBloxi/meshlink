import { afterEach, expect, it, vi } from "vitest";
import { concat, fromB64, toB64, u32le } from "../core/bytes";
import { Identity } from "../core/identity";
import { Messenger, type MessengerOutput } from "../core/messenger";
import * as p from "../core/protocol";
import { restoreSnapshot } from "./vault";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

async function setup() {
  vi.resetModules();
  let saved: string | null = null;
  let session = 0;
  let relay = true;
  let sequence = 0;
  let permission: p.Perm = p.PERM_FULL;
  const sent: Uint8Array[] = [];
  const peerMessages: MessengerOutput[] = [];
  const target = new EventTarget();
  const frame = (data: Uint8Array) => target.dispatchEvent(new CustomEvent("nodelink", {
    detail: { session, type: "frame", data: toB64(data) },
  }));
  const recv = (data: Uint8Array) => concat(new Uint8Array([p.H_RECV, data[1], 3]), u32le(42), u32le(++sequence), data.slice(2, 3), data.slice(3));
  const peer = new Messenger(Identity.generate(), new Map(), "Desktop Bob", (data) => {
    if (relay) queueMicrotask(() => frame(recv(data)));
  }, 7);
  const bridge = {
    loadVault: () => JSON.stringify({ ok: true, value: saved }),
    saveVault: (value: string) => { saved = value; return '{"ok":true}'; },
    wipeVault: () => { saved = null; return '{"ok":true}'; },
    openWifiSettings: () => {},
    closeNode: () => {},
    openNode: (_host: string, id: number) => {
      session = id;
      queueMicrotask(() => frame(concat(new Uint8Array([p.H_HELLO]), new Uint8Array(16), u32le(42), u32le(7), new Uint8Array([0]))));
    },
    sendFrame: (encoded: string) => {
      const data = fromB64(encoded);
      sent.push(data);
      if (data[0] === p.H_AUTH) queueMicrotask(() => frame(new Uint8Array([p.H_AUTH_OK, p.ROLE_GUEST, permission])));
      if (data[0] === p.H_INFO_REQ) queueMicrotask(() => frame(concat(new Uint8Array([p.H_INFO, p.VERSION]), u32le(42), new Uint8Array(6),
        new Uint8Array([6, 0, p.ROLE_GUEST, permission]), u32le(7), new Uint8Array([0]))));
      if (data[0] === p.H_SEND && relay) peerMessages.push(...peer.handle(p.parseHostFrame(recv(data))!));
      return true;
    },
  };
  vi.stubGlobal("window", Object.assign(target, { NodeLinkAndroid: bridge }));
  const mobile = await import("./session");
  mobile.initialize();
  mobile.createAccount("Android Alice", "");
  return { mobile, peer, peerMessages, bridge, sent, saved: () => saved, relay: (on: boolean) => { relay = on; }, permission: (value: p.Perm) => { permission = value; } };
}

it("exchanges encrypted DMs and delivery receipts with the desktop core", async () => {
  const { mobile, peer, peerMessages } = await setup();
  try {
    await mobile.connect("192.168.4.1");
    peer.announce();
    await Promise.resolve();
    const contact = mobile.useMobile.getState().contacts[0];
    expect(contact.name).toBe("Desktop Bob");
    mobile.sendMessage(contact.fp, "Hello from Android 🌍");
    await Promise.resolve();
    expect(peerMessages).toContainEqual(expect.objectContaining({ kind: "message", message: expect.objectContaining({ text: "Hello from Android 🌍" }) }));
    expect(mobile.useMobile.getState().messages[0].state).toBe("delivered");
    const alice = [...peer.contacts.values()][0];
    peer.sendText(alice, "Hello from desktop");
    await Promise.resolve();
    expect(mobile.useMobile.getState().messages).toContainEqual(expect.objectContaining({ text: "Hello from desktop", outgoing: false }));
  } finally { mobile.disconnect(); }
});

it("marks interrupted sends failed in memory and in the saved account", async () => {
  const { mobile, peer, saved, relay } = await setup();
  try {
    await mobile.connect("192.168.4.1");
    peer.announce(); await Promise.resolve();
    relay(false);
    mobile.sendMessage(mobile.useMobile.getState().contacts[0].fp, "Node went away");
    expect(mobile.useMobile.getState().messages[0].state).toBe("sending");
    mobile.disconnect();
    expect(mobile.useMobile.getState().messages[0].state).toBe("failed");
    expect(JSON.parse(saved()!).messages[0].state).toBe("failed");
  } finally { mobile.disconnect(); }
});

it("blocks account replacement when encrypted storage fails to open", async () => {
  const { mobile, bridge } = await setup();
  mobile.disconnect();
  vi.resetModules();
  bridge.loadVault = () => '{"ok":false,"error":"Decryption failed"}';
  const fresh = await import("./session");
  fresh.initialize();
  expect(fresh.useMobile.getState().storageError).toBe(true);
  expect(() => fresh.createAccount("New identity", "")).toThrow(/storage error/i);
});

it("retries a transient vault read failure without replacing the stored identity", async () => {
  const { mobile, bridge, saved } = await setup();
  const secret = JSON.parse(saved()!).secret;
  mobile.disconnect();
  vi.resetModules();
  const load = bridge.loadVault;
  bridge.loadVault = () => '{"ok":false,"error":"Temporarily unavailable"}';
  const fresh = await import("./session");
  fresh.initialize();
  expect(fresh.useMobile.getState().identity).toBeNull();
  bridge.loadVault = load;
  fresh.retryStorage();
  expect(fresh.useMobile.getState().storageError).toBe(false);
  expect(toB64(fresh.useMobile.getState().identity!.secretKey)).toBe(secret);
});

it("retries a failed write using unsaved messages in memory", async () => {
  const { mobile, peer, bridge, saved } = await setup();
  try {
    await mobile.connect("192.168.4.1");
    peer.announce(); await Promise.resolve();
    const save = bridge.saveVault;
    bridge.saveVault = () => '{"ok":false,"error":"Storage full"}';
    peer.sendText([...peer.contacts.values()][0], "Keep this unsaved message");
    await Promise.resolve();
    expect(mobile.useMobile.getState().storageError).toBe(true);
    expect(JSON.parse(saved()!).messages).toHaveLength(0);
    bridge.saveVault = save;
    mobile.retryStorage();
    expect(mobile.useMobile.getState().storageError).toBe(false);
    expect(JSON.parse(saved()!).messages.at(-1).text).toBe("Keep this unsaved message");
  } finally { mobile.disconnect(); }
});

it("pauses connection setup when its settings cannot be saved", async () => {
  const { mobile, bridge, sent } = await setup();
  bridge.saveVault = () => '{"ok":false,"error":"Storage full"}';
  await mobile.connect("192.168.4.1");
  expect(mobile.useMobile.getState()).toMatchObject({ status: "offline", storageError: true });
  expect(sent).toHaveLength(0);
});

it("requires explicit RESET before deleting an unreadable account", async () => {
  const { mobile, bridge, saved } = await setup();
  const identity = mobile.useMobile.getState().identity!;
  const phrase = identity.phrase();
  mobile.disconnect();
  vi.resetModules();
  bridge.loadVault = () => '{"ok":false,"error":"Decryption failed"}';
  const fresh = await import("./session");
  fresh.initialize();
  expect(() => fresh.resetStorage("reset")).toThrow(/RESET/);
  expect(saved()).not.toBeNull();
  fresh.resetStorage("RESET");
  expect(saved()).toBeNull();
  expect(fresh.useMobile.getState().storageError).toBe(false);
  fresh.createAccount("Restored Alice", phrase);
  expect(fresh.useMobile.getState().identity!.fp).toEqual(identity.fp);
});

it("refreshes guest permissions and re-announces after a live grant", async () => {
  const { mobile, peer, sent, permission } = await setup();
  vi.useFakeTimers();
  try {
    permission(p.PERM_READ);
    await mobile.connect("192.168.4.1");
    peer.announce(); await Promise.resolve();
    const contact = mobile.useMobile.getState().contacts[0];
    expect(() => mobile.sendMessage(contact.fp, "Not allowed yet")).toThrow(/read-only/);
    expect(sent.filter((f) => f[0] === p.H_SEND)).toHaveLength(0);
    permission(p.PERM_DM);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mobile.useMobile.getState().permission).toBe(p.PERM_DM);
    expect(sent.some((f) => f[0] === p.H_SEND && f[1] === p.AIR_ANNOUNCE)).toBe(true);
    mobile.sendMessage(contact.fp, "The live grant works");
    await Promise.resolve();
    expect(mobile.useMobile.getState().messages.at(-1)?.state).toBe("delivered");
    permission(p.PERM_READ);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mobile.useMobile.getState().permission).toBe(p.PERM_READ);
    expect(() => mobile.sendMessage(contact.fp, "Revoked")).toThrow(/read-only/);
    const count = sent.filter((f) => f[0] === p.H_INFO_REQ).length;
    mobile.disconnect();
    await vi.advanceTimersByTimeAsync(10000);
    expect(sent.filter((f) => f[0] === p.H_INFO_REQ)).toHaveLength(count);
  } finally { mobile.disconnect(); }
});

it("can reopen an account after receiving a long valid desktop DM", async () => {
  const { mobile, peer, saved } = await setup();
  try {
    await mobile.connect("192.168.4.1");
    peer.announce(); await Promise.resolve();
    const text = "x".repeat(17000);
    peer.sendText([...peer.contacts.values()][0], text);
    await Promise.resolve();
    expect(mobile.useMobile.getState().messages.at(-1)?.text).toBe(text);
    const restored = restoreSnapshot(saved()!);
    expect(restored.snapshot.messages.at(-1)?.text).toBe(text);
  } finally { mobile.disconnect(); }
});
