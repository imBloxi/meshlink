// Node configuration and ban lists, persisted in LittleFS.
// Only the admin (USB host) or a signed network policy can change them.
#pragma once
#include <Arduino.h>

#include "protocol.h"

namespace ml {

struct Config {
  char nodeName[33];
  char netName[33];
  uint32_t netId;              // 0 = open network
  uint8_t netKey[NET_KEY_LEN]; // all zero for the open network
  uint8_t channel;
  bool apEnabled, apHidden, apOpen;
  char apSsid[33];
  char apPsk[64];
  char staSsid[33];
  char staPsk[64];
  bool hasOwner;
  uint8_t ownerPk[32];  // Ed25519 key that signs network policy
  uint32_t policySeq;   // last applied policy, blocks replays
  uint8_t guestPerm;    // default permission for new Wi-Fi guests
  uint8_t guestMax;     // 1..4
  uint8_t guestRate;    // frames per minute per guest, 0 = no limit
  bool relayForeign;    // relay frames of other networks (without reading them)
  uint8_t beaconSec;    // 0 = no beacon
  uint8_t ttl;
  uint8_t jitterMs;     // max random relay delay
  uint8_t originRate;   // max frames/s relayed per origin node
  bool stealth;         // no beacons, hidden AP
  bool lanGuests;       // accept Wi-Fi guests from the home router network, not only the node's hotspot
};

const uint8_t MAX_BAN_GUESTS = 32, MAX_BAN_CHIPS = 16, MAX_BAN_NETS = 8;

struct Bans {
  uint8_t guestCount, chipCount, netCount;
  uint8_t guests[MAX_BAN_GUESTS][8];
  uint32_t chips[MAX_BAN_CHIPS];
  uint32_t nets[MAX_BAN_NETS];
};

extern Config cfg;
extern Bans bans;

void configInit(uint32_t chipId);  // mount LittleFS, load or create defaults
bool configSave();
void configFactoryReset();
// Apply a TLV list from H_CONFIG_SET. Returns false on a malformed list.
bool configApply(const uint8_t *tlv, size_t len, bool *needsRestart);
// Write the config as TLV into out. Returns the length.
size_t configEncode(uint8_t *out, size_t cap);

bool banHas(uint8_t kind, const uint8_t *id);
bool banAdd(uint8_t kind, const uint8_t *id);
bool banRemove(uint8_t kind, const uint8_t *id);
bool bansSave();
size_t bansEncode(uint8_t *out, size_t cap);
uint8_t banIdLen(uint8_t kind);

}  // namespace ml
