// MeshLink wire protocol constants. Keep in sync with app/meshlink/protocol.py
// and PROTOCOL.md.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace ml {

const uint8_t MAGIC = 0x4D;  // ASCII M
const uint8_t VERSION = 1;
const uint8_t CHANNEL = 6;
const uint8_t DEFAULT_TTL = 3;
const uint8_t MAX_AIR = 250;  // ESP-NOW payload limit.

// Air frame types.
enum AirType : uint8_t {
  AIR_BEACON = 0x01,    // Node presence, not relayed.
  AIR_DATA = 0x02,      // Encrypted app message.
  AIR_ANNOUNCE = 0x03,  // App identity: public key + display name.
};

// Every radio frame starts with this header. All integers little-endian.
struct __attribute__((packed)) AirHeader {
  uint8_t magic;
  uint8_t version;
  uint8_t type;
  uint8_t ttl;
  uint32_t msgId;   // Random, used for dedupe.
  uint32_t origin;  // Chip id of the node that first sent the frame.
};
const uint8_t AIR_HDR = sizeof(AirHeader);
const uint8_t MAX_BODY = MAX_AIR - AIR_HDR;

// Host (USB serial) frames: COBS([type][payload...][crc16 LE]) + 0x00.
enum HostType : uint8_t {
  H_SEND = 0x10,      // host->node: [airType][body]
  H_INFO_REQ = 0x11,  // host->node: (empty)
  H_RECV = 0x20,      // node->host: [airType][ttl][origin 4][msgId 4][body]
  H_INFO = 0x21,      // node->host: [version][chipId 4][mac 6][channel]
  H_LOG = 0x22,       // node->host: UTF-8 text
  H_SENT = 0x23,      // node->host: [msgId 4]
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
