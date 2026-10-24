"""Write protocol v1 test vectors for the TypeScript port.

Run from app/: PYTHONPATH=. python tests/export_vectors.py
Output: ../desktop/src/core/__fixtures__/v1-vectors.json
"""
import json
import struct
from pathlib import Path

from nacl.public import Box, PrivateKey

from meshlink import protocol as p
from meshlink.framing import cobs_encode, crc16, encode_frame
from meshlink.identity import fingerprint

OUT = Path(__file__).resolve().parents[2] / "desktop/src/core/__fixtures__/v1-vectors.json"

alice = PrivateKey(bytes(range(1, 33)))
bob = PrivateKey(bytes(range(33, 65)))
nonce = bytes(range(100, 124))
plain = p.pack_text("héllo mesh 🙂".encode(), ts=1_790_000_000)
ct = Box(alice, bob.public_key).encrypt(plain, nonce).ciphertext
data_body = p.pack_data(fingerprint(bytes(bob.public_key)), fingerprint(bytes(alice.public_key)), nonce, ct)

cobs_inputs = [b"", b"\x00", b"\x00\x00", b"\x11\x22\x00\x33", bytes(range(1, 255)),
               bytes(range(1, 256)), bytes(range(256)) * 2]

vectors = {
    "crc16": [{"in": d.hex(), "crc": crc16(d)} for d in [b"123456789", b"", b"\x10\x02abc"]],
    "cobs": [{"in": d.hex(), "out": cobs_encode(d).hex()} for d in cobs_inputs],
    "frames": [{"in": f.hex(), "wire": encode_frame(f).hex()} for f in [
        p.build_info_req(), p.build_send(p.AIR_ANNOUNCE, p.pack_announce(bytes(bob.public_key), "bob"))]],
    "recv_frame": (bytes([p.H_RECV, p.AIR_DATA, 2]) + struct.pack("<II", 0xAABBCCDD, 7) + b"xyz").hex(),
    "info_frame": (bytes([p.H_INFO, 1]) + struct.pack("<I", 0x00C0FFEE) + bytes([1, 2, 3, 4, 5, 6]) + bytes([6])).hex(),
    "box": {
        "alice_sk": bytes(alice).hex(), "alice_pk": bytes(alice.public_key).hex(),
        "bob_sk": bytes(bob).hex(), "bob_pk": bytes(bob.public_key).hex(),
        "alice_fp": fingerprint(bytes(alice.public_key)).hex(),
        "nonce": nonce.hex(), "plain": plain.hex(), "ciphertext": ct.hex(),
        "data_body": data_body.hex(),
    },
}

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(vectors, indent=2))
print(f"wrote {OUT}")
