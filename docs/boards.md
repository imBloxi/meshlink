# Supported boards and the OLED screen

One firmware source builds for the ESP8266 and the ESP32 family. All chips send
the same ESP-NOW frames, so mixed meshes work: an ESP8266 and an ESP32 on the
same Wi-Fi channel hear each other, relay for each other and share one network
key.

## Boards

| Environment | Board | Notes |
|---|---|---|
| `d1_mini` | Wemos/Lolin D1 mini and clones | The image the desktop app flashes. Runs on any 4 MB ESP8266 board. |
| `nodemcuv2` | NodeMCU v2/v3 | FLASH button (GPIO0) pages through the screens. |
| `esp32dev` | ESP32 WROOM/WROVER dev boards | BOOT button (GPIO0) pages. |
| `esp32s3` | ESP32-S3 DevKitC, USB-UART port | Use `esp32s3_usb` for the native USB port. |
| `esp32c3` | ESP32-C3 boards with built-in USB serial | BOOT button (GPIO9). |
| `esp32c6` | ESP32-C6 DevKitC | Needs the pioarduino platform (Arduino core 3.x). |
| `heltec_wifi_kit_32` | Heltec WiFi Kit 32 V1/V2 | Built-in OLED, pins preset. |
| `heltec_wifi_kit_32_v3` | Heltec WiFi Kit 32 V3 | Built-in OLED, powers it through Vext. |

Build and flash (from `firmware/`):

```bash
pio run -e esp32c3 -t upload
```

The desktop app's **Flash a new board** button only writes the ESP8266 image
today. Flash ESP32 boards with PlatformIO as above.

## OLED screen

Any 0.96" or 1.3" I2C OLED (SSD1306 or SH1106, 128x64 or 128x32) works. Wire
`VCC` to 3.3 V, `GND` to ground, `SDA` and `SCL` to the pins below.

| Chip | SDA | SCL |
|---|---|---|
| D1 mini / NodeMCU | D2 (GPIO4) | D1 (GPIO5) |
| ESP8266 boards with a built-in OLED (HW-364A and similar) | built in | built in |
| ESP32 | GPIO21 | GPIO22 |
| ESP32-S3, ESP32-C3 | GPIO8 | GPIO9 |
| ESP32-C6 | GPIO6 | GPIO7 |

The firmware scans these pins (in both orders) for an OLED at address `0x3C` or
`0x3D`. When the node starts, the USB log says what it found, for example
`OLED SSD1306 128x64 at 0x3C, SDA 4 SCL 5`, or `No OLED found`.

**Boot sequence.** An animated logo (a small mesh with radio waves), then a
console that checks off each start-up step with a progress bar (config,
hotspot, home Wi-Fi, radio, network, relay, owner key), then two info screens
(system: chip, flash, firmware, id, free memory; network: hotspot and IPs).
`-DML_BOOT_STEP_MS=0` removes the pauses.

**Pages.** Six pages rotate every 4-5 seconds. The page button (if the board has
one) moves on at once and holds the page for 20 seconds.

1. Node: name, network, channel, firmware, frames received and relayed, guests, free memory, uptime, nodes in range.
2. Wi-Fi: hotspot name and IP, home-router state and IP, guests.
3. Radio: chip, chip id, rejected frames, queue drops.
4. Activity: bar graph of frames received, last two minutes.
5. Mesh: this node in the middle, nodes heard in the last minute orbiting it.
6. Buddy: a face that is happy when frames arrive, chill when nodes are in range, asleep when alone and alarmed on rejected frames.

**Notifications.** A pop-up for about 3 seconds: node heard for the first time,
guest joined, left, kicked or banned, network policy applied, config saved,
USB app connected, home Wi-Fi up or lost, receive queue overflow, reboot and
factory reset.

A dot in the title bar of the text pages flashes when a frame arrives. The
hotspot password is never shown.

### If the screen stays dark or looks wrong

- **Dark, log says `No OLED found`.** Check the four wires and that VCC is 3.3 V.
  Some boards use other pins: add `-DML_OLED_SDA=<gpio> -DML_OLED_SCL=<gpio>` to
  `build_flags` of your environment.
- **Picture shifted by two pixels, with noise on one edge.** The panel is an
  SH1106. Flash the `*_sh1106` environment, or hold the page button for 1.5 s:
  the node switches the driver and remembers it.
- **Upside down.** Add `-DML_OLED_ROTATE=1`.
- **128x32 panel.** Add `-DML_OLED_H=32`. Only the first four lines show.
- **Panel gets power or reset from a pin** (Heltec boards): `-DML_OLED_PWR=<gpio>`
  and `-DML_OLED_RST=<gpio>`. The Heltec environments already set them.
- **No display wanted.** `-DML_OLED=0` leaves the display code out.

If the panel is unplugged while the node runs, the node keeps relaying and
tries to bring the screen back every 5 seconds.

## Status of testing

Compiles: `d1_mini`, `nodemcuv2`, `esp32dev`, `esp32s3`, `esp32c3`,
`heltec_wifi_kit_32` and `heltec_wifi_kit_32_v3`. Not built: `esp32c6`
(pioarduino download) and the `*_sh1106` / `esp32s3_usb` variants after the
latest display changes.

Run on hardware: only an ESP8266 with a built-in 0.96" SSD1306 (SDA 14, SCL 12).
The panel was found and accepted its init commands. No ESP32 board has been
flashed yet. If you try one, report the board and result.
