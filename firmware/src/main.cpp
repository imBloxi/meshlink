// MeshLink node firmware v0.3 for ESP8266 and the ESP32 family (ESP32, S3, C3, C6).
// Chip differences live in hal.h and chip.h. An optional I2C OLED shows status
// (display.cpp).
//
// Radio: ESP-NOW broadcast flood. Each node relays frames it has not seen,
// after a small random delay, until the TTL reaches 0. Every frame carries a
// keyed BLAKE2s tag: only nodes that hold the network key accept and deliver
// it. Frames of other networks may be relayed blindly (relayForeign).
//
// Hosts: the USB serial host is the node ADMIN (physical access = control).
// Wi-Fi clients connect to the node's access point over WebSocket (port 81)
// and are GUESTS. Guests prove a per-network pseudonym key; they can be
// kicked, banned and limited by the admin or by a signed network policy.
//
// The node never sees plaintext: apps encrypt end to end before sending.
#include <BLAKE2s.h>
#include <Ed25519.h>
#include <LittleFS.h>
#include <WebSocketsServer.h>
#include <WiFiUdp.h>

#include "config.h"
#include "display.h"
#include "hal.h"
#include "protocol.h"

using namespace ml;

static uint32_t chipId;

// Counters for STATUS.
static uint32_t statRx = 0, statRelayed = 0, statDropTag = 0, statDropRate = 0;

// ---- Dedupe -----------------------------------------------------------------

// 2 KB of RAM. A bigger window makes replaying captured frames (once they
// fall out of it) slower; the tag has no timestamp, so this is the defense.
const uint16_t SEEN_SIZE = 512;
static uint32_t seen[SEEN_SIZE];
static uint16_t seenPos = 0;

static bool seenHas(uint32_t msgId) {
  for (uint16_t i = 0; i < SEEN_SIZE; i++) {
    if (seen[i] == msgId) return true;
  }
  return false;
}

static void seenAdd(uint32_t msgId) {
  seen[seenPos] = msgId;
  seenPos = (seenPos + 1) % SEEN_SIZE;
}

// True if msgId was already handled. Otherwise remember it. Stops relay loops.
static bool isDuplicate(uint32_t msgId) {
  if (seenHas(msgId)) return true;
  seenAdd(msgId);
  return false;
}

static uint32_t newMsgId() {
  uint32_t id;
  do {
    id = halRandom();
  } while (id == 0);
  return id;
}

// ---- Network tag ------------------------------------------------------------

// tag = BLAKE2s-64(key = netKey, frame without tag, with ttl set to 0).
// The TTL is excluded because every relay changes it.
static void computeTag(const uint8_t *frame, size_t len, uint8_t *tag) {
  BLAKE2s b;
  b.reset(cfg.netKey, NET_KEY_LEN, TAG_LEN);
  b.update(frame, offsetof(AirHeader, ttl));
  uint8_t zero = 0;
  b.update(&zero, 1);
  b.update(frame + offsetof(AirHeader, ttl) + 1, len - offsetof(AirHeader, ttl) - 1);
  b.finalize(tag, TAG_LEN);
}

// ---- Nodes heard (for the screen) -----------------------------------------------

struct Peer {
  uint32_t id, lastMs;  // lastMs 0 = empty slot
};
static Peer peerTab[16];
const uint32_t PEER_TTL_MS = 60000;

static uint8_t peerCount() {
  uint32_t now = millis();
  uint8_t n = 0;
  for (auto &p : peerTab) n += p.lastMs && now - p.lastMs < PEER_TTL_MS;
  return n;
}

// Called for frames that passed the network tag, so outsiders do not show up.
static void peerSeen(uint32_t id) {
  uint32_t now = millis() | 1;
  Peer *slot = nullptr, *oldest = &peerTab[0];
  for (auto &p : peerTab) {
    if (p.lastMs && p.id == id) { slot = &p; break; }
    if (p.lastMs < oldest->lastMs) oldest = &p;
  }
  bool fresh = !slot || now - slot->lastMs >= PEER_TTL_MS;
  if (!slot) {
    slot = oldest;
    slot->id = id;
  }
  slot->lastMs = now;
  if (fresh) {
    char name[16];
    snprintf(name, sizeof(name), "Node %04X", (unsigned)(id & 0xFFFF));
    displayNotify("Node heard", name);
  }
}

// ---- Rate limit per origin node (token bucket) --------------------------------

struct OriginRate {
  uint32_t origin;
  uint32_t lastMs;
  uint16_t tokens;  // x100
};
static OriginRate rates[16];

static bool originAllowed(uint32_t origin) {
  if (!cfg.originRate) return true;
  uint32_t now = millis();
  OriginRate *slot = nullptr, *oldest = &rates[0];
  for (auto &r : rates) {
    if (r.origin == origin) { slot = &r; break; }
    if (r.lastMs < oldest->lastMs) oldest = &r;
  }
  uint16_t cap = cfg.originRate * 200;  // burst of 2 s
  if (!slot) {
    slot = oldest;
    slot->origin = origin;
    slot->tokens = cap;
    slot->lastMs = now;
  }
  uint32_t refill = (now - slot->lastMs) * cfg.originRate / 10;  // x100 per ms
  slot->tokens = min<uint32_t>(cap, slot->tokens + refill);
  slot->lastMs = now;
  if (slot->tokens < 100) return false;
  slot->tokens -= 100;
  return true;
}

// ---- Transmit queue (relay jitter) ------------------------------------------

struct TxSlot {
  bool used;
  uint32_t due;
  uint8_t len;
  uint8_t data[MAX_AIR];
};
static TxSlot txq[8];

static void queueAir(const uint8_t *data, uint8_t len, uint16_t delayMs) {
  for (auto &t : txq) {
    if (t.used) continue;
    t.used = true;
    t.due = millis() + delayMs;
    t.len = len;
    memcpy(t.data, data, len);
    return;
  }
  statDropRate++;  // Queue full: drop rather than block.
}

static void pumpTx() {
  uint32_t now = millis();
  for (auto &t : txq) {
    if (t.used && (int32_t)(now - t.due) >= 0) {
      halNowSend(t.data, t.len);
      t.used = false;
    }
  }
}

// ---- Hosts: USB admin + Wi-Fi guests ------------------------------------------

const uint8_t HOST_SERIAL = 0xFF;
const uint8_t MAX_GUESTS = 4;

struct Guest {
  bool connected, authed;
  uint8_t num;  // WebSocket client number
  uint8_t nonce[16];
  uint8_t pk[32];
  uint8_t perm;
  uint32_t since;
  uint16_t tx, rx;
  uint32_t rateMs;
  uint16_t rateTokens;  // x100
};
static Guest guests[5];  // indexed by WebSocket client number

static WebSocketsServer ws(81);
static MlWebServer http(80);
static WiFiUDP udp;
static bool netUp = false;
static bool mdnsUp = false;

// True for a client on the node's own hotspot. Everything the node offers over
// IP (guests, discovery, web page, mDNS) stays on the hotspot unless the admin
// turns on lanGuests: the home router network then sees no MeshLink node.
static bool fromHotspot(IPAddress peer) {
  IPAddress ap = WiFi.softAPIP();
  return cfg.apEnabled && (uint32_t)ap != 0 && peer[0] == ap[0] && peer[1] == ap[1] && peer[2] == ap[2];
}

static bool ipAllowed(IPAddress peer) { return cfg.lanGuests || fromHotspot(peer); }

static uint8_t guestCount() {
  uint8_t n = 0;
  for (auto &s : guests) n += s.connected;
  return n;
}

// Largest host frame we send (CONFIG / BANS replies use 400-byte buffers).
const size_t MAX_HOST_FRAME = 400;

static void serialWrite(uint8_t *frame, size_t len) {
  // COBS adds 1 byte per 254, plus 1; the CRC adds 2. Static: too big for the stack.
  static uint8_t enc[MAX_HOST_FRAME + 2 + (MAX_HOST_FRAME + 2) / 254 + 2];
  if (len > MAX_HOST_FRAME) return;  // Never overrun enc.
  uint16_t crc = crc16(frame, len);
  frame[len++] = crc & 0xFF;
  frame[len++] = crc >> 8;
  size_t n = cobsEncode(frame, len, enc);
  Serial.write(enc, n);
  Serial.write((uint8_t)0);
}

// frame needs 2 spare bytes after len (serial CRC).
static void hostSend(uint8_t host, uint8_t *frame, size_t len) {
  if (host == HOST_SERIAL) {
    serialWrite(frame, len);
  } else if (host < 5 && guests[host].connected) {
    ws.sendBIN(host, frame, len);
  }
}

static void hostErr(uint8_t host, uint8_t code, const char *text) {
  uint8_t f[80];
  size_t n = strnlen(text, sizeof(f) - 5);
  f[0] = H_ERR;
  f[1] = code;
  memcpy(f + 2, text, n);
  hostSend(host, f, n + 2);
}

static void hostLog(const char *text) {
  uint8_t f[100];
  size_t n = strnlen(text, sizeof(f) - 3);
  f[0] = H_LOG;
  memcpy(f + 1, text, n);
  serialWrite(f, n + 1);  // Logs go to the admin only.
}

static void hostInfo(uint8_t host) {
  const char *fw = ML_FW_VERSION;
  uint8_t fwLen = strlen(fw), nameLen = strlen(cfg.nodeName);
  const char *chip = halChipName();
  uint8_t chipLen = strlen(chip);
  uint8_t f[128];  // fw <= 15, name <= 32, chip <= 20, plus fixed fields and 2 CRC bytes
  size_t n = 0;
  f[n++] = H_INFO;
  f[n++] = VERSION;
  memcpy(f + n, &chipId, 4); n += 4;
  WiFi.macAddress(f + n); n += 6;
  f[n++] = WiFi.channel();
  f[n++] = fwLen;
  memcpy(f + n, fw, fwLen); n += fwLen;
  bool admin = host == HOST_SERIAL;
  f[n++] = admin ? ROLE_ADMIN : ROLE_GUEST;
  f[n++] = admin ? PERM_FULL : guests[host].perm;
  memcpy(f + n, &cfg.netId, 4); n += 4;
  f[n++] = nameLen;
  memcpy(f + n, cfg.nodeName, nameLen); n += nameLen;
  // 0.5.0+: chip name, so the app knows which image fits this board.
  f[n++] = chipLen;
  memcpy(f + n, chip, chipLen); n += chipLen;
  hostSend(host, f, n);
}

// Deliver a received air frame to every host.
static void deliver(const AirHeader &h, const uint8_t *body, size_t bodyLen) {
  uint8_t f[MAX_AIR + 16];
  f[0] = H_RECV;
  f[1] = h.type;
  f[2] = h.ttl;
  memcpy(f + 3, &h.origin, 4);
  memcpy(f + 7, &h.msgId, 4);
  f[11] = h.flags;
  memcpy(f + 12, body, bodyLen);
  size_t n = 12 + bodyLen;
  serialWrite(f, n);
  for (uint8_t i = 0; i < 5; i++) {
    Guest &s = guests[i];
    if (!s.connected || !s.authed) continue;
    ws.sendBIN(i, f, n);
    s.rx++;
  }
}

static void kickGuest(uint8_t num, uint8_t reason) {
  if (guests[num].authed) displayNotify(reason == E_BANNED ? "Guest banned" : "Guest kicked");
  uint8_t f[4] = {H_KICKED, reason};
  ws.sendBIN(num, f, 2);
  ws.disconnect(num);
  guests[num].connected = false;
  guests[num].authed = false;
}

static void kickPseudo(const uint8_t *pseudo, uint8_t reason) {
  for (uint8_t i = 0; i < 5; i++) {
    if (guests[i].connected && guests[i].authed && !memcmp(guests[i].pk, pseudo, 8)) kickGuest(i, reason);
  }
}

// ---- Radio ------------------------------------------------------------------

static uint32_t airSend(uint8_t type, uint8_t flags, const uint8_t *body, size_t len, uint8_t ttl) {
  uint8_t f[MAX_AIR];
  AirHeader h = {MAGIC, VERSION, type, ttl, newMsgId(), chipId, cfg.netId, flags};
  memcpy(f, &h, AIR_HDR);
  if (len) memcpy(f + AIR_HDR, body, len);
  computeTag(f, AIR_HDR + len, f + AIR_HDR + len);
  isDuplicate(h.msgId);  // Ignore our own frame when a neighbor relays it.
  halNowSend(f, AIR_HDR + len + TAG_LEN);
  return h.msgId;
}

// POLICY body: [seq 4][count][entries: op(1=ban,2=unban) kind id...][sig 64]
// Signed message: "ml-policy" | netId 4 | body without sig.
static bool applyPolicy(const uint8_t *body, size_t len) {
  if (!cfg.hasOwner || len < 5 + 64) return false;
  size_t signedLen = len - 64;
  uint8_t msg[9 + 4 + MAX_BODY];
  memcpy(msg, "ml-policy", 9);
  memcpy(msg + 9, &cfg.netId, 4);
  memcpy(msg + 13, body, signedLen);
  if (!Ed25519::verify(body + signedLen, cfg.ownerPk, msg, 13 + signedLen)) {
    hostLog("policy: bad signature");
    return false;
  }
  uint32_t seq;
  memcpy(&seq, body, 4);
  if (seq <= cfg.policySeq) return false;  // old or replayed
  size_t i = 5;
  for (uint8_t e = 0; e < body[4] && i + 2 <= signedLen; e++) {
    uint8_t op = body[i], kind = body[i + 1], idLen = banIdLen(kind);
    if (!idLen || i + 2 + idLen > signedLen) break;
    const uint8_t *id = body + i + 2;
    if (op == 1) {
      banAdd(kind, id);
      if (kind == BAN_GUEST) kickPseudo(id, E_BANNED);
    } else if (op == 2) {
      banRemove(kind, id);
    }
    i += 2 + idLen;
  }
  cfg.policySeq = seq;
  configSave();
  bansSave();
  hostLog("policy applied");
  displayNotify("Policy applied", "signed by owner");
  return true;
}

// The receive callback runs in the WiFi task. Copy frames into a queue and
// handle them in loop(), where Serial and esp_now_send are safe to call.
struct RxSlot {
  uint8_t len;
  uint8_t data[MAX_AIR];
};
const uint8_t RXQ = 8;
static RxSlot rxq[RXQ];
static volatile uint8_t rxHead = 0, rxTail = 0;
static volatile uint16_t rxDropped = 0;

static void onRecv(const uint8_t *data, uint8_t len) {
  uint8_t next = (rxHead + 1) % RXQ;
  if (next == rxTail || len > MAX_AIR) {
    rxDropped++;
    return;
  }
  rxq[rxHead].len = len;
  memcpy(rxq[rxHead].data, data, len);
  __sync_synchronize();  // Dual-core chips: publish the bytes before the index.
  rxHead = next;
}

static void relay(uint8_t *data, uint8_t len, uint8_t ttl, bool priority) {
  if (ttl == 0) return;
  data[offsetof(AirHeader, ttl)] = min<uint8_t>(ttl, MAX_TTL) - 1;
  uint16_t jitter = cfg.jitterMs ? 5 + halRandom() % (cfg.jitterMs + 1) : 0;
  queueAir(data, len, priority ? jitter / 4 : jitter);
  statRelayed++;
}

static void handleAir(uint8_t *data, uint8_t len) {
  if (len < AIR_HDR + TAG_LEN) return;
  AirHeader h;
  memcpy(&h, data, AIR_HDR);
  if (h.magic != MAGIC || h.version != VERSION) return;
  if (seenHas(h.msgId)) return;
  if (banHas(BAN_CHIP, (uint8_t *)&h.origin)) return;
  bool priority = h.flags & 1;

  if (h.netId != cfg.netId) {
    // Another network: we cannot check its tag. Help it along, never deliver.
    seenAdd(h.msgId);
    if (!originAllowed(h.origin)) {
      statDropRate++;
      return;
    }
    if (cfg.relayForeign && !banHas(BAN_NET, (uint8_t *)&h.netId)) relay(data, len, h.ttl, priority);
    return;
  }
  // Check the tag BEFORE remembering the msgId or charging the origin's rate
  // budget. Otherwise an outsider could copy a real msgId into a forged frame
  // to suppress the real one, or spoof an origin to use up its budget.
  uint8_t tag[TAG_LEN];
  size_t bodyLen = len - AIR_HDR - TAG_LEN;
  computeTag(data, AIR_HDR + bodyLen, tag);
  if (memcmp(tag, data + AIR_HDR + bodyLen, TAG_LEN) != 0) {
    statDropTag++;  // Outsider or a node that lost the network key.
    return;
  }
  seenAdd(h.msgId);
  peerSeen(h.origin);
  if (!originAllowed(h.origin)) {
    statDropRate++;
    return;
  }
  statRx++;
  if (h.type == AIR_POLICY) applyPolicy(data + AIR_HDR, bodyLen);
  deliver(h, data + AIR_HDR, bodyLen);
  relay(data, len, h.ttl, priority);
}

// ---- Host frame handling -------------------------------------------------------

static bool guestRateOk(Guest &s) {
  if (!cfg.guestRate) return true;
  uint32_t now = millis();
  uint16_t cap = cfg.guestRate * 100;
  uint32_t refill = (now - s.rateMs) * cfg.guestRate / 600;  // x100 per ms
  s.rateTokens = min<uint32_t>(cap, s.rateTokens + refill);
  s.rateMs = now;
  if (s.rateTokens < 100) return false;
  s.rateTokens -= 100;
  return true;
}

static void sendSessions(uint8_t host) {
  uint8_t f[8 + 5 * 17];
  size_t n = 2;
  f[0] = H_SESSIONS;
  uint8_t count = 0;
  uint32_t now = millis();
  for (auto &s : guests) {
    if (!s.connected || !s.authed) continue;
    memcpy(f + n, s.pk, 8); n += 8;
    f[n++] = s.perm;
    uint32_t secs = (now - s.since) / 1000;
    memcpy(f + n, &secs, 4); n += 4;
    memcpy(f + n, &s.tx, 2); n += 2;
    memcpy(f + n, &s.rx, 2); n += 2;
    count++;
  }
  f[1] = count;
  hostSend(host, f, n);
}

static void sendStatus(uint8_t host) {
  uint8_t f[48];
  size_t n = 0;
  f[n++] = H_STATUS;
  uint32_t v[6] = {millis() / 1000, ESP.getFreeHeap(), statRx, statRelayed, statDropTag, statDropRate};
  memcpy(f + n, v, sizeof(v)); n += sizeof(v);
  f[n++] = guestCount();
  f[n++] = cfg.apEnabled;
  f[n++] = cfg.staSsid[0] ? (WiFi.status() == WL_CONNECTED ? 2 : 1) : 0;
  uint32_t staIp = WiFi.localIP(), apIp = WiFi.softAPIP();
  memcpy(f + n, &staIp, 4); n += 4;
  memcpy(f + n, &apIp, 4); n += 4;
  f[n++] = WiFi.channel();
  int8_t rssi = WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0;
  f[n++] = (uint8_t)rssi;
  hostSend(host, f, n);
}

static void handleHostFrame(uint8_t host, uint8_t *f, size_t n) {
  bool admin = host == HOST_SERIAL;
  Guest *s = admin ? nullptr : &guests[host];
  uint8_t type = f[0];
  // Admin-only frames.
  bool adminOnly = type == H_CONFIG_GET || type == H_CONFIG_SET || type == H_KICK || type == H_BAN ||
                   type == H_UNBAN || type == H_SET_PERM || type == H_REBOOT || type == H_FACTORY_RESET ||
                   type == H_BANS_REQ || type == H_SESSIONS_REQ;
  if (adminOnly && !admin) {
    hostErr(host, E_FORBIDDEN, "admin only (USB)");
    return;
  }
  switch (type) {
    case H_SEND: {
      if (n < 3 || n - 3 > MAX_BODY) {
        hostErr(host, E_BAD_FRAME, "bad send length");
        return;
      }
      uint8_t airType = f[1];
      if (airType == AIR_BEACON || (airType == AIR_POLICY && !admin)) {
        hostErr(host, E_FORBIDDEN, "frame type not allowed");
        return;
      }
      if (s) {
        bool ok = s->perm == PERM_FULL || (s->perm == PERM_DM && (airType == AIR_DM || airType == AIR_ANNOUNCE));
        if (!ok) {
          hostErr(host, E_FORBIDDEN, "no permission to send this");
          return;
        }
        if (!guestRateOk(*s)) {
          hostErr(host, E_RATE, "slow down");
          return;
        }
        s->tx++;
      }
      if (airType == AIR_POLICY) applyPolicy(f + 3, n - 3);
      uint32_t id = airSend(airType, f[2], f + 3, n - 3, cfg.ttl);
      uint8_t r[8] = {H_SENT};
      memcpy(r + 1, &id, 4);
      hostSend(host, r, 5);
      break;
    }
    case H_INFO_REQ: {
      static bool usbSeen = false;
      if (admin && !usbSeen) {
        usbSeen = true;
        displayNotify("USB host", "app connected");
      }
      hostInfo(host);
      break;
    }
    case H_STATUS_REQ:
      sendStatus(host);
      break;
    case H_CONFIG_GET: {
      uint8_t out[400];
      out[0] = H_CONFIG;
      size_t len = configEncode(out + 1, sizeof(out) - 3);
      hostSend(host, out, len + 1);
      break;
    }
    case H_CONFIG_SET: {
      bool restart = false;
      if (!configApply(f + 1, n - 1, &restart)) {
        hostErr(host, E_BAD_FRAME, "bad config");
        return;
      }
      configSave();
      displayNotify("Config saved", restart ? "restarting..." : nullptr);
      uint8_t out[400];
      out[0] = H_CONFIG;
      size_t len = configEncode(out + 1, sizeof(out) - 3);
      hostSend(host, out, len + 1);
      if (restart) {
        hostLog("restarting to apply Wi-Fi settings");
        delay(200);
        ESP.restart();
      }
      break;
    }
    case H_KICK:
      if (n >= 9) kickPseudo(f + 1, 0);
      sendSessions(host);
      break;
    case H_BAN:
    case H_UNBAN: {
      uint8_t kind = n >= 2 ? f[1] : 0, idLen = banIdLen(kind);
      if (!idLen || n < 2u + idLen) {
        hostErr(host, E_BAD_FRAME, "bad ban");
        return;
      }
      if (type == H_BAN) {
        banAdd(kind, f + 2);
        if (kind == BAN_GUEST) kickPseudo(f + 2, E_BANNED);
      } else {
        banRemove(kind, f + 2);
      }
      bansSave();
      // fall through: reply with the ban list
    }
    case H_BANS_REQ: {
      uint8_t out[400];
      out[0] = H_BANS;
      size_t len = bansEncode(out + 1, sizeof(out) - 3);
      hostSend(host, out, len + 1);
      break;
    }
    case H_SET_PERM:
      if (n >= 10) {
        for (auto &g : guests) {
          if (g.connected && g.authed && !memcmp(g.pk, f + 1, 8)) g.perm = min<uint8_t>(f[9], PERM_FULL);
        }
      }
      sendSessions(host);
      break;
    case H_SESSIONS_REQ:
      sendSessions(host);
      break;
    case H_REBOOT:
      displayBye("Rebooting...");
      ESP.restart();
      break;
    case H_FACTORY_RESET:
      configFactoryReset();
      displayBye("Factory reset");
      ESP.restart();
      break;
    default:
      hostErr(host, E_BAD_FRAME, "unknown host frame");
  }
}

// ---- USB serial input -----------------------------------------------------------

static uint8_t inBuf[MAX_AIR + 48];
static size_t inLen = 0;
static bool inOverflow = false;

static void pollSerial() {
  while (Serial.available()) {
    uint8_t c = Serial.read();
    if (c == 0) {
      if (!inOverflow && inLen > 0) {
        uint8_t f[sizeof(inBuf) + 2];
        size_t n = cobsDecode(inBuf, inLen, f);
        if (n >= 3) {
          uint16_t crc = f[n - 2] | (f[n - 1] << 8);
          n -= 2;
          if (crc16(f, n) == crc) handleHostFrame(HOST_SERIAL, f, n);
        }
      }
      inLen = 0;
      inOverflow = false;
    } else if (inLen < sizeof(inBuf)) {
      inBuf[inLen++] = c;
    } else {
      inOverflow = true;
    }
  }
}

// ---- Wi-Fi guests (WebSocket) -----------------------------------------------------

static void onWs(uint8_t num, WStype_t type, uint8_t *payload, size_t len) {
  if (num >= 5) return;
  Guest &s = guests[num];
  switch (type) {
    case WStype_CONNECTED: {
      // Guests must be on the node's own hotspot unless the admin allows the
      // home network: anyone on a router LAN could otherwise join as a guest
      // and send frames tagged with the network key.
      if (!ipAllowed(ws.remoteIP(num))) {
        uint8_t f[40] = {H_ERR, E_FORBIDDEN};
        const char *msg = "guests from home Wi-Fi are off";
        size_t ml = strlen(msg);
        memcpy(f + 2, msg, ml);
        ws.sendBIN(num, f, 2 + ml);
        ws.disconnect(num);
        return;
      }
      if (guestCount() >= cfg.guestMax) {
        uint8_t f[24] = {H_ERR, E_FULL};
        memcpy(f + 2, "node full", 9);
        ws.sendBIN(num, f, 11);
        ws.disconnect(num);
        return;
      }
      memset(&s, 0, sizeof(s));
      s.connected = true;
      s.num = num;
      s.since = millis();  // Auth deadline starts now (see dropSlowAuth).
      for (auto &b : s.nonce) b = halRandom();
      uint8_t f[64];
      size_t n = 0, nameLen = strlen(cfg.nodeName);
      f[n++] = H_HELLO;
      memcpy(f + n, s.nonce, 16); n += 16;
      memcpy(f + n, &chipId, 4); n += 4;
      memcpy(f + n, &cfg.netId, 4); n += 4;
      f[n++] = nameLen;
      memcpy(f + n, cfg.nodeName, nameLen); n += nameLen;
      ws.sendBIN(num, f, n);
      break;
    }
    case WStype_DISCONNECTED:
      if (s.authed) displayNotify("Guest left");
      s.connected = false;
      s.authed = false;
      break;
    case WStype_BIN: {
      if (!s.connected || len < 1 || len > MAX_AIR + 16) return;
      if (!s.authed) {
        // AUTH: [pk 32][sig 64] over "ml-auth" | nonce 16 | chipId 4
        if (payload[0] != H_AUTH || len != 97) {
          kickGuest(num, E_AUTH);
          return;
        }
        uint8_t msg[27];
        memcpy(msg, "ml-auth", 7);
        memcpy(msg + 7, s.nonce, 16);
        memcpy(msg + 23, &chipId, 4);
        if (!Ed25519::verify(payload + 33, payload + 1, msg, sizeof(msg))) {
          kickGuest(num, E_AUTH);
          return;
        }
        if (banHas(BAN_GUEST, payload + 1)) {
          kickGuest(num, E_BANNED);
          return;
        }
        memcpy(s.pk, payload + 1, 32);
        s.authed = true;
        s.perm = cfg.guestPerm;
        s.since = millis();
        s.rateMs = millis();
        s.rateTokens = cfg.guestRate * 100;
        uint8_t ok[4] = {H_AUTH_OK, ROLE_GUEST, s.perm};
        ws.sendBIN(num, ok, 3);
        hostLog("guest joined");
        char who[12];
        snprintf(who, sizeof(who), "%02X%02X%02X%02X", s.pk[0], s.pk[1], s.pk[2], s.pk[3]);
        displayNotify("Guest joined", who);
        return;
      }
      uint8_t f[MAX_AIR + 20];
      memcpy(f, payload, len);
      handleHostFrame(num, f, len);
      break;
    }
    default:
      break;
  }
}

static void handleHttpRoot() {
  if (!ipAllowed(http.client().remoteIP())) {
    http.send(404, "text/plain", "not found");
    return;
  }
  if (LittleFS.exists("/www/index.html.gz") || LittleFS.exists("/www/index.html")) {
    File f = LittleFS.open(LittleFS.exists("/www/index.html.gz") ? "/www/index.html.gz" : "/www/index.html", "r");
    http.streamFile(f, "text/html");
    f.close();
    return;
  }
  String page = F("<!doctype html><meta name=viewport content='width=device-width'><title>MeshLink node</title>"
                  "<body style='font-family:system-ui;padding:24px;background:#0b0f14;color:#e6edf3'>"
                  "<h2>MeshLink node</h2><p>");
  for (const char *c = cfg.nodeName; *c; c++) {  // HTML-escape the node name.
    if (*c == '<') page += F("&lt;");
    else if (*c == '>') page += F("&gt;");
    else if (*c == '&') page += F("&amp;");
    else if (*c == '"' || *c == '\'') page += F("&#39;");
    else page += *c;
  }
  page += F("</p><p>Connect with the MeshLink desktop app. The phone app is not installed on this node yet.</p>");
  http.send(200, "text/html", page);
}

// Only plain paths under /www. LittleFS resolves "..", so "/../cfg.bin" would
// otherwise serve the config file with the network key and Wi-Fi passwords.
static bool safeWebPath(const String &uri) {
  if (uri.length() < 2 || uri.length() > 64 || uri[0] != '/' || uri.indexOf("..") >= 0 || uri.indexOf("//") >= 0) return false;
  for (size_t i = 0; i < uri.length(); i++) {
    char c = uri[i];
    if (!isalnum((unsigned char)c) && c != '/' && c != '.' && c != '-' && c != '_') return false;
  }
  return true;
}

static void handleHttpFile() {
  if (!ipAllowed(http.client().remoteIP()) || !safeWebPath(http.uri())) {
    http.send(404, "text/plain", "not found");
    return;
  }
  String path = "/www" + http.uri();
  if (LittleFS.exists(path + ".gz")) path += ".gz";
  if (!LittleFS.exists(path)) {
    http.send(404, "text/plain", "not found");
    return;
  }
  File f = LittleFS.open(path, "r");
  String uri = http.uri();
  const char *mime = uri.endsWith(".js") ? "application/javascript" : uri.endsWith(".css") ? "text/css"
                   : uri.endsWith(".svg") ? "image/svg+xml" : uri.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
  http.streamFile(f, mime);
  f.close();
}

// UDP discovery on port 4210: "MLDISCOVER" -> "MLNODE"[chipId 4][netId 4][nameLen][name]
static void pollUdp() {
  int size = udp.parsePacket();
  if (size <= 0) return;
  char buf[16];
  int n = udp.read(buf, sizeof(buf));
  if (n != 10 || memcmp(buf, "MLDISCOVER", 10) != 0) return;
  if (!ipAllowed(udp.remoteIP())) return;  // Stay silent on the home network.
  uint8_t r[64];
  size_t len = 0, nameLen = strlen(cfg.nodeName);
  memcpy(r, "MLNODE", 6); len = 6;
  memcpy(r + len, &chipId, 4); len += 4;
  memcpy(r + len, &cfg.netId, 4); len += 4;
  r[len++] = nameLen;
  memcpy(r + len, cfg.nodeName, nameLen); len += nameLen;
  udp.beginPacket(udp.remoteIP(), udp.remotePort());
  udp.write(r, len);
  udp.endPacket();
}

static void startWifi() {
  bool ap = cfg.apEnabled;
  WiFi.persistent(false);
  WiFi.mode(ap ? WIFI_AP_STA : WIFI_STA);
  WiFi.disconnect();
  halSetChannel(cfg.channel);
  if (ap) {
    const char *psk = cfg.apOpen || strlen(cfg.apPsk) < 8 ? nullptr : cfg.apPsk;
    WiFi.softAP(cfg.apSsid, psk, cfg.channel, cfg.apHidden || cfg.stealth, cfg.guestMax);
  }
  if (cfg.staSsid[0]) {
    // The radio follows the router's channel. All nodes must use it.
    WiFi.begin(cfg.staSsid, cfg.staPsk);
  }
  if (ap || cfg.staSsid[0]) {
    ws.begin();
    ws.onEvent(onWs);
    http.on("/", handleHttpRoot);
    http.onNotFound(handleHttpFile);
    http.begin();
    udp.begin(4210);
    char host[24];
    snprintf(host, sizeof(host), "meshlink-%04x", (unsigned)(chipId & 0xFFFF));
    // mDNS names this node to every device on the network: only when LAN guests are on.
    if (cfg.lanGuests && MDNS.begin(host)) {
      MDNS.addService("meshlink", "tcp", 81);
      mdnsUp = true;
    }
    netUp = true;
  }
}

// A connection that never authenticates would hold a guest slot forever.
const uint32_t AUTH_TIMEOUT_MS = 5000;

static void dropSlowAuth() {
  uint32_t now = millis();
  for (uint8_t i = 0; i < 5; i++) {
    if (guests[i].connected && !guests[i].authed && now - guests[i].since > AUTH_TIMEOUT_MS) kickGuest(i, E_AUTH);
  }
}

// ---- Main -------------------------------------------------------------------

static void fillStats(DisplayStats &s) {
  s.flashKB = ESP.getFlashChipSize() / 1024;
  s.peers = peerCount();
  s.nodeName = cfg.nodeName;
  s.netName = cfg.netName;
  s.apSsid = cfg.apSsid;
  s.fw = ML_FW_VERSION;
  s.chip = halChipName();
  s.chipId = chipId;
  s.uptimeS = millis() / 1000;
  s.heap = ESP.getFreeHeap();
  s.rx = statRx;
  s.relayed = statRelayed;
  s.dropTag = statDropTag;
  s.dropRate = statDropRate;
  s.apIp = cfg.apEnabled ? (uint32_t)WiFi.softAPIP() : 0;
  s.staIp = (uint32_t)WiFi.localIP();
  s.rxQueueDrops = rxDropped;
  s.channel = WiFi.channel();
  s.guests = guestCount();
  s.apUp = cfg.apEnabled;
  s.staState = cfg.staSsid[0] ? (WiFi.status() == WL_CONNECTED ? 2 : 1) : 0;
}

static void showStatus() {
  DisplayStats s;
  fillStats(s);
  static uint8_t lastSta = 0;
  if (s.staState != lastSta) {
    if (s.staState == 2) {
      char ip[20];
      snprintf(ip, sizeof(ip), "%u.%u.%u.%u", (unsigned)(s.staIp & 0xFF), (unsigned)((s.staIp >> 8) & 0xFF), (unsigned)((s.staIp >> 16) & 0xFF), (unsigned)(s.staIp >> 24));
      displayNotify("Home Wi-Fi up", ip);
    } else if (lastSta == 2) {
      displayNotify("Home Wi-Fi lost");
    }
    lastSta = s.staState;
  }
  displayUpdate(s);
}

void setup() {
  Serial.setRxBufferSize(1024);
  Serial.begin(115200);
  chipId = halChipId();
  configInit(chipId);
  // Screen first: the user sees the node is alive while Wi-Fi comes up.
  const char *oled = displayInit(ML_FW_VERSION);
  displayBootLine("Config", "OK");
  startWifi();
  {
    char v[16];
    if (cfg.apEnabled) snprintf(v, sizeof(v), "ch%u", (unsigned)cfg.channel);
    displayBootLine("Wi-Fi hotspot", cfg.apEnabled ? v : "off");
    displayBootLine("Home Wi-Fi", cfg.staSsid[0] ? "joining" : "off");
  }

  if (!halNowBegin(cfg.channel, onRecv)) {
    displayFatal("Radio init failed");
    delay(1500);
    ESP.restart();
  }
  displayBootLine("Radio ESP-NOW", "OK");
  displayBootLine("Network", cfg.netId ? "private" : "open");
  {
    char v[16];
    snprintf(v, sizeof(v), "ttl %u", (unsigned)cfg.ttl);
    displayBootLine("Relay", cfg.relayForeign ? v : "own net");
  }
  displayBootLine("Owner key", cfg.hasOwner ? "set" : "none");

  hostInfo(HOST_SERIAL);
  hostLog(oled);
  hostLog("node ready");
  DisplayStats s;
  fillStats(s);
  displayBootDone(s);
}

void loop() {
  pollSerial();
  displayPoll();
  if (displayDue()) showStatus();
  if (netUp) {
    ws.loop();
    dropSlowAuth();
    http.handleClient();
    pollUdp();
    if (mdnsUp) halMdnsUpdate();
  }

  while (rxTail != rxHead) {
    handleAir(rxq[rxTail].data, rxq[rxTail].len);
    rxTail = (rxTail + 1) % RXQ;
  }
  pumpTx();

  static uint32_t lastBeacon = 0;
  if (cfg.beaconSec && !cfg.stealth && millis() - lastBeacon > cfg.beaconSec * 1000UL) {
    lastBeacon = millis();
    airSend(AIR_BEACON, 0, nullptr, 0, 0);
  }

  static uint16_t reportedDrops = 0;
  if (rxDropped != reportedDrops) {
    reportedDrops = rxDropped;
    hostLog("rx queue full, frame dropped");
    displayNotify("Radio busy", "rx queue full");
  }
#if !defined(ESP8266)
  delay(1);  // Let the idle task run; the ESP8266 core yields on its own.
#endif
}
