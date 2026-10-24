#include "config.h"

#include <LittleFS.h>

#include "chip.h"

namespace ml {

Config cfg;
Bans bans;

static const char *CFG_PATH = "/cfg.bin";
static const char *BANS_PATH = "/bans.bin";
static const uint32_t CFG_MAGIC = 0x4D4C4332;  // "MLC2"
static bool fsOk = false;

static void setStr(char *dst, size_t cap, const uint8_t *src, size_t len) {
  if (len >= cap) len = cap - 1;
  memcpy(dst, src, len);
  dst[len] = 0;
}

static void defaults(uint32_t chipId) {
  memset(&cfg, 0, sizeof(cfg));
  snprintf(cfg.nodeName, sizeof(cfg.nodeName), "Node %04X", (unsigned)(chipId & 0xFFFF));
  strcpy(cfg.netName, "Open network");
  cfg.channel = DEFAULT_CHANNEL;
  cfg.apEnabled = true;
  snprintf(cfg.apSsid, sizeof(cfg.apSsid), "MeshLink-%04X", (unsigned)(chipId & 0xFFFF));
  // Random WPA2 password. The admin reads it over USB and shares it.
  const char *abc = "abcdefghjkmnpqrstuvwxyz23456789";
  for (int i = 0; i < 12; i++) cfg.apPsk[i] = abc[halRandom() % 31];
  cfg.apPsk[12] = 0;
  cfg.guestPerm = PERM_FULL;
  cfg.guestMax = 4;
  cfg.guestRate = 60;
  cfg.relayForeign = true;
  cfg.beaconSec = 10;
  cfg.ttl = DEFAULT_TTL;
  cfg.jitterMs = 40;
  cfg.originRate = 10;
}

void configInit(uint32_t chipId) {
  fsOk = LittleFS.begin();
  if (!fsOk) {
    LittleFS.format();
    fsOk = LittleFS.begin();
  }
  defaults(chipId);
  memset(&bans, 0, sizeof(bans));
  bool loaded = false;
  if (fsOk) {
    File f = LittleFS.open(CFG_PATH, "r");
    if (f) {
      uint32_t magic = 0;
      if (f.read((uint8_t *)&magic, 4) == 4 && magic == CFG_MAGIC) {
        size_t n = f.size() - 4;
        uint8_t *buf = (uint8_t *)malloc(n);
        if (buf && f.read(buf, n) == n) {
          bool dummy;
          loaded = configApply(buf, n, &dummy);
        }
        free(buf);
      }
      f.close();
    }
    File b = LittleFS.open(BANS_PATH, "r");
    if (b) {
      if (b.size() == sizeof(bans)) b.read((uint8_t *)&bans, sizeof(bans));
      b.close();
    }
  }
  if (!loaded) configSave();  // Persist the generated AP password.
}

bool configSave() {
  if (!fsOk) return false;
  uint8_t buf[512];
  size_t n = configEncode(buf, sizeof(buf));
  File f = LittleFS.open(CFG_PATH, "w");
  if (!f) return false;
  f.write((const uint8_t *)&CFG_MAGIC, 4);
  f.write(buf, n);
  f.close();
  return true;
}

void configFactoryReset() {
  if (fsOk) {
    LittleFS.remove(CFG_PATH);
    LittleFS.remove(BANS_PATH);
  }
}

bool configApply(const uint8_t *t, size_t len, bool *restart) {
  size_t i = 0;
  *restart = false;
  while (i + 2 <= len) {
    uint8_t id = t[i], l = t[i + 1];
    const uint8_t *v = t + i + 2;
    if (i + 2 + l > len) return false;
    auto u8 = [&]() { return l ? v[0] : 0; };
    switch (id) {
      case C_NODE_NAME: setStr(cfg.nodeName, sizeof(cfg.nodeName), v, l); break;
      case C_NET_NAME: setStr(cfg.netName, sizeof(cfg.netName), v, l); break;
      case C_NET_ID: if (l == 4) memcpy(&cfg.netId, v, 4); break;
      case C_NET_KEY: if (l == NET_KEY_LEN) memcpy(cfg.netKey, v, NET_KEY_LEN); break;
      case C_CHANNEL: if (u8() >= 1 && u8() <= 13) { cfg.channel = u8(); *restart = true; } break;
      case C_AP_SSID: setStr(cfg.apSsid, sizeof(cfg.apSsid), v, l); *restart = true; break;
      case C_AP_PSK: if (l == 0 || l >= 8) { setStr(cfg.apPsk, sizeof(cfg.apPsk), v, l); *restart = true; } break;
      case C_AP_HIDDEN: cfg.apHidden = u8(); *restart = true; break;
      case C_AP_ENABLED: cfg.apEnabled = u8(); *restart = true; break;
      case C_AP_OPEN: cfg.apOpen = u8(); *restart = true; break;
      case C_STA_SSID: setStr(cfg.staSsid, sizeof(cfg.staSsid), v, l); *restart = true; break;
      case C_STA_PSK: setStr(cfg.staPsk, sizeof(cfg.staPsk), v, l); *restart = true; break;
      case C_OWNER_PK:
        cfg.hasOwner = l == 32;
        if (cfg.hasOwner) memcpy(cfg.ownerPk, v, 32);
        break;
      case C_POLICY_SEQ: if (l == 4) memcpy(&cfg.policySeq, v, 4); break;
      case C_GUEST_PERM: if (u8() <= PERM_FULL) cfg.guestPerm = u8(); break;
      case C_GUEST_MAX: if (u8() >= 1 && u8() <= 4) cfg.guestMax = u8(); break;
      case C_GUEST_RATE: cfg.guestRate = u8(); break;
      case C_RELAY_FOREIGN: cfg.relayForeign = u8(); break;
      case C_BEACON_SEC: cfg.beaconSec = u8(); break;
      case C_TTL: if (u8() <= MAX_TTL) cfg.ttl = u8(); break;
      case C_JITTER_MS: cfg.jitterMs = u8(); break;
      case C_ORIGIN_RATE: cfg.originRate = u8(); break;
      case C_STEALTH: cfg.stealth = u8(); *restart = true; break;
      case C_LAN_GUESTS: cfg.lanGuests = u8(); break;
      default: break;  // Unknown fields from newer apps are ignored.
    }
    i += 2 + l;
  }
  return i == len;
}

static size_t put(uint8_t *out, size_t cap, size_t n, uint8_t id, const void *v, size_t l) {
  if (n + 2 + l > cap) return n;
  out[n] = id;
  out[n + 1] = l;
  memcpy(out + n + 2, v, l);
  return n + 2 + l;
}

size_t configEncode(uint8_t *o, size_t cap) {
  size_t n = 0;
  uint8_t b;
#define PUT_STR(id, s) n = put(o, cap, n, id, s, strlen(s))
#define PUT_U8(id, x) (b = (x), n = put(o, cap, n, id, &b, 1))
  PUT_STR(C_NODE_NAME, cfg.nodeName);
  PUT_STR(C_NET_NAME, cfg.netName);
  n = put(o, cap, n, C_NET_ID, &cfg.netId, 4);
  n = put(o, cap, n, C_NET_KEY, cfg.netKey, NET_KEY_LEN);
  PUT_U8(C_CHANNEL, cfg.channel);
  PUT_STR(C_AP_SSID, cfg.apSsid);
  PUT_STR(C_AP_PSK, cfg.apPsk);
  PUT_U8(C_AP_HIDDEN, cfg.apHidden);
  PUT_U8(C_AP_ENABLED, cfg.apEnabled);
  PUT_U8(C_AP_OPEN, cfg.apOpen);
  PUT_STR(C_STA_SSID, cfg.staSsid);
  PUT_STR(C_STA_PSK, cfg.staPsk);
  n = put(o, cap, n, C_OWNER_PK, cfg.ownerPk, cfg.hasOwner ? 32 : 0);
  n = put(o, cap, n, C_POLICY_SEQ, &cfg.policySeq, 4);
  PUT_U8(C_GUEST_PERM, cfg.guestPerm);
  PUT_U8(C_GUEST_MAX, cfg.guestMax);
  PUT_U8(C_GUEST_RATE, cfg.guestRate);
  PUT_U8(C_RELAY_FOREIGN, cfg.relayForeign);
  PUT_U8(C_BEACON_SEC, cfg.beaconSec);
  PUT_U8(C_TTL, cfg.ttl);
  PUT_U8(C_JITTER_MS, cfg.jitterMs);
  PUT_U8(C_ORIGIN_RATE, cfg.originRate);
  PUT_U8(C_STEALTH, cfg.stealth);
  PUT_U8(C_LAN_GUESTS, cfg.lanGuests);
#undef PUT_STR
#undef PUT_U8
  return n;
}

// ---- Bans ----

uint8_t banIdLen(uint8_t kind) {
  return kind == BAN_GUEST ? 8 : (kind == BAN_CHIP || kind == BAN_NET) ? 4 : 0;
}

static int banFind(uint8_t kind, const uint8_t *id) {
  if (kind == BAN_GUEST) {
    for (int i = 0; i < bans.guestCount; i++) if (!memcmp(bans.guests[i], id, 8)) return i;
  } else {
    uint32_t x;
    memcpy(&x, id, 4);
    uint32_t *arr = kind == BAN_CHIP ? bans.chips : bans.nets;
    uint8_t cnt = kind == BAN_CHIP ? bans.chipCount : bans.netCount;
    for (int i = 0; i < cnt; i++) if (arr[i] == x) return i;
  }
  return -1;
}

bool banHas(uint8_t kind, const uint8_t *id) { return banFind(kind, id) >= 0; }

bool banAdd(uint8_t kind, const uint8_t *id) {
  if (!banIdLen(kind) || banHas(kind, id)) return false;
  if (kind == BAN_GUEST) {
    // Full list: forget the oldest entry.
    if (bans.guestCount == MAX_BAN_GUESTS) { memmove(bans.guests[0], bans.guests[1], 8 * (MAX_BAN_GUESTS - 1)); bans.guestCount--; }
    memcpy(bans.guests[bans.guestCount++], id, 8);
  } else if (kind == BAN_CHIP) {
    if (bans.chipCount == MAX_BAN_CHIPS) { memmove(bans.chips, bans.chips + 1, 4 * (MAX_BAN_CHIPS - 1)); bans.chipCount--; }
    memcpy(&bans.chips[bans.chipCount++], id, 4);
  } else {
    if (bans.netCount == MAX_BAN_NETS) { memmove(bans.nets, bans.nets + 1, 4 * (MAX_BAN_NETS - 1)); bans.netCount--; }
    memcpy(&bans.nets[bans.netCount++], id, 4);
  }
  return true;
}

bool banRemove(uint8_t kind, const uint8_t *id) {
  int i = banFind(kind, id);
  if (i < 0) return false;
  if (kind == BAN_GUEST) {
    memmove(bans.guests[i], bans.guests[i + 1], 8 * (bans.guestCount - i - 1));
    bans.guestCount--;
  } else if (kind == BAN_CHIP) {
    memmove(&bans.chips[i], &bans.chips[i + 1], 4 * (bans.chipCount - i - 1));
    bans.chipCount--;
  } else {
    memmove(&bans.nets[i], &bans.nets[i + 1], 4 * (bans.netCount - i - 1));
    bans.netCount--;
  }
  return true;
}

bool bansSave() {
  if (!fsOk) return false;
  File f = LittleFS.open(BANS_PATH, "w");
  if (!f) return false;
  f.write((const uint8_t *)&bans, sizeof(bans));
  f.close();
  return true;
}

size_t bansEncode(uint8_t *o, size_t cap) {
  size_t n = 1;
  uint8_t count = 0;
  for (int i = 0; i < bans.guestCount && n + 10 <= cap; i++, count++) {
    o[n++] = BAN_GUEST; o[n++] = 8; memcpy(o + n, bans.guests[i], 8); n += 8;
  }
  for (int i = 0; i < bans.chipCount && n + 6 <= cap; i++, count++) {
    o[n++] = BAN_CHIP; o[n++] = 4; memcpy(o + n, &bans.chips[i], 4); n += 4;
  }
  for (int i = 0; i < bans.netCount && n + 6 <= cap; i++, count++) {
    o[n++] = BAN_NET; o[n++] = 4; memcpy(o + n, &bans.nets[i], 4); n += 4;
  }
  o[0] = count;
  return n;
}

}  // namespace ml
