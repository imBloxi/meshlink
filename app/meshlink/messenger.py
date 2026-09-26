"""Chat logic, independent of GUI and serial port so it can be tested."""
import time
from collections import deque
from dataclasses import dataclass

from nacl.exceptions import CryptoError

from . import protocol as p
from .contacts import IMPOSTOR, NEW, Contact, ContactStore, classify_announce
from .identity import Identity, fingerprint, format_fp


@dataclass
class ChatLine:
    peer_fp: bytes
    sender: str   # Display name, or "me".
    text: str
    ts: int


@dataclass
class Notice:
    text: str


class Messenger:
    """Turns protocol events into UI updates, and chat input into host frames.

    send_frame: callable taking a host frame (bytes), e.g. SerialLink.send.
    """

    def __init__(self, identity: Identity, contacts: ContactStore, name: str, send_frame):
        self.me = identity
        self.contacts = contacts
        self.name = name
        self.send_frame = send_frame
        self.neighbors: dict[int, float] = {}  # node chip id -> last beacon time
        self._seen_nonces = deque(maxlen=512)   # Replay protection.

    # ---- Outgoing ----

    def announce(self):
        self.send_frame(p.build_send(p.AIR_ANNOUNCE, p.pack_announce(self.me.pubkey, self.name)))

    def send_text(self, contact: Contact, text: str) -> list:
        lines = []
        for chunk in p.split_utf8(text, p.MAX_TEXT_BYTES):
            nonce, ct = self.me.seal(contact.pubkey, p.pack_text(chunk))
            body = p.pack_data(contact.fp, self.me.fp, nonce, ct)
            self.send_frame(p.build_send(p.AIR_DATA, body))
            lines.append(ChatLine(contact.fp, "me", chunk.decode("utf-8"), int(time.time())))
        return lines

    # ---- Incoming ----

    def handle(self, event) -> list:
        """Return a list of ChatLine / Notice objects for the UI."""
        if isinstance(event, p.Received):
            if event.air_type == p.AIR_BEACON:
                new = event.origin not in self.neighbors
                self.neighbors[event.origin] = time.time()
                return [Notice(f"Node {event.origin:08X} in range")] if new else []
            if event.air_type == p.AIR_ANNOUNCE:
                return self._on_announce(event.body)
            if event.air_type == p.AIR_DATA:
                return self._on_data(event.body)
        return []

    def _on_announce(self, body: bytes) -> list:
        try:
            pubkey, name = p.unpack_announce(body)
        except ValueError:
            return []
        if pubkey == self.me.pubkey:
            return []
        verdict = classify_announce(self.contacts.by_fp, pubkey, name)
        fp = fingerprint(pubkey)
        if verdict == IMPOSTOR:
            return [Notice(f"WARNING: unknown key {format_fp(fp)} claims name '{name}'. Ignored.")]
        if verdict == NEW:
            self.contacts.add(pubkey, name)
            return [Notice(f"New contact '{name}' key {format_fp(fp)}. Verify key in person.")]
        self.contacts.by_fp[fp].last_seen = time.time()
        return []

    def _on_data(self, body: bytes) -> list:
        try:
            to_fp, from_fp, nonce, ct = p.unpack_data(body)
        except ValueError:
            return []
        if to_fp != self.me.fp:
            return []  # Not for us. Node already relayed it.
        if nonce in self._seen_nonces:
            return []
        contact = self.contacts.by_fp.get(from_fp)
        if contact is None:
            return [Notice(f"Message from unknown key {format_fp(from_fp)} (no announce yet).")]
        try:
            kind, ts, payload = p.unpack_plain(self.me.open(contact.pubkey, nonce, ct))
        except CryptoError:
            return [Notice(f"Message from '{contact.name}' failed authentication. Dropped.")]
        self._seen_nonces.append(nonce)
        if kind != p.KIND_TEXT:
            return []
        return [ChatLine(from_fp, contact.name, payload.decode("utf-8", "replace"), ts)]
