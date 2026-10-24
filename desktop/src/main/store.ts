// Local storage for the Electron main process.
//
// - Secrets (identity key, data key) are encrypted with Windows DPAPI:
//   only this Windows account can decrypt them.
// - Message text, contacts, settings and records are encrypted at rest with
//   the data key (NaCl secretbox).
// - Lookup columns (conversation, message id, record id) hold keyed hashes
//   ("blind" ids), so a copy of the database file shows no fingerprints,
//   room ids or names. Timestamps, message state and row counts stay visible.
// - SQLite runs with secure_delete, so deleted rows are overwritten on disk.
// - Everything lives in SQLite (node:sqlite, built into Electron's Node).
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import nacl from "tweetnacl";
import type { MessageState, RecordKind, StoredContact, StoredMessage } from "../shared/api";
import { protect, unprotect } from "./dpapi";

interface Secrets {
  identity: string | null; // base64 secret key
  dataKey: string; // base64, encrypts message text
}

export class Store {
  private db: DatabaseSync;
  private secretsPath: string;
  private secrets: Secrets;
  private dataKey: Uint8Array;
  private blindKey: Buffer;
  /** Set when an unreadable secrets file was moved aside at startup. */
  secretsReset = false;

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.secretsPath = join(dir, "secrets.bin");
    this.secrets = this.loadSecrets();
    this.dataKey = Buffer.from(this.secrets.dataKey, "base64");
    this.blindKey = createHmac("sha256", Buffer.from(this.dataKey)).update("ml-blind-v1").digest();
    this.db = new DatabaseSync(join(dir, "meshlink.db"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA secure_delete = ON;");
    this.migrate();
    this.migrateV3();
  }

  /** Keyed hash for lookup columns: equal inputs match, nothing else is revealed. */
  private blind(kind: string, value: string): string {
    return createHmac("sha256", this.blindKey).update(`${kind}:${value}`).digest("hex").slice(0, 32);
  }

  /** Schema versions: 0 = empty, 1 = v0.2 (DMs only), 2 = v0.3 (rooms, records), 3 = v0.4 (blind ids). */
  private migrate() {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    const hasOld = !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get();
    if (version >= 2) return;
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS contacts (
          fp TEXT PRIMARY KEY, pubkey TEXT NOT NULL, name TEXT NOT NULL,
          verified INTEGER NOT NULL DEFAULT 0, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
        CREATE TABLE msg (
          uid TEXT PRIMARY KEY, conv TEXT NOT NULL, sender_fp TEXT NOT NULL, outgoing INTEGER NOT NULL,
          body TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 1,
          seq INTEGER NOT NULL);
        CREATE INDEX msg_conv ON msg (conv, seq);
        CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (kind, id));
      `);
      const cols = this.db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
      if (!cols.some((c) => c.name === "sign_pk")) this.db.exec("ALTER TABLE contacts ADD COLUMN sign_pk TEXT");
      if (hasOld) {
        // v0.2 DMs keep their (already encrypted) text.
        this.db.exec(`INSERT INTO msg (uid, conv, sender_fp, outgoing, body, ts, state, verified, seq)
          SELECT 'v1:' || id, 'dm:' || peer_fp, CASE outgoing WHEN 1 THEN '' ELSE peer_fp END, outgoing, body, ts,
                 CASE state WHEN 'sending' THEN 'sent' ELSE state END, 1, id FROM messages;
          DROP TABLE messages;`);
      }
      this.db.exec("PRAGMA user_version = 2; COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /**
   * v3: move contacts into encrypted records, blind every lookup column, seal
   * settings and the sender of each message. Then VACUUM so the old plaintext
   * pages do not linger in the file.
   */
  private migrateV3() {
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version >= 3) return;
    this.db.exec("BEGIN");
    try {
      const recs = this.db.prepare("SELECT kind, id FROM records").all() as { kind: string; id: string }[];
      const moveRec = this.db.prepare("UPDATE records SET id = ? WHERE kind = ? AND id = ?");
      for (const r of recs) moveRec.run(this.blind(r.kind, r.id), r.kind, r.id);
      const contacts = this.db.prepare("SELECT * FROM contacts").all() as Record<string, never>[];
      for (const r of contacts) {
        this.putRecord("contact", r.fp, {
          fp: r.fp, pubkey: r.pubkey, signPk: r.sign_pk ?? null, name: r.name, verified: !!r.verified,
          firstSeen: r.first_seen, lastSeen: r.last_seen,
        });
      }
      this.db.exec("DROP TABLE contacts");
      const msgs = this.db.prepare("SELECT uid, conv, sender_fp, body FROM msg").all() as { uid: string; conv: string; sender_fp: string; body: string }[];
      const moveMsg = this.db.prepare("UPDATE msg SET uid = ?, conv = ?, sender_fp = '', body = ? WHERE uid = ?");
      for (const m of msgs) {
        const body = JSON.stringify({ t: this.open(m.body), s: m.sender_fp, u: m.uid });
        moveMsg.run(this.blind("uid", m.uid), this.blind("conv", m.conv), this.seal(body), m.uid);
      }
      const settings = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
      const moveSet = this.db.prepare("UPDATE settings SET value = ? WHERE key = ?");
      for (const s of settings) moveSet.run(this.seal(s.value), s.key);
      this.db.exec("PRAGMA user_version = 3; COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
  }

  // ---- Secrets ----

  private loadSecrets(): Secrets {
    if (existsSync(this.secretsPath)) {
      try {
        return JSON.parse(unprotect(readFileSync(this.secretsPath)).toString("utf8"));
      } catch {
        // Another Windows account, or a damaged file. Keep it for recovery, start fresh.
        renameSync(this.secretsPath, `${this.secretsPath}.unreadable-${Date.now()}`);
        this.secretsReset = true;
      }
    }
    const s: Secrets = { identity: null, dataKey: Buffer.from(nacl.randomBytes(32)).toString("base64") };
    this.writeSecrets(s);
    return s;
  }

  private writeSecrets(s: Secrets) {
    const tmp = `${this.secretsPath}.tmp`;
    writeFileSync(tmp, protect(Buffer.from(JSON.stringify(s), "utf8")));
    renameSync(tmp, this.secretsPath); // Atomic: never a half-written key file.
  }

  getIdentity() {
    return this.secrets.identity;
  }

  setIdentity(sk: string) {
    this.secrets.identity = sk;
    this.writeSecrets(this.secrets);
  }

  // ---- Settings ----

  getSettings(): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[];
    return Object.fromEntries(rows.flatMap((r) => {
      try {
        return [[r.key, JSON.parse(this.open(r.value))]];
      } catch {
        return [];
      }
    }));
  }

  setSetting(key: string, value: unknown) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, this.seal(JSON.stringify(value)));
  }

  // ---- Contacts ----

  listContacts(): StoredContact[] {
    return this.listRecords("contact") as StoredContact[];
  }

  saveContact(c: StoredContact) {
    // Same merge as before: the first key and first-seen time stay, a known signing key is never cleared.
    const row = this.db.prepare("SELECT body FROM records WHERE kind = 'contact' AND id = ?").get(this.blind("contact", c.fp)) as { body: string } | undefined;
    let old: StoredContact | null = null;
    try {
      old = row ? (JSON.parse(this.open(row.body)) as StoredContact) : null;
    } catch {
      old = null;
    }
    this.putRecord("contact", c.fp, {
      ...c, pubkey: old?.pubkey ?? c.pubkey, firstSeen: old?.firstSeen ?? c.firstSeen, signPk: c.signPk ?? old?.signPk ?? null,
    });
  }

  // ---- Messages (text encrypted at rest) ----

  private seq = 0;

  listMessages(conv: string, limit: number): StoredMessage[] {
    const rows = this.db.prepare("SELECT * FROM msg WHERE conv = ? ORDER BY seq DESC LIMIT ?")
      .all(this.blind("conv", conv), limit) as Record<string, never>[];
    return rows.reverse().map((r) => {
      let body: { t: string; s: string; u: string };
      try {
        body = JSON.parse(this.open(r.body));
      } catch {
        body = { t: "[unreadable]", s: "", u: "" };
      }
      return {
        uid: body.u || r.uid, conv, senderFp: body.s, outgoing: !!r.outgoing, text: body.t, ts: r.ts,
        state: r.state, verified: !!r.verified,
      };
    });
  }

  addMessage(m: StoredMessage) {
    if (!this.seq) this.seq = ((this.db.prepare("SELECT MAX(seq) AS s FROM msg").get() as { s: number | null }).s ?? 0);
    this.db.prepare(`INSERT OR IGNORE INTO msg (uid, conv, sender_fp, outgoing, body, ts, state, verified, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(this.blind("uid", m.uid), this.blind("conv", m.conv), "", m.outgoing ? 1 : 0,
        this.seal(JSON.stringify({ t: m.text, s: m.senderFp, u: m.uid })), m.ts, m.state, m.verified === false ? 0 : 1, ++this.seq);
  }

  updateMessageState(uid: string, state: MessageState) {
    this.db.prepare("UPDATE msg SET state = ? WHERE uid = ?").run(state, this.blind("uid", uid));
  }

  deleteMessage(uid: string) {
    this.db.prepare("DELETE FROM msg WHERE uid = ?").run(this.blind("uid", uid));
  }

  deleteMessagesBefore(conv: string, ts: number): number {
    return Number(this.db.prepare("DELETE FROM msg WHERE conv = ? AND ts < ?").run(this.blind("conv", conv), ts).changes);
  }

  deleteConversation(conv: string) {
    this.db.prepare("DELETE FROM msg WHERE conv = ?").run(this.blind("conv", conv));
  }

  // ---- Records: rooms, networks, nodes (JSON, encrypted with the data key) ----

  listRecords(kind: RecordKind | "contact"): unknown[] {
    const rows = this.db.prepare("SELECT body FROM records WHERE kind = ?").all(kind) as { body: string }[];
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(this.open(r.body))];
      } catch {
        return [];
      }
    });
  }

  saveRecord(kind: RecordKind, id: string, data: unknown) {
    this.putRecord(kind, id, data);
  }

  private putRecord(kind: string, id: string, data: unknown) {
    this.db.prepare("INSERT INTO records (kind, id, body) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET body = excluded.body")
      .run(kind, this.blind(kind, id), this.seal(JSON.stringify(data)));
  }

  deleteRecord(kind: RecordKind, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind = ? AND id = ?").run(kind, this.blind(kind, id));
  }

  private seal(text: string): string {
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(new TextEncoder().encode(text), nonce, this.dataKey);
    return Buffer.concat([nonce, box]).toString("base64");
  }

  private open(body: string): string {
    const raw = Buffer.from(body, "base64");
    const plain = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), this.dataKey);
    return plain ? new TextDecoder().decode(plain) : "[unreadable]";
  }

  // ---- Panic wipe ----

  wipeAll() {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
