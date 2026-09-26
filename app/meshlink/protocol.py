"""MeshLink protocol: host frames and app payloads. See PROTOCOL.md.

Constants mirror firmware/src/protocol.h.
"""
import struct
import time
from dataclasses import dataclass

VERSION = 1
MAX_AIR = 250
AIR_HEADER_LEN = 12
MAX_BODY = MAX_AIR - AIR_HEADER_LEN  # 238

AIR_BEACON = 0x01
AIR_DATA = 0x02
AIR_ANNOUNCE = 0x03

H_SEND = 0x10
H_INFO_REQ = 0x11
H_RECV = 0x20
H_INFO = 0x21
H_LOG = 0x22
H_SENT = 0x23

# App payload sizes.
FP_LEN = 8
PUBKEY_LEN = 32
NONCE_LEN = 24
BOX_OVERHEAD = 16
MAX_NAME = 32
PLAIN_HEADER = struct.Struct("<BI")  # kind, unix time
KIND_TEXT = 0x01
DATA_HEADER_LEN = 2 * FP_LEN + NONCE_LEN
MAX_TEXT_BYTES = MAX_BODY - DATA_HEADER_LEN - BOX_OVERHEAD - PLAIN_HEADER.size  # 177


# ---- Host frames -------------------------------------------------------------

@dataclass
class NodeInfo:
    version: int
    chip_id: int
    mac: str
    channel: int


@dataclass
class Received:
    air_type: int
    ttl: int
    origin: int
    msg_id: int
    body: bytes


@dataclass
class Sent:
    msg_id: int


@dataclass
class Log:
    text: str


def build_send(air_type: int, body: bytes) -> bytes:
    if len(body) > MAX_BODY:
        raise ValueError(f"body {len(body)} bytes, max {MAX_BODY}")
    return bytes([H_SEND, air_type]) + body


def build_info_req() -> bytes:
    return bytes([H_INFO_REQ])


def parse_host_frame(frame: bytes):
    """Turn a CRC-checked frame from the node into an event, or None."""
    kind, payload = frame[0], frame[1:]
    if kind == H_RECV and len(payload) >= 10:
        air_type, ttl, origin, msg_id = struct.unpack_from("<BBII", payload)
        return Received(air_type, ttl, origin, msg_id, payload[10:])
    if kind == H_INFO and len(payload) >= 12:
        version, chip_id = struct.unpack_from("<BI", payload)
        mac = ":".join(f"{b:02X}" for b in payload[5:11])
        return NodeInfo(version, chip_id, mac, payload[11])
    if kind == H_LOG:
        return Log(payload.decode("utf-8", "replace"))
    if kind == H_SENT and len(payload) >= 4:
        return Sent(struct.unpack_from("<I", payload)[0])
    return None


# ---- App payloads (inside air frame body) ------------------------------------

def pack_announce(pubkey: bytes, name: str) -> bytes:
    return pubkey + truncate_utf8(name, MAX_NAME)


def unpack_announce(body: bytes):
    if len(body) < PUBKEY_LEN:
        raise ValueError("short announce")
    return body[:PUBKEY_LEN], body[PUBKEY_LEN:].decode("utf-8", "replace")


def pack_data(to_fp: bytes, from_fp: bytes, nonce: bytes, ciphertext: bytes) -> bytes:
    return to_fp + from_fp + nonce + ciphertext


def unpack_data(body: bytes):
    if len(body) < DATA_HEADER_LEN + BOX_OVERHEAD:
        raise ValueError("short data")
    to_fp = body[:FP_LEN]
    from_fp = body[FP_LEN:2 * FP_LEN]
    nonce = body[2 * FP_LEN:DATA_HEADER_LEN]
    return to_fp, from_fp, nonce, body[DATA_HEADER_LEN:]


def pack_text(text_bytes: bytes, ts: int = None) -> bytes:
    return PLAIN_HEADER.pack(KIND_TEXT, int(time.time()) if ts is None else ts) + text_bytes


def unpack_plain(plain: bytes):
    kind, ts = PLAIN_HEADER.unpack_from(plain)
    return kind, ts, plain[PLAIN_HEADER.size:]


def truncate_utf8(text: str, max_bytes: int) -> bytes:
    return split_utf8(text, max_bytes)[0] if text else b""


def split_utf8(text: str, max_bytes: int):
    """Split text into UTF-8 chunks of at most max_bytes, never mid-character."""
    chunks, cur = [], bytearray()
    for ch in text:
        enc = ch.encode("utf-8")
        if len(cur) + len(enc) > max_bytes:
            chunks.append(bytes(cur))
            cur = bytearray()
        cur += enc
    if cur or not chunks:
        chunks.append(bytes(cur))
    return chunks
