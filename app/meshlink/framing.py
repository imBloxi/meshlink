"""Serial framing between the app and a node: COBS + CRC-16, 0x00 delimited.

Mirrors firmware/src/protocol.h. See PROTOCOL.md.
"""


def crc16(data: bytes) -> int:
    """CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)."""
    crc = 0xFFFF
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) if crc & 0x8000 else (crc << 1)
            crc &= 0xFFFF
    return crc


def cobs_encode(data: bytes) -> bytes:
    out = bytearray([0])
    code_pos = 0
    code = 1
    for b in data:
        if b == 0:
            out[code_pos] = code
            code = 1
            code_pos = len(out)
            out.append(0)
        else:
            out.append(b)
            code += 1
            if code == 0xFF:
                out[code_pos] = code
                code = 1
                code_pos = len(out)
                out.append(0)
    out[code_pos] = code
    return bytes(out)


def cobs_decode(data: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data):
        code = data[i]
        i += 1
        if code == 0 or i + code - 1 > len(data):
            raise ValueError("malformed COBS")
        out += data[i:i + code - 1]
        i += code - 1
        if code < 0xFF and i < len(data):
            out.append(0)
    return bytes(out)


def encode_frame(frame: bytes) -> bytes:
    """Add CRC, COBS encode, add delimiter. Ready to write to the port."""
    crc = crc16(frame)
    return cobs_encode(frame + bytes([crc & 0xFF, crc >> 8])) + b"\x00"


class FrameReader:
    """Collects serial bytes and yields complete, CRC-checked frames."""

    MAX_ENCODED = 512

    def __init__(self):
        self._buf = bytearray()
        self.bad_frames = 0

    def feed(self, data: bytes):
        for b in data:
            if b != 0:
                if len(self._buf) < self.MAX_ENCODED:
                    self._buf.append(b)
                continue
            raw, self._buf = bytes(self._buf), bytearray()
            if not raw:
                continue
            frame = self._check(raw)
            if frame is None:
                self.bad_frames += 1
            else:
                yield frame

    @staticmethod
    def _check(raw: bytes):
        try:
            decoded = cobs_decode(raw)
        except ValueError:
            return None
        if len(decoded) < 3:
            return None
        body, crc = decoded[:-2], decoded[-2] | (decoded[-1] << 8)
        return body if crc16(body) == crc else None
