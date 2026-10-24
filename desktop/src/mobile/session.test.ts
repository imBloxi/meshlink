import { afterEach, expect, it, vi } from "vitest";
import { concat, fromB64, toB64, u32le } from "../core/bytes";
import { Identity } from "../core/identity";
import { Messenger, type MessengerOutput } from "../core/messenger";
import * as p from "../core/protocol";
import { restoreSnapshot } from "./vault";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

async function setup() {
  vi.resetModules();
  let saved: string | null = null;
  let session = 0;
  let relay = true;
  let sequence = 0;
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
      if (data[0] === p.H_AUTH) queueMicrotask(() => frame(new Uint8Array([p.H_AUTH_OK, p.ROLE_GUEST, p.PERM_FULL])));
      if (data[0] === p.H_INFO_REQ) queueMicrotask(() => frame(concat(new Uint8Array([p.H_INFO, p.VERSION]), u32le(42), new Uint8Array(6),
        new Uint8Array([6, 0, p.ROLE_GUEST, p.PERM_FULL]), u32le(7), new Uint8Array([0]))));
      if (data[0] === p.H_SEND && relay) peerMessages.push(...peer.handle(p.parseHostFrame(recv(data))!));
      return true;
    },
  };
  vi.stubGlobal("window", Object.assign(target, { NodeLinkAndroid: bridge }));
  const mobile = await import("./session");
  mobile.initialize();
  mobile.createAccount("Android Alice", "");
  return { mobile, peer, peerMessages, bridge, saved: () => saved, relay: (on: boolean) => { relay = on; } };
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
