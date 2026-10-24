// Status screen on a small I2C OLED (SSD1306 or SH1106, 128x64 or 128x32).
//
// The panel is optional: with nothing wired, displayInit() finds no panel and
// every other call does nothing. Pins, address and driver can be forced with
// build flags (see platformio.ini), otherwise the firmware scans for them.
//
// What it shows: an animated boot sequence, six rotating pages (node, Wi-Fi,
// radio, activity graph, mesh map, mascot) and pop-up notifications.
#pragma once
#include <Arduino.h>

namespace ml {

struct DisplayStats {
  const char *nodeName;
  const char *netName;
  const char *apSsid;
  const char *fw;
  const char *chip;
  uint32_t chipId;
  uint32_t flashKB;
  uint32_t uptimeS, heap;
  uint32_t rx, relayed, dropTag, dropRate;
  uint32_t apIp, staIp;  // first octet in the low byte; 0 = none
  uint16_t rxQueueDrops;
  uint8_t channel, guests;
  uint8_t peers;  // distinct nodes heard in the last minute
  bool apUp;
  uint8_t staState;  // 0 off, 1 connecting, 2 connected
};

// Probe the bus, start the panel and play the logo animation. Returns a
// one-line description for the USB log: what was found and on which pins, or
// why nothing was found.
const char *displayInit(const char *fw);
bool displayPresent();

// Boot console: one line per start-up step with a progress bar. result is
// "OK", "FAIL", "off" or any short word.
void displayBootLine(const char *label, const char *result);
// Two info screens after the last boot line.
void displayBootDone(const DisplayStats &stats);

// Full-screen message. Drawn at once (blocks for one screen refresh).
void displaySplash(const char *line1, const char *line2 = nullptr);
void displayFatal(const char *message);

// Last screen before a restart. Waits long enough to read it (100 ms with no panel).
void displayBye(const char *message);

// Pop-up for about 3 seconds. Up to 4 wait in a queue; extra ones are dropped.
void displayNotify(const char *title, const char *detail = nullptr);

// Cheap; call every loop(). Handles the page button and panel recovery.
void displayPoll();
// True when displayUpdate() should run (a few times per second at most).
bool displayDue();
void displayUpdate(const DisplayStats &stats);

}  // namespace ml
