// Chip differences that do not need the radio stack: ids and random numbers.
// Shared by config.cpp and display.cpp, so it must not pull in Wi-Fi headers.
#pragma once
#include <Arduino.h>

#if defined(ESP8266)
static inline uint32_t halChipId() { return ESP.getChipId(); }
static inline uint32_t halRandom() { return ESP.random(); }
static inline const char *halChipName() { return "ESP8266"; }
#else
// Last four bytes of the factory MAC. ESP.getEfuseMac() holds mac[0] in the lowest byte.
static inline uint32_t halChipId() { return (uint32_t)(ESP.getEfuseMac() >> 16); }
static inline uint32_t halRandom() { return esp_random(); }
static inline const char *halChipName() { return ESP.getChipModel(); }
#endif
