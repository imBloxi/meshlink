import os
import struct

import pytest

from meshlink import protocol as p
from meshlink.contacts import ContactStore
from meshlink.framing import FrameReader, cobs_decode, cobs_encode, crc16, encode_frame
from meshlink.identity import Identity
from meshlink.messenger import ChatLine, Messenger, Notice
from nacl.public import PrivateKey


def test_crc16_check_value():
    assert crc16(b"123456789") == 0x29B1


@pytest.mark.parametrize("data", [
    b"", b"\x00", b"\x00\x00", b"\x11\x22\x00\x33", bytes(range(1, 255)),
    bytes(range(1, 256)), bytes(300), os.urandom(250),
])
def test_cobs_roundtrip(data):
    enc = cobs_encode(data)
    assert 0 not in enc
    assert cobs_decode(enc) == data


def test_frame_reader_splits_and_rejects_garbage():
    good = bytes([p.H_LOG]) + b"hello"
    corrupt = bytearray(encode_frame(good))
    corrupt[2] ^= 0xFF
    stream = b"boot noise\x00" + bytes(corrupt) + encode_frame(good) * 2
    reader = FrameReader()
    frames = []
    for i in range(0, len(stream), 3):  # Arrives in small pieces.
        frames += list(reader.feed(stream[i:i + 3]))
    assert frames == [good, good]
    assert reader.bad_frames == 2


def test_parse_recv():
    frame = bytes([p.H_RECV, p.AIR_DATA, 2]) + struct.pack("<II", 0xAABBCCDD, 7) + b"xyz"
    ev = p.parse_host_frame(frame)
    assert ev == p.Received(p.AIR_DATA, 2, 0xAABBCCDD, 7, b"xyz")


def test_split_utf8_never_breaks_characters():
    text = "héllo wörld 🙂" * 40
    chunks = p.split_utf8(text, 17)
    assert all(len(c) <= 17 for c in chunks)
    assert b"".join(chunks).decode() == text


def make_user(tmp_path, name):
    ident = Identity(PrivateKey.generate())
    return Messenger(ident, ContactStore(tmp_path / f"{name}.json"), name, None)


def wire(*users):
    """Fake radio: frames one user sends arrive at all others."""
    inbox = {u.name: [] for u in users}

    def sender(src):
        def send(frame):
            assert frame[0] == p.H_SEND
            assert len(frame) - 2 <= p.MAX_BODY
            for u in users:
                if u is not src:
                    inbox[u.name] += u.handle(p.Received(frame[1], 3, 1, 1, frame[2:]))
        return send

    for u in users:
        u.send_frame = sender(u)
    return inbox


def test_end_to_end_chat(tmp_path):
    alice, bob, eve = (make_user(tmp_path, n) for n in ("alice", "bob", "eve"))
    inbox = wire(alice, bob, eve)
    alice.announce()
    bob.announce()
    assert any(isinstance(x, Notice) and "alice" in x.text for x in inbox["bob"])

    long_text = "secret " * 60  # Longer than one frame.
    alice.send_text(alice.contacts.by_fp[bob.me.fp], long_text)
    got = [x for x in inbox["bob"] if isinstance(x, ChatLine)]
    assert "".join(x.text for x in got) == long_text
    assert all(x.sender == "alice" for x in got)
    assert not [x for x in inbox["eve"] if isinstance(x, ChatLine)]  # Eve cannot read it.


def test_tampered_message_rejected(tmp_path):
    alice, bob = make_user(tmp_path, "alice"), make_user(tmp_path, "bob")
    wire(alice, bob)
    alice.announce()
    bob.announce()
    frames = []
    alice.send_frame = frames.append
    alice.send_text(alice.contacts.by_fp[bob.me.fp], "hi")
    body = bytearray(frames[0][2:])
    body[-1] ^= 1
    out = bob.handle(p.Received(p.AIR_DATA, 3, 1, 1, bytes(body)))
    assert isinstance(out[0], Notice) and "failed authentication" in out[0].text


def test_replay_ignored(tmp_path):
    alice, bob = make_user(tmp_path, "alice"), make_user(tmp_path, "bob")
    wire(alice, bob)
    alice.announce()
    bob.announce()
    frames = []
    alice.send_frame = frames.append
    alice.send_text(alice.contacts.by_fp[bob.me.fp], "pay 10")
    ev = p.Received(p.AIR_DATA, 3, 1, 1, frames[0][2:])
    assert len(bob.handle(ev)) == 1
    assert bob.handle(ev) == []
