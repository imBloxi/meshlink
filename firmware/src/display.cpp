#include "display.h"

#include <LittleFS.h>
#include <Wire.h>

#include "chip.h"

// ---- Build-time settings (override with -D in platformio.ini) -----------------

#ifndef ML_OLED
#define ML_OLED 1  // 0 compiles the display out
#endif
#ifndef ML_OLED_W
#define ML_OLED_W 128
#endif
#ifndef ML_OLED_H
#define ML_OLED_H 64  // 64 or 32
#endif
#ifndef ML_OLED_SDA
#define ML_OLED_SDA -1  // -1 = scan the usual pins for this chip
#endif
#ifndef ML_OLED_SCL
#define ML_OLED_SCL -1
#endif
#ifndef ML_OLED_ADDR
#define ML_OLED_ADDR 0  // 0 = try 0x3C, then 0x3D
#endif
#ifndef ML_OLED_RST
#define ML_OLED_RST -1  // reset pin of boards that wire one (Heltec)
#endif
#ifndef ML_OLED_PWR
#define ML_OLED_PWR -1  // pin that powers the panel (Heltec V3 "Vext"), -1 = none
#endif
#ifndef ML_OLED_PWR_ON
#define ML_OLED_PWR_ON LOW
#endif
#ifndef ML_OLED_SH1106
#define ML_OLED_SH1106 0  // 1 = default to the SH1106 driver (most 1.3" panels)
#endif
#ifndef ML_OLED_ROTATE
#define ML_OLED_ROTATE 0  // 1 = turn the picture 180 degrees
#endif
#ifndef ML_BTN_PIN
#define ML_BTN_PIN -1  // optional page button, active low
#endif

namespace ml {

#if !ML_OLED

const char *displayInit(const char *) { return "OLED disabled in this build"; }
void displayBootLine(const char *, const char *) {}
void displayBootDone(const DisplayStats &) {}
void displayNotify(const char *, const char *) {}
void displayBye(const char *) { delay(100); }
bool displayPresent() { return false; }
void displaySplash(const char *, const char *) {}
void displayFatal(const char *) {}
void displayPoll() {}
bool displayDue() { return false; }
void displayUpdate(const DisplayStats &) {}

#else

// ---- 5x7 font, ASCII 32..126, one byte per column, bit 0 = top row -------------

static const uint8_t FONT[95][5] PROGMEM = {
    {0x00, 0x00, 0x00, 0x00, 0x00}, {0x00, 0x00, 0x5F, 0x00, 0x00}, {0x00, 0x07, 0x00, 0x07, 0x00},
    {0x14, 0x7F, 0x14, 0x7F, 0x14}, {0x24, 0x2A, 0x7F, 0x2A, 0x12}, {0x23, 0x13, 0x08, 0x64, 0x62},
    {0x36, 0x49, 0x56, 0x20, 0x50}, {0x00, 0x05, 0x03, 0x00, 0x00}, {0x00, 0x1C, 0x22, 0x41, 0x00},
    {0x00, 0x41, 0x22, 0x1C, 0x00}, {0x14, 0x08, 0x3E, 0x08, 0x14}, {0x08, 0x08, 0x3E, 0x08, 0x08},
    {0x00, 0x50, 0x30, 0x00, 0x00}, {0x08, 0x08, 0x08, 0x08, 0x08}, {0x00, 0x60, 0x60, 0x00, 0x00},
    {0x20, 0x10, 0x08, 0x04, 0x02}, {0x3E, 0x51, 0x49, 0x45, 0x3E}, {0x00, 0x42, 0x7F, 0x40, 0x00},
    {0x42, 0x61, 0x51, 0x49, 0x46}, {0x21, 0x41, 0x45, 0x4B, 0x31}, {0x18, 0x14, 0x12, 0x7F, 0x10},
    {0x27, 0x45, 0x45, 0x45, 0x39}, {0x3C, 0x4A, 0x49, 0x49, 0x30}, {0x01, 0x71, 0x09, 0x05, 0x03},
    {0x36, 0x49, 0x49, 0x49, 0x36}, {0x06, 0x49, 0x49, 0x29, 0x1E}, {0x00, 0x36, 0x36, 0x00, 0x00},
    {0x00, 0x56, 0x36, 0x00, 0x00}, {0x08, 0x14, 0x22, 0x41, 0x00}, {0x14, 0x14, 0x14, 0x14, 0x14},
    {0x00, 0x41, 0x22, 0x14, 0x08}, {0x02, 0x01, 0x51, 0x09, 0x06}, {0x32, 0x49, 0x79, 0x41, 0x3E},
    {0x7E, 0x11, 0x11, 0x11, 0x7E}, {0x7F, 0x49, 0x49, 0x49, 0x36}, {0x3E, 0x41, 0x41, 0x41, 0x22},
    {0x7F, 0x41, 0x41, 0x22, 0x1C}, {0x7F, 0x49, 0x49, 0x49, 0x41}, {0x7F, 0x09, 0x09, 0x09, 0x01},
    {0x3E, 0x41, 0x49, 0x49, 0x7A}, {0x7F, 0x08, 0x08, 0x08, 0x7F}, {0x00, 0x41, 0x7F, 0x41, 0x00},
    {0x20, 0x40, 0x41, 0x3F, 0x01}, {0x7F, 0x08, 0x14, 0x22, 0x41}, {0x7F, 0x40, 0x40, 0x40, 0x40},
    {0x7F, 0x02, 0x0C, 0x02, 0x7F}, {0x7F, 0x04, 0x08, 0x10, 0x7F}, {0x3E, 0x41, 0x41, 0x41, 0x3E},
    {0x7F, 0x09, 0x09, 0x09, 0x06}, {0x3E, 0x41, 0x51, 0x21, 0x5E}, {0x7F, 0x09, 0x19, 0x29, 0x46},
    {0x46, 0x49, 0x49, 0x49, 0x31}, {0x01, 0x01, 0x7F, 0x01, 0x01}, {0x3F, 0x40, 0x40, 0x40, 0x3F},
    {0x1F, 0x20, 0x40, 0x20, 0x1F}, {0x3F, 0x40, 0x38, 0x40, 0x3F}, {0x63, 0x14, 0x08, 0x14, 0x63},
    {0x07, 0x08, 0x70, 0x08, 0x07}, {0x61, 0x51, 0x49, 0x45, 0x43}, {0x00, 0x7F, 0x41, 0x41, 0x00},
    {0x02, 0x04, 0x08, 0x10, 0x20}, {0x00, 0x41, 0x41, 0x7F, 0x00}, {0x04, 0x02, 0x01, 0x02, 0x04},
    {0x40, 0x40, 0x40, 0x40, 0x40}, {0x00, 0x01, 0x02, 0x04, 0x00}, {0x20, 0x54, 0x54, 0x54, 0x78},
    {0x7F, 0x48, 0x44, 0x44, 0x38}, {0x38, 0x44, 0x44, 0x44, 0x20}, {0x38, 0x44, 0x44, 0x48, 0x7F},
    {0x38, 0x54, 0x54, 0x54, 0x18}, {0x08, 0x7E, 0x09, 0x01, 0x02}, {0x0C, 0x52, 0x52, 0x52, 0x3E},
    {0x7F, 0x08, 0x04, 0x04, 0x78}, {0x00, 0x44, 0x7D, 0x40, 0x00}, {0x20, 0x40, 0x44, 0x3D, 0x00},
    {0x7F, 0x10, 0x28, 0x44, 0x00}, {0x00, 0x41, 0x7F, 0x40, 0x00}, {0x7C, 0x04, 0x18, 0x04, 0x78},
    {0x7C, 0x08, 0x04, 0x04, 0x78}, {0x38, 0x44, 0x44, 0x44, 0x38}, {0x7C, 0x14, 0x14, 0x14, 0x08},
    {0x08, 0x14, 0x14, 0x18, 0x7C}, {0x7C, 0x08, 0x04, 0x04, 0x08}, {0x48, 0x54, 0x54, 0x54, 0x20},
    {0x04, 0x3F, 0x44, 0x40, 0x20}, {0x3C, 0x40, 0x40, 0x20, 0x7C}, {0x1C, 0x20, 0x40, 0x20, 0x1C},
    {0x3C, 0x40, 0x30, 0x40, 0x3C}, {0x44, 0x28, 0x10, 0x28, 0x44}, {0x0C, 0x50, 0x50, 0x50, 0x3C},
    {0x44, 0x64, 0x54, 0x4C, 0x44}, {0x00, 0x08, 0x36, 0x41, 0x00}, {0x00, 0x00, 0x7F, 0x00, 0x00},
    {0x00, 0x41, 0x36, 0x08, 0x00}, {0x08, 0x04, 0x08, 0x10, 0x08},
};

// ---- Panel state ----------------------------------------------------------------

static const uint8_t PAGES = ML_OLED_H / 8;  // 8-pixel rows
static const uint8_t ROWS = PAGES;           // text lines at scale 1
static const char *OLED_PATH = "/oled.bin";  // 1 byte: 0 = SSD1306, 1 = SH1106

static uint8_t *fb = nullptr;  // PAGES * ML_OLED_W bytes, bit 0 = top pixel of the page
static bool present = false;
static bool sh1106 = ML_OLED_SH1106;
static bool wireStarted = false;
static uint8_t addr = 0;
static int8_t sdaPin = -1, sclPin = -1;
static uint8_t failures = 0;
static uint32_t retryAt = 0;
static char info[64] = "OLED not started";

struct PinPair {
  int8_t sda, scl;
};

// Where the usual boards wire their OLED. Both orders are tried because some
// clone boards swap the pair.
static const PinPair CANDIDATES[] = {
#if defined(ESP8266)
    {4, 5}, {5, 4}, {14, 12}, {12, 14},
#elif defined(CONFIG_IDF_TARGET_ESP32S3) || defined(CONFIG_IDF_TARGET_ESP32C3)
    {8, 9}, {9, 8},
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
    {6, 7}, {7, 6}, {23, 22},
#else
    {21, 22}, {22, 21},
#endif
};

static bool wireBegin(int8_t sda, int8_t scl) {
#if !defined(ESP8266)
  if (wireStarted) Wire.end();
#endif
  Wire.begin(sda, scl);
  Wire.setClock(400000);
  wireStarted = true;
  return true;
}

static bool ping(uint8_t a) {
  Wire.beginTransmission(a);
  return Wire.endTransmission() == 0;
}

// Send command bytes. Wire buffers are 128 bytes on every chip; stay far below.
static bool sendCmds(const uint8_t *c, size_t n) {
  while (n) {
    size_t k = n > 16 ? 16 : n;
    Wire.beginTransmission(addr);
    Wire.write((uint8_t)0x00);
    Wire.write(c, k);
    if (Wire.endTransmission() != 0) return false;
    c += k;
    n -= k;
  }
  return true;
}

static bool panelInit() {
  static const uint8_t ssd[] = {0xAE, 0xD5, 0x80, 0xA8, (uint8_t)(ML_OLED_H - 1), 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x02};
  static const uint8_t sh[] = {0xAE, 0xD5, 0x80, 0xA8, (uint8_t)(ML_OLED_H - 1), 0xD3, 0x00, 0x40, 0xAD, 0x8B, 0x20, 0x02};
  bool ok = sh1106 ? sendCmds(sh, sizeof(sh)) : sendCmds(ssd, sizeof(ssd));
  const uint8_t tail[] = {
      (uint8_t)(ML_OLED_ROTATE ? 0xA0 : 0xA1),
      (uint8_t)(ML_OLED_ROTATE ? 0xC0 : 0xC8),
      0xDA, (uint8_t)(ML_OLED_H == 32 ? 0x02 : 0x12),
      0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF,
  };
  return ok && sendCmds(tail, sizeof(tail));
}

// Write the whole frame buffer. Page addressing works on both chips; the
// SH1106 RAM is 132 columns wide and the visible part starts at column 2.
static bool flush() {
  if (!present || !fb) return false;
  uint8_t colOff = sh1106 ? 2 : 0;
  for (uint8_t p = 0; p < PAGES; p++) {
    const uint8_t setPos[] = {(uint8_t)(0xB0 | p), (uint8_t)(colOff & 0x0F), (uint8_t)(0x10 | (colOff >> 4))};
    if (!sendCmds(setPos, sizeof(setPos))) return false;
    for (uint8_t x = 0; x < ML_OLED_W; x += 16) {
      Wire.beginTransmission(addr);
      Wire.write((uint8_t)0x40);
      Wire.write(fb + (size_t)p * ML_OLED_W + x, 16);
      if (Wire.endTransmission() != 0) return false;
    }
  }
  return true;
}

// ---- Drawing --------------------------------------------------------------------

static void clearFb() {
  if (fb) memset(fb, 0, (size_t)PAGES * ML_OLED_W);
}

static void px(int x, int y, bool on) {
  if (!fb || x < 0 || y < 0 || x >= ML_OLED_W || y >= ML_OLED_H) return;
  uint8_t &b = fb[(y >> 3) * ML_OLED_W + x];
  if (on) b |= (uint8_t)(1 << (y & 7));
  else b &= (uint8_t) ~(1 << (y & 7));
}

static void fillRect(int x, int y, int w, int h, bool on) {
  for (int j = 0; j < h; j++)
    for (int i = 0; i < w; i++) px(x + i, y + j, on);
}

static void drawChar(int x, int y, char c, int scale, bool on) {
  if (c < 32 || c > 126) c = '?';
  for (int col = 0; col < 5; col++) {
    uint8_t bits = pgm_read_byte(&FONT[c - 32][col]);
    for (int row = 0; row < 7; row++) {
      if (bits & (1 << row)) fillRect(x + col * scale, y + row * scale, scale, scale, on);
    }
  }
}

static void drawText(int x, int y, const char *s, int scale, bool on) {
  for (; *s; s++, x += 6 * scale) drawChar(x, y, *s, scale, on);
}

// ---- Bring-up -------------------------------------------------------------------

static bool findPanel() {
  const uint8_t addrs[2] = {ML_OLED_ADDR ? (uint8_t)ML_OLED_ADDR : (uint8_t)0x3C, (uint8_t)0x3D};
  size_t tries = ML_OLED_ADDR ? 1 : 2;
  PinPair forced = {ML_OLED_SDA, ML_OLED_SCL};
  const PinPair *list = CANDIDATES;
  size_t count = sizeof(CANDIDATES) / sizeof(CANDIDATES[0]);
  if (forced.sda >= 0 && forced.scl >= 0) {
    list = &forced;
    count = 1;
  }
  for (size_t i = 0; i < count; i++) {
    wireBegin(list[i].sda, list[i].scl);
    for (size_t a = 0; a < tries; a++) {
      if (ping(addrs[a])) {
        sdaPin = list[i].sda;
        sclPin = list[i].scl;
        addr = addrs[a];
        return true;
      }
    }
  }
  return false;
}

static void powerAndReset() {
#if ML_OLED_PWR >= 0
  pinMode(ML_OLED_PWR, OUTPUT);
  digitalWrite(ML_OLED_PWR, ML_OLED_PWR_ON);
  delay(20);
#endif
#if ML_OLED_RST >= 0
  pinMode(ML_OLED_RST, OUTPUT);
  digitalWrite(ML_OLED_RST, HIGH);
  delay(5);
  digitalWrite(ML_OLED_RST, LOW);
  delay(20);
  digitalWrite(ML_OLED_RST, HIGH);
  delay(20);
#endif
}

static void describe() {
  snprintf(info, sizeof(info), "OLED %s %ux%u at 0x%02X, SDA %d SCL %d", sh1106 ? "SH1106" : "SSD1306", (unsigned)ML_OLED_W,
           (unsigned)ML_OLED_H, addr, sdaPin, sclPin);
}

static const char *probeInit() {
  File f = LittleFS.open(OLED_PATH, "r");
  if (f) {
    int v = f.read();
    if (v == 0 || v == 1) sh1106 = v == 1;
    f.close();
  }
  if (!fb) fb = (uint8_t *)malloc((size_t)PAGES * ML_OLED_W);
  if (!fb) {
    strcpy(info, "OLED: out of memory");
    return info;
  }
  powerAndReset();
  if (!findPanel()) {
    present = false;
    snprintf(info, sizeof(info), "No OLED found (SDA/SCL, 3.3V, GND?)");
    return info;
  }
  present = panelInit();
  if (!present) {
    strcpy(info, "OLED found but did not accept commands");
    return info;
  }
  describe();
  clearFb();
  flush();
  return info;
}

bool displayPresent() { return present; }

// ---- Drawing primitives ---------------------------------------------------------

static void line(int x0, int y0, int x1, int y1, bool on) {
  int dx = abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
  int dy = -abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
  int err = dx + dy;
  for (;;) {
    px(x0, y0, on);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// quadrants: bit 0 = upper right, 1 = upper left, 2 = lower left, 3 = lower right
static void ring(int cx, int cy, int r, bool on, uint8_t quadrants = 0x0F) {
  int x = r, y = 0, err = 1 - r;
  while (x >= y) {
    if (quadrants & 1) { px(cx + x, cy - y, on); px(cx + y, cy - x, on); }
    if (quadrants & 2) { px(cx - x, cy - y, on); px(cx - y, cy - x, on); }
    if (quadrants & 4) { px(cx - x, cy + y, on); px(cx - y, cy + x, on); }
    if (quadrants & 8) { px(cx + x, cy + y, on); px(cx + y, cy + x, on); }
    y++;
    if (err < 0) err += 2 * y + 1;
    else { x--; err += 2 * (y - x) + 1; }
  }
}

static void disc(int cx, int cy, int r, bool on) {
  for (int j = -r; j <= r; j++)
    for (int i = -r; i <= r; i++)
      if (i * i + j * j <= r * r) px(cx + i, cy + j, on);
}

static int textW(const char *s, int scale) { return (int)strlen(s) * 6 * scale; }

static void drawCentered(int y, const char *s, int scale, bool on) { drawText((ML_OLED_W - textW(s, scale)) / 2, y, s, scale, on); }

static void titleBar(const char *left, const char *right) {
  fillRect(0, 0, ML_OLED_W, 8, true);
  drawText(1, 0, left, 1, false);
  if (right) drawText(ML_OLED_W - 1 - textW(right, 1), 0, right, 1, false);
}

// ---- Boot sequence --------------------------------------------------------------

#ifndef ML_BOOT_STEP_MS
#define ML_BOOT_STEP_MS 260  // pause after each boot line; 0 = no pause
#endif
static const uint8_t BOOT_STEPS = 7;
static const uint8_t BOOT_LINES = ROWS > 2 ? ROWS - 2 : 1;
static char bootLog[6][24];
static uint8_t bootCount = 0, bootStep = 0;

static void bootLogo(const char *fw) {
  const int nx[4] = {22, 64, 106, 64}, ny[4] = {50, 36, 50, 56};
  for (int f = 0; f < 12; f++) {
    clearFb();
    drawCentered(ML_OLED_H >= 64 ? 2 : 0, "MeshLink", 2, true);
    if (ML_OLED_H >= 64) {
      int shown = f / 2 + 1;
      if (shown > 4) shown = 4;
      for (int i = 0; i < shown; i++) {
        if (i > 0) line(nx[i - 1], ny[i - 1], nx[i], ny[i], true);
        disc(nx[i], ny[i], 3, true);
      }
      if (f >= 3) ring(nx[1], ny[1], 5 + (f % 4) * 3, true, 0x03);  // radio waves from the middle node
      if (f >= 7) line(nx[3], ny[3], nx[0], ny[0], true);
      char v[24];
      snprintf(v, sizeof(v), "v%.10s", fw);
      drawCentered(ML_OLED_H - 8, v, 1, true);
    } else {
      for (int i = 0; i < f + 1 && i < 20; i++) fillRect(4 + i * 6, 22, 4, 4, true);
    }
    flush();
    delay(70);
  }
}

static void drawBoot() {
  clearFb();
  titleBar("BOOT", nullptr);
  for (uint8_t i = 0; i < bootCount; i++) drawText(0, 8 + i * 8, bootLog[i], 1, true);
  int barY = ML_OLED_H - 6;
  int barW = ML_OLED_W - 2;
  for (int x = 0; x < barW; x++) {  // outline
    px(1 + x, barY, true);
    px(1 + x, barY + 4, true);
  }
  px(1, barY + 1, true); px(1, barY + 2, true); px(1, barY + 3, true);
  px(barW, barY + 1, true); px(barW, barY + 2, true); px(barW, barY + 3, true);
  int fill = (barW - 4) * (bootStep > BOOT_STEPS ? BOOT_STEPS : bootStep) / BOOT_STEPS;
  fillRect(3, barY + 1, fill, 3, true);
}

void displayBootLine(const char *label, const char *result) {
  if (!present) return;
  if (bootCount == BOOT_LINES) {
    memmove(bootLog[0], bootLog[1], sizeof(bootLog[0]) * (BOOT_LINES - 1));
    bootCount--;
  }
  char *dst = bootLog[bootCount++];
  int width = 21, rl = (int)strlen(result), ll = (int)strlen(label);
  if (ll > width - rl - 2) ll = width - rl - 2;
  memset(dst, '.', width);
  memcpy(dst, label, ll);
  dst[ll] = ' ';
  dst[width - rl - 1] = ' ';
  memcpy(dst + width - rl, result, rl);
  dst[width] = 0;
  bootStep++;
  drawBoot();
  flush();
  delay(ML_BOOT_STEP_MS);
}

static void ipText(char *out, size_t cap, uint32_t ip) {
  if (!ip) snprintf(out, cap, "-");
  else snprintf(out, cap, "%u.%u.%u.%u", (unsigned)(ip & 0xFF), (unsigned)((ip >> 8) & 0xFF), (unsigned)((ip >> 16) & 0xFF), (unsigned)(ip >> 24));
}

void displayBootDone(const DisplayStats &s) {
  if (!present) return;
  bootStep = BOOT_STEPS;
  drawBoot();
  flush();
  delay(ML_BOOT_STEP_MS);

  char ip[20];
  clearFb();
  titleBar("SYSTEM", "1/2");
  char l[24];
  drawText(0, 8, s.nodeName, 1, true);
  snprintf(l, sizeof(l), "%.12s %luMB", s.chip, (unsigned long)(s.flashKB / 1024));
  drawText(0, 16, l, 1, true);
  snprintf(l, sizeof(l), "FW %.8s  Ch %u", s.fw, (unsigned)s.channel);
  drawText(0, 24, l, 1, true);
  snprintf(l, sizeof(l), "ID %08lX", (unsigned long)s.chipId);
  drawText(0, 32, l, 1, true);
  snprintf(l, sizeof(l), "Heap %luK free", (unsigned long)(s.heap / 1024));
  drawText(0, 40, l, 1, true);
  flush();
  delay(ML_BOOT_STEP_MS ? 1800 : 0);

  clearFb();
  titleBar("NETWORK", "2/2");
  snprintf(l, sizeof(l), "Net %.17s", s.netName);
  drawText(0, 8, l, 1, true);
  snprintf(l, sizeof(l), "AP %.18s", s.apUp ? s.apSsid : "off");
  drawText(0, 16, l, 1, true);
  ipText(ip, sizeof(ip), s.apIp);
  snprintf(l, sizeof(l), "IP %s", ip);
  if (s.apUp) drawText(0, 24, l, 1, true);
  drawText(0, 32, s.staState == 2 ? "Home Wi-Fi: up" : s.staState == 1 ? "Home Wi-Fi: joining" : "Home Wi-Fi: off", 1, true);
  drawText(0, 40, "Listening for nodes...", 1, true);
  flush();
  delay(ML_BOOT_STEP_MS ? 1800 : 0);
}

const char *displayInit(const char *fw) {
  const char *msg = probeInit();
  if (present) bootLogo(fw);
  return msg;
}

// ---- Screens --------------------------------------------------------------------

void displaySplash(const char *line1, const char *line2) {
  if (!present) return;
  clearFb();
  drawText(0, 0, "MeshLink", 2, true);
  int y = ML_OLED_H >= 64 ? 26 : 18;
  if (line1) drawText(0, y, line1, 1, true);
  if (line2) drawText(0, y + 10, line2, 1, true);
  flush();
}

void displayBye(const char *message) {
  if (!present) {
    delay(100);
    return;
  }
  clearFb();
  titleBar("MeshLink", nullptr);
  drawCentered(ML_OLED_H >= 64 ? 28 : 14, message, 1, true);
  flush();
  delay(900);
}

void displayFatal(const char *message) {
  if (!present) return;
  clearFb();
  titleBar("NODE ERROR", nullptr);
  drawText(0, 12, message, 1, true);
  if (ML_OLED_H >= 64) {  // a sad face
    ring(20, 46, 10, true);
    fillRect(16, 42, 2, 3, true);
    fillRect(23, 42, 2, 3, true);
    ring(20, 54, 4, true, 0x03);
  }
  flush();
}

// ---- Notifications ----------------------------------------------------------------

struct Toast {
  char title[22], detail[22];
};
static Toast toasts[4];
static uint8_t toastHead = 0, toastCount = 0;
static uint32_t toastSince = 0, toastSerial = 0;

void displayNotify(const char *title, const char *detail) {
  if (!present || toastCount == 4) return;
  Toast &t = toasts[(toastHead + toastCount) % 4];
  snprintf(t.title, sizeof(t.title), "%s", title);
  snprintf(t.detail, sizeof(t.detail), "%s", detail ? detail : "");
  if (toastCount++ == 0) toastSince = millis();
  toastSerial++;
}

static void drawToast() {
  if (!toastCount) return;
  const Toast &t = toasts[toastHead];
  if (ML_OLED_H >= 64) {
    int y = ML_OLED_H - 23;
    fillRect(2, y, ML_OLED_W - 4, 22, false);
    for (int x = 2; x < ML_OLED_W - 2; x++) { px(x, y, true); px(x, y + 21, true); }
    for (int j = 0; j < 22; j++) { px(2, y + j, true); px(ML_OLED_W - 3, y + j, true); }
    fillRect(4, y + 2, 5, 5, true);  // bell-ish marker
    drawText(12, y + 2, t.title, 1, true);
    drawText(6, y + 12, t.detail, 1, true);
  } else {
    int y = ML_OLED_H - 11;
    fillRect(0, y, ML_OLED_W, 11, true);
    char l[24];
    snprintf(l, sizeof(l), "%.8s %.12s", t.title, t.detail);
    drawText(2, y + 2, l, 1, false);
  }
}

// ---- Pages ------------------------------------------------------------------------

static const uint8_t NUM_PAGES = 6;  // 0..2 text, 3..5 graphics
static uint8_t page = 0;
static uint32_t pageSince = 0, autoHoldUntil = 0, lastDraw = 0, lastRxAt = 0;
static uint32_t lastRx = 0, lastHash = 0, lastDropSum = 0, lastDropAt = 0;
static bool hasHash = false;
static uint8_t hist[64];  // frames received per 2 s, oldest first
static uint32_t histAt = 0;
static uint32_t histRx = 0;

#if ML_BTN_PIN >= 0
static bool btnDown = false, btnLongDone = false;
static uint32_t btnSince = 0;
#endif

typedef char Line[32];

static void buildPage(uint8_t pg, const DisplayStats &s, Line *L) {
  char a[20], b[20];
  const char *titles[3] = {s.nodeName, "Wi-Fi", "Radio"};
  snprintf(L[0], sizeof(Line), "%-16.16s %u/%u", titles[pg], (unsigned)(pg + 1), (unsigned)NUM_PAGES);
  if (pg == 0) {
    snprintf(L[1], sizeof(Line), "Net %.17s", s.netName);
    snprintf(L[2], sizeof(Line), "Ch %u   FW %.10s", (unsigned)s.channel, s.fw);
    snprintf(L[3], sizeof(Line), "RX %lu Rly %lu", (unsigned long)s.rx, (unsigned long)s.relayed);
    snprintf(L[4], sizeof(Line), "Guests %u  Heap %luK", (unsigned)s.guests, (unsigned long)(s.heap / 1024));
    snprintf(L[5], sizeof(Line), "Up %02lu:%02lu:%02lu", (unsigned long)(s.uptimeS / 3600), (unsigned long)(s.uptimeS / 60 % 60), (unsigned long)(s.uptimeS % 60));
    snprintf(L[6], sizeof(Line), "Nodes in range: %u", (unsigned)s.peers);
  } else if (pg == 1) {
    if (s.apUp) {
      snprintf(L[1], sizeof(Line), "AP %.18s", s.apSsid);
      ipText(a, sizeof(a), s.apIp);
      snprintf(L[2], sizeof(Line), "IP %s", a);
    } else {
      snprintf(L[1], sizeof(Line), "AP off");
    }
    if (s.staState == 2) {
      ipText(b, sizeof(b), s.staIp);
      snprintf(L[3], sizeof(Line), "STA %s", b);
    } else {
      snprintf(L[3], sizeof(Line), "STA %s", s.staState == 1 ? "connecting" : "off");
    }
    snprintf(L[4], sizeof(Line), "Guests %u", (unsigned)s.guests);
  } else {
    snprintf(L[1], sizeof(Line), "%.20s", s.chip);
    snprintf(L[2], sizeof(Line), "ID %08lX", (unsigned long)s.chipId);
    snprintf(L[3], sizeof(Line), "Bad tag %lu", (unsigned long)s.dropTag);
    snprintf(L[4], sizeof(Line), "Rate drop %lu", (unsigned long)s.dropRate);
    snprintf(L[5], sizeof(Line), "Rx queue drop %u", (unsigned)s.rxQueueDrops);
  }
}

// Page 3: frames per 2 seconds over the last two minutes.
static void pageActivity(const DisplayStats &s) {
  titleBar("Activity", "4/6");
  int top = 10, h = ML_OLED_H - top - (ML_OLED_H >= 64 ? 11 : 1);
  uint8_t mx = 4;
  for (uint8_t v : hist) if (v > mx) mx = v;
  for (int i = 0; i < 64; i++) {
    int bh = hist[i] * h / mx;
    if (hist[i] && !bh) bh = 1;
    fillRect(i * 2, top + h - bh, 2, bh, true);
  }
  for (int x = 0; x < ML_OLED_W; x += 4) px(x, top + h, true);  // baseline
  if (ML_OLED_H >= 64) {
    char l[24];
    snprintf(l, sizeof(l), "%u/s now  peak %u", (unsigned)(hist[62] / 2), (unsigned)(mx / 2));
    drawText(0, ML_OLED_H - 8, l, 1, true);
  }
}

// Page 4: this node in the middle, heard nodes on an orbit.
static void pageMesh(const DisplayStats &s, uint32_t now) {
  titleBar("Mesh", "5/6");
  int cy = 8 + (ML_OLED_H - 8) / 2, cx = 34;
  int R = (ML_OLED_H - 8) / 2 - 3;
  ring(cx, cy, R, true, 0x0F);
  disc(cx, cy, 3, true);
  ring(cx, cy, 6 + (int)((now / 250) % 3) * 2, true, 0x03);  // pulse
  int n = s.peers > 8 ? 8 : s.peers;
  float phase = (now % 12000) / 12000.0f * 6.2832f;
  for (int i = 0; i < n; i++) {
    float a = phase + i * 6.2832f / n;
    int x = cx + (int)(cosf(a) * R), y = cy + (int)(sinf(a) * R);
    line(cx, cy, x, y, true);
    disc(x, y, 2, true);
  }
  char l[24];
  drawText(72, 12, "Nodes", 1, true);
  snprintf(l, sizeof(l), "%u heard", (unsigned)s.peers);
  drawText(72, 22, l, 1, true);
  if (ML_OLED_H >= 64) {
    snprintf(l, sizeof(l), "%lu relayed", (unsigned long)s.relayed);
    drawText(72, 36, l, 1, true);
    drawText(72, 46, s.peers ? "Mesh alive" : "Alone...", 1, true);
  }
}

// Page 5: a little buddy whose mood follows the radio.
static void pageBuddy(const DisplayStats &s, uint32_t now) {
  titleBar("Buddy", "6/6");
  enum { SLEEPY, CHILL, HAPPY, ALARM } mood;
  if (now - lastDropAt < 10000 && lastDropAt) mood = ALARM;
  else if (now - lastRxAt < 10000 && lastRxAt) mood = HAPPY;
  else if (s.peers) mood = CHILL;
  else mood = SLEEPY;

  int cx = 34, cy = 8 + (ML_OLED_H - 8) / 2, r = (ML_OLED_H - 8) / 2 - 2;
  ring(cx, cy, r, true);
  bool blink = (now % 4000) < 160;
  int ex = r / 3, ey = cy - r / 4, eh = r / 4 + 1;
  if (mood == SLEEPY || blink) {
    line(cx - ex - 2, ey, cx - ex + 2, ey, true);
    line(cx + ex - 2, ey, cx + ex + 2, ey, true);
  } else if (mood == ALARM) {
    disc(cx - ex, ey, eh, true);
    disc(cx + ex, ey, eh, true);
  } else {
    fillRect(cx - ex - 1, ey - eh / 2, 3, eh, true);
    fillRect(cx + ex - 1, ey - eh / 2, 3, eh, true);
  }
  int my = cy + r / 3, mw = r / 2 < 3 ? 3 : r / 2;
  if (mood == HAPPY) {
    for (int dx = -mw; dx <= mw; dx++) px(cx + dx, my + ((mw * mw - dx * dx) * (mw / 2 + 1)) / (mw * mw), true);
  } else if (mood == CHILL) {
    for (int dx = -mw / 2; dx <= mw / 2; dx++) px(cx + dx, my + 1, true);
  } else if (mood == ALARM) {
    ring(cx, my + 1, mw / 2 + 1, true);
  } else {
    for (int dx = -mw / 2; dx <= mw / 2; dx++) px(cx + dx, my + 1, true);
    drawText(cx + r + 2, cy - r, (now / 700) % 2 ? "Z" : "z", 1, true);
  }
  const char *word = mood == HAPPY ? "Happy" : mood == ALARM ? "Alert!" : mood == CHILL ? "Chill" : "Sleepy";
  drawText(80, 14, word, 1, true);
  char l[24];
  snprintf(l, sizeof(l), "%u nodes", (unsigned)s.peers);
  drawText(80, 26, l, 1, true);
  if (ML_OLED_H >= 64) {
    snprintf(l, sizeof(l), "%lu msgs", (unsigned long)s.rx);
    drawText(80, 38, l, 1, true);
  }
}

bool displayDue() { return present && millis() - lastDraw >= 250; }

void displayUpdate(const DisplayStats &s) {
  if (!present) return;
  uint32_t now = millis();
  lastDraw = now;
  if (!histAt) histAt = now;

  // Activity bookkeeping.
  if (s.rx != lastRx) {
    histRx += s.rx - lastRx;
    lastRx = s.rx;
    lastRxAt = now;
  }
  uint32_t dropSum = s.dropTag + s.dropRate + s.rxQueueDrops;
  if (dropSum != lastDropSum) {
    lastDropSum = dropSum;
    lastDropAt = now;
  }
  while (now - histAt >= 2000) {
    histAt += 2000;
    memmove(hist, hist + 1, sizeof(hist) - 1);
    hist[63] = histRx > 255 ? 255 : histRx;
    histRx = 0;
  }
  bool blink = now - lastRxAt < 400 && lastRxAt != 0;

  if (toastCount && now - toastSince > 3000) {
    toastHead = (toastHead + 1) % 4;
    toastCount--;
    toastSince = now;
    hasHash = false;
  }
  if (now >= autoHoldUntil && now - pageSince > (page >= 3 ? 5000 : 4000)) {
    page = (page + 1) % NUM_PAGES;
    pageSince = now;
  }

  Line L[8];
  memset(L, 0, sizeof(L));
  uint32_t h = 2166136261u ^ page ^ (blink ? 0x80 : 0) ^ (toastCount ? toastSerial * 7 + 1 : 0);
  if (page < 3) {
    buildPage(page, s, L);
    for (uint8_t r = 0; r < ROWS; r++)
      for (const char *c = L[r]; *c; c++) h = (h ^ (uint8_t)*c) * 16777619u;
  } else {
    h = (h ^ (now / 250)) * 16777619u;  // animated pages redraw every tick
  }
  // Redraw (and block ~30 ms on I2C) only when something visible changed.
  if (hasHash && h == lastHash) return;
  hasHash = true;
  lastHash = h;

  clearFb();
  if (page < 3) {
    titleBar(L[0], nullptr);
    if (blink) fillRect(ML_OLED_W - 6, 2, 4, 4, false);
    for (uint8_t r = 1; r < ROWS; r++) drawText(0, r * 8, L[r], 1, true);
  } else if (page == 3) {
    pageActivity(s);
  } else if (page == 4) {
    pageMesh(s, now);
  } else {
    pageBuddy(s, now);
  }
  drawToast();

  if (flush()) {
    failures = 0;
  } else if (++failures >= 3) {
    present = false;  // unplugged or brown-out: displayPoll() retries
    retryAt = now + 5000;
  }
}

#if ML_BTN_PIN >= 0
static void toggleDriver() {
  sh1106 = !sh1106;
  File f = LittleFS.open(OLED_PATH, "w");
  if (f) {
    f.write((uint8_t)(sh1106 ? 1 : 0));
    f.close();
  }
  present = panelInit();
  describe();
  hasHash = false;
  if (present) {
    displaySplash(sh1106 ? "Driver: SH1106" : "Driver: SSD1306", "Saved.");
    delay(1200);
  }
}
#endif

void displayPoll() {
  uint32_t now = millis();
  if (!present && fb && retryAt && (int32_t)(now - retryAt) >= 0) {
    retryAt = now + 5000;
    powerAndReset();
    wireBegin(sdaPin, sclPin);
    if (ping(addr) && panelInit()) {
      present = true;
      failures = 0;
      hasHash = false;
    }
  }
#if ML_BTN_PIN >= 0
  static bool btnInit = false;
  if (!btnInit) {
    pinMode(ML_BTN_PIN, INPUT_PULLUP);
    btnInit = true;
  }
  bool down = digitalRead(ML_BTN_PIN) == LOW;
  if (down && !btnDown) {
    btnDown = true;
    btnLongDone = false;
    btnSince = now;
  } else if (down && btnDown && !btnLongDone && now - btnSince > 1500) {
    btnLongDone = true;  // Long press: the picture looks shifted, try the other chip.
    if (present) toggleDriver();
  } else if (!down && btnDown) {
    btnDown = false;
    if (!btnLongDone && now - btnSince > 30 && present) {
      page = (page + 1) % NUM_PAGES;
      pageSince = now;
      autoHoldUntil = now + 20000;
      hasHash = false;
    }
  }
#endif
}

#endif  // ML_OLED

}  // namespace ml
