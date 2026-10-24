// MeshLink wire protocol v2 constants. Keep in sync with
// desktop/src/core/protocol.ts and PROTOCOL.md.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace ml {

const uint8_t MAGIC = 0x4D;  // ASCII M
const uint8_t VERSION = 2;   // Air protocol version.
// Firmware release. The desktop app compares this with its bundled image.
#define ML_FW_VERSION "0.4.1"
const uint8_t DEFAULT_CHANNEL = 6;
const uint8_t DEFAULT_TTL = 3;
const uint8_t MAX_TTL = 7;
const uint8_t MAX_AIR = 250;  // ESP-NOW payload limit.
const uint8_t TAG_LEN = 8;    // Keyed BLAKE2s network tag at the end of each air frame.
const uint8_t NET_KEY_LEN = 16;

// Air frame types.
enum AirType : uint8_t {
  AIR_BEACON = 0x01,    // Node presence, not relayed.
  AIR_DM = 0x02,        // End-to-end encrypted direct message (hidden recipient).
  AIR_ANNOUNCE = 0x03,  // Signed app identity.
  AIR_ROOM = 0x04,      // Room message, encrypted with the room key.
  AIR_POLICY = 0x06,    // Network policy signed by the network owner. Nodes apply it.
};

// Air header. All integers little-endian. The frame is
// [AirHeader][body][tag 8]; tag = BLAKE2s(key = netKey, frame with ttl = 0).
struct __attribute__((packed)) AirHeader {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  uint8_t ttl;
  uint32_t msgId;   // Random, used for dedupe.
  uint32_t origin;  // Chip id of the node that first sent the frame.
  uint32_t netId;   // Network the frame belongs to. 0 = open network.
  uint8_t flags;    // Bit 0: priority.
};
const uint8_t AIR_HDR = sizeof(AirHeader);            // 17
const uint8_t MAX_BODY = MAX_AIR - AIR_HDR - TAG_LEN;  // 225

// Host frames. Over USB serial: COBS([type][payload...][crc16 LE]) + 0x00.
// Over WebSocket: one binary message = [type][payload...] (no COBS, no CRC).
enum HostType : uint8_t {
  // host -> node
  H_SEND = 0x10,        // [airType][flags][body]
  H_INFO_REQ = 0x11,    //
  H_CONFIG_GET = 0x12,  // admin
  H_CONFIG_SET = 0x13,  // admin: TLV list
  H_AUTH = 0x14,        // Wi-Fi: [pk 32][sig 64 over "ml-auth" nonce chipId]
  H_KICK = 0x15,        // admin: [pseudo 8]
  H_BAN = 0x16,         // admin: [kind][id]
  H_UNBAN = 0x17,       // admin: [kind][id]
  H_SET_PERM = 0x18,    // admin: [pseudo 8][perm]
  H_SESSIONS_REQ = 0x19,
  H_STATUS_REQ = 0x1A,
  H_REBOOT = 0x1B,       // admin
  H_FACTORY_RESET = 0x1C,// admin
  H_BANS_REQ = 0x1D,     // admin
  // node -> host
  H_RECV = 0x20,      // [airType][ttl][origin 4][msgId 4][flags][body]
  H_INFO = 0x21,      // [ver][chipId 4][mac 6][channel][fwLen][fw][role][perm][netId 4][nameLen][name]
  H_LOG = 0x22,       // UTF-8 text
  H_SENT = 0x23,      // [msgId 4]
  H_CONFIG = 0x24,    // TLV list
  H_STATUS = 0x26,    // see PROTOCOL.md
  H_SESSIONS = 0x28,  // [count] then per guest [pseudo 8][perm][since s 4][tx 2][rx 2]
  H_HELLO = 0x29,     // Wi-Fi: [nonce 16][chipId 4][netId 4][nameLen][name]
  H_AUTH_OK = 0x2A,   // Wi-Fi: [role][perm]
  H_BANS = 0x2B,      // [count] then [kind][len][id]
  H_KICKED = 0x2C,    // node -> guest: [reason]
  H_ERR = 0x2F,       // [code][UTF-8 text]
};

enum Role : uint8_t { ROLE_ADMIN = 1, ROLE_GUEST = 2 };
// Guest permission levels.
enum Perm : uint8_t { PERM_READ = 0, PERM_DM = 1, PERM_FULL = 2 };
enum BanKind : uint8_t { BAN_GUEST = 1, BAN_CHIP = 2, BAN_NET = 3 };
enum ErrCode : uint8_t {
  E_FORBIDDEN = 1, E_BAD_FRAME = 2, E_RATE = 3, E_AUTH = 4, E_FULL = 5, E_BANNED = 6,
};

// Config TLV field ids (H_CONFIG / H_CONFIG_SET).
enum CfgField : uint8_t {
  C_NODE_NAME = 1, C_NET_ID = 2, C_NET_KEY = 3, C_CHANNEL = 4, C_AP_SSID = 5, C_AP_PSK = 6,
  C_AP_HIDDEN = 7, C_AP_ENABLED = 8, C_STA_SSID = 9, C_STA_PSK = 10, C_OWNER_PK = 11,
  C_GUEST_PERM = 12, C_GUEST_MAX = 13, C_GUEST_RATE = 14, C_RELAY_FOREIGN = 15,
  C_BEACON_SEC = 16, C_TTL = 17, C_JITTER_MS = 18, C_ORIGIN_RATE = 19, C_STEALTH = 20,
  C_NET_NAME = 21, C_POLICY_SEQ = 22, C_AP_OPEN = 23, C_LAN_GUESTS = 24,
};

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF.
inline uint16_t crc16(const uint8_t *d, size_t n) {
  uint16_t c = 0xFFFF;
  while (n--) {
    c ^= (uint16_t)(*d++) << 8;
    for (uint8_t i = 0; i < 8; i++) c = (c & 0x8000) ? (c << 1) ^ 0x1021 : c << 1;
  }
  return c;
}

// COBS encode. out needs len + len / 254 + 1 bytes. Returns encoded length
// without the trailing 0x00 delimiter.
inline size_t cobsEncode(const uint8_t *in, size_t len, uint8_t *out) {
  size_t read = 0, write = 1, codePos = 0;
  uint8_t code = 1;
  while (read < len) {
    if (in[read] == 0) {
      out[codePos] = code;
      code = 1;
      codePos = write++;
      read++;
    } else {
      out[write++] = in[read++];
      if (++code == 0xFF) {
        out[codePos] = code;
        code = 1;
        codePos = write++;
      }
    }
  }
  out[codePos] = code;
  return write;
}

// COBS decode. Returns decoded length, or 0 on malformed input.
inline size_t cobsDecode(const uint8_t *in, size_t len, uint8_t *out) {
  size_t read = 0, write = 0;
  while (read < len) {
    uint8_t code = in[read++];
    if (code == 0 || read + code - 1 > len) return 0;
    for (uint8_t i = 1; i < code; i++) out[write++] = in[read++];
    if (code < 0xFF && read < len) out[write++] = 0;
  }
  return write;
}

}  // namespace ml
