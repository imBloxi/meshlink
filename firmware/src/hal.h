// Radio and network stack differences between the ESP8266 and the ESP32
// family (ESP32, S3, C3, C6). main.cpp includes only this file, so the chip
// ifdefs stay in one place.
//
// ESP-NOW frames are the same on every chip (vendor action frames, up to 250
// bytes), so an ESP8266 and an ESP32 on the same channel hear each other.
#pragma once
#include "chip.h"

#if defined(ESP8266)
#include <ESP8266WebServer.h>
#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <espnow.h>
typedef ESP8266WebServer MlWebServer;
#else
#include <ESPmDNS.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <esp_now.h>
#if __has_include(<esp_arduino_version.h>)
#include <esp_arduino_version.h>
#endif
typedef WebServer MlWebServer;
#endif

typedef void (*MlRecvCb)(const uint8_t *data, uint8_t len);

static uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
static MlRecvCb recvCb = nullptr;

// ESP-NOW receive callbacks run in the Wi-Fi task, never in an interrupt.
#if defined(ESP8266)
static void nowRecv(uint8_t *mac, uint8_t *data, uint8_t len) {
  if (recvCb) recvCb(data, len);
}
#elif defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
static void nowRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (recvCb && len > 0 && len <= 255) recvCb(data, (uint8_t)len);
}
#else
static void nowRecv(const uint8_t *mac, const uint8_t *data, int len) {
  if (recvCb && len > 0 && len <= 255) recvCb(data, (uint8_t)len);
}
#endif

// Call after WiFi.mode(). Returns false if the radio stack refuses to start.
static bool halNowBegin(uint8_t channel, MlRecvCb cb) {
  recvCb = cb;
#if defined(ESP8266)
  if (esp_now_init() != 0) return false;
  esp_now_set_self_role(ESP_NOW_ROLE_COMBO);
  esp_now_add_peer(BROADCAST, ESP_NOW_ROLE_COMBO, channel, NULL, 0);
  esp_now_register_recv_cb(nowRecv);
#else
  if (esp_now_init() != ESP_OK) return false;
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BROADCAST, 6);
  peer.channel = 0;  // 0 = whatever channel the radio is on (follows a router)
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) return false;
  esp_now_register_recv_cb(nowRecv);
#endif
  return true;
}

static inline void halNowSend(const uint8_t *data, uint8_t len) {
  esp_now_send(BROADCAST, (uint8_t *)data, len);
}

static inline void halSetChannel(uint8_t channel) {
#if defined(ESP8266)
  wifi_set_channel(channel);
#else
  esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE);
#endif
}

static inline void halMdnsUpdate() {
#if defined(ESP8266)
  MDNS.update();  // The ESP32 mDNS responder runs in its own task.
#endif
}
