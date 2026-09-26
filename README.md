# MeshLink

Private, off-grid messaging over a small mesh of ESP8266 boards. No internet, no router, no cloud.

- **Nodes** (ESP8266) relay messages to each other over ESP-NOW. A node plugged into nothing but power is a repeater.
- **Windows app** talks to a node over USB and encrypts every message end to end. Nodes only ever see ciphertext.

See [PROTOCOL.md](PROTOCOL.md) for the wire format.

## Quick start with two ESP8266 boards

### 1. Flash the firmware
Install [PlatformIO](https://platformio.org/) (VS Code extension or `pip install platformio`), plug in a board, then:

```
cd firmware
pio run -e d1_mini -t upload      # or -e nodemcuv2
```

Repeat for the second board. No per-board configuration is needed.

> Windows tip: if the build fails with "No such file or directory" in `.pio`, the path is too long. Set `PLATFORMIO_BUILD_DIR` to a short folder such as `C:\mlb`.

### 2. Run the app
```
cd app
pip install -r requirements.txt
python -m meshlink
```

Pick the COM port of your board and press **Connect**. Do the same on a second PC with the second board. Each app announces itself, and the other appears in **Contacts**. Select it and chat.

**One PC, two boards:** run two copies with separate identities:
```
python -m meshlink --profile alice
python -m meshlink --profile bob
```

**No boards yet:** add `--sim` to use a localhost simulator instead of a node.

### 3. Verify keys
Anyone in radio range can claim any name. Before trusting a contact, compare the key shown under **My key** on both screens, then press **Mark key verified**.

## Tests
```
cd app
pip install pytest
python -m pytest
```

## Layout
```
firmware/   ESP8266 node (PlatformIO, Arduino core)
app/        Windows app (Python, tkinter, pyserial, PyNaCl)
```
