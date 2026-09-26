// MeshLink node firmware for ESP8266.
//
// Radio side: ESP-NOW broadcast flood. Each node relays frames it has not
// seen before until the TTL reaches 0. Nodes need no configuration.
//
// Host side (optional): the Windows app on the USB serial port sends and
// receives COBS-framed packets. A node with no host is a plain relay.
// The node never sees plaintext: the app encrypts before sending.
#include <ESP8266WiFi.h>
#include <espnow.h>

#include "protocol.h"

using namespace ml;

static uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static uint32_t chipId;

// ---- Dedupe ---------------------------------------------------------------

const uint8_t SEEN_SIZE = 64;
static uint32_t seen[SEEN_SIZE];
static uint8_t seenPos = 0;

// True if msgId was already handled. Otherwise remember it. Stops relay loops.
// msgId 0 is never generated, so the zero-filled array gives no false hits.
static bool isDuplicate(uint32_t msgId) {
  for (uint8_t i = 0; i < SEEN_SIZE; i++) {
    if (seen[i] == msgId) return true;
  }
  seen[seenPos] = msgId;
  seenPos = (seenPos + 1) % SEEN_SIZE;
  return false;
}

static uint32_t newMsgId() {
  uint32_t id;
  do {
    id = ESP.random();
  } while (id == 0);
  return id;
}

// ---- Host link --------------------------------------------------------------

// frame must have 2 spare bytes after len for the CRC.
static void hostWrite(uint8_t *frame, size_t len) {
  uint16_t crc = crc16(frame, len);
  frame[len++] = crc & 0xFF;
  frame[len++] = crc >> 8;
  uint8_t enc[MAX_AIR + 32];
  size_t n = cobsEncode(frame, len, enc);
  Serial.write(enc, n);
  Serial.write((uint8_t)0);
}

static void hostLog(const char *text) {
  uint8_t f[96];
  size_t n = strnlen(text, sizeof(f) - 3);
  f[0] = H_LOG;
  memcpy(f + 1, text, n);
  hostWrite(f, n + 1);
}

static void hostInfo() {
  uint8_t f[16];
  f[0] = H_INFO;
  f[1] = VERSION;
  memcpy(f + 2, &chipId, 4);
  WiFi.macAddress(f + 6);
  f[12] = CHANNEL;
  hostWrite(f, 13);
}

// ---- Radio ------------------------------------------------------------------

static uint32_t airSend(uint8_t type, const uint8_t *body, size_t len, uint8_t ttl) {
  uint8_t f[MAX_AIR];
  AirHeader h = {MAGIC, VERSION, type, ttl, newMsgId(), chipId};
  memcpy(f, &h, AIR_HDR);
  if (len) memcpy(f + AIR_HDR, body, len);
  isDuplicate(h.msgId);  // Ignore our own frame when a neighbor relays it.
  esp_now_send(BROADCAST, f, AIR_HDR + len);
  return h.msgId;
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

static void onRecv(uint8_t *mac, uint8_t *data, uint8_t len) {
  uint8_t next = (rxHead + 1) % RXQ;
  if (next == rxTail || len > MAX_AIR) {
    rxDropped++;
    return;
  }
  rxq[rxHead].len = len;
  memcpy(rxq[rxHead].data, data, len);
  rxHead = next;
}

static void handleAir(uint8_t *data, uint8_t len) {
  if (len < AIR_HDR) return;
  AirHeader h;
  memcpy(&h, data, AIR_HDR);
  if (h.magic != MAGIC || h.version != VERSION) return;
  if (isDuplicate(h.msgId)) return;

  uint8_t f[MAX_AIR + 16];
  size_t bodyLen = len - AIR_HDR;
  f[0] = H_RECV;
  f[1] = h.type;
  f[2] = h.ttl;
  memcpy(f + 3, &h.origin, 4);
  memcpy(f + 7, &h.msgId, 4);
  memcpy(f + 11, data + AIR_HDR, bodyLen);
  hostWrite(f, 11 + bodyLen);

  if (h.ttl > 0) {
    data[offsetof(AirHeader, ttl)] = h.ttl - 1;
    esp_now_send(BROADCAST, data, len);
  }
}

// ---- Host input -------------------------------------------------------------

static uint8_t inBuf[MAX_AIR + 32];
static size_t inLen = 0;
static bool inOverflow = false;

static void handleHostFrame() {
  uint8_t f[sizeof(inBuf)];
  size_t n = cobsDecode(inBuf, inLen, f);
  if (n < 3) return;
  uint16_t crc = f[n - 2] | (f[n - 1] << 8);
  n -= 2;
  if (crc16(f, n) != crc) {
    hostLog("bad crc");
    return;
  }
  switch (f[0]) {
    case H_SEND: {
      if (n < 2 || n - 2 > MAX_BODY) {
        hostLog("bad send length");
        return;
      }
      uint32_t id = airSend(f[1], f + 2, n - 2, DEFAULT_TTL);
      uint8_t r[8] = {H_SENT};
      memcpy(r + 1, &id, 4);
      hostWrite(r, 5);
      break;
    }
    case H_INFO_REQ:
      hostInfo();
      break;
    default:
      hostLog("unknown host frame");
  }
}

static void pollHost() {
  while (Serial.available()) {
    uint8_t c = Serial.read();
    if (c == 0) {
      if (!inOverflow && inLen > 0) handleHostFrame();
      inLen = 0;
      inOverflow = false;
    } else if (inLen < sizeof(inBuf)) {
      inBuf[inLen++] = c;
    } else {
      inOverflow = true;
    }
  }
}

// ---- Main -------------------------------------------------------------------

void setup() {
  Serial.setRxBufferSize(1024);
  Serial.begin(115200);
  chipId = ESP.getChipId();

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  wifi_set_channel(CHANNEL);

  if (esp_now_init() != 0) {
    delay(1000);
    ESP.restart();
  }
  esp_now_set_self_role(ESP_NOW_ROLE_COMBO);
  esp_now_add_peer(BROADCAST, ESP_NOW_ROLE_COMBO, CHANNEL, NULL, 0);
  esp_now_register_recv_cb(onRecv);

  hostInfo();
  hostLog("node ready");
}

void loop() {
  pollHost();

  while (rxTail != rxHead) {
    handleAir(rxq[rxTail].data, rxq[rxTail].len);
    rxTail = (rxTail + 1) % RXQ;
  }

  static uint32_t lastBeacon = 0;
  if (millis() - lastBeacon > 10000) {
    lastBeacon = millis();
    airSend(AIR_BEACON, nullptr, 0, 0);
  }

  static uint16_t reportedDrops = 0;
  if (rxDropped != reportedDrops) {
    reportedDrops = rxDropped;
    hostLog("rx queue full, frame dropped");
  }
}
