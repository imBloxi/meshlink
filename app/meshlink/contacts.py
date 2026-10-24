"""Contact store. Contacts are keyed by key fingerprint, never by name."""
import base64
import json
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from .identity import fingerprint

KNOWN = "known"          # Fingerprint already in contacts.
NEW = "new"              # Unknown fingerprint, name not in use.
IMPOSTOR = "impostor"    # Unknown fingerprint claims a name we already trust.


@dataclass
class Contact:
    pubkey: bytes
    name: str
    verified: bool = False
    last_seen: float = field(default=0.0, compare=False)

    @property
    def fp(self) -> bytes:
        return fingerprint(self.pubkey)


class ContactStore:
    def __init__(self, path: Path):
        self.path = path
        self.by_fp: dict[bytes, Contact] = {}
        if path.exists():
            for item in json.loads(path.read_text("utf-8")):
                c = Contact(base64.b64decode(item["pubkey"]), item["name"], item["verified"])
                self.by_fp[c.fp] = c

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        data = [{"pubkey": base64.b64encode(c.pubkey).decode(), "name": c.name,
                 "verified": c.verified} for c in self.by_fp.values()]
        self.path.write_text(json.dumps(data, indent=2), "utf-8")

    def add(self, pubkey: bytes, name: str) -> Contact:
        c = Contact(pubkey, name)
        self.by_fp[c.fp] = c
        self.save()
        return c


def classify_announce(contacts: dict[bytes, Contact], pubkey: bytes, name: str) -> str:
    """Decide how to treat an ANNOUNCE (public key + display name) from the air.

    Anyone in radio range can send an ANNOUNCE with any name, so the name
    proves nothing. Only the key is identity. Return KNOWN, NEW or IMPOSTOR.
    """
    fp = fingerprint(pubkey)
    if fp in contacts:
        return KNOWN
    # Same rule as the desktop app: a new key using a verified contact's name
    # is treated as an impostor. Case and spaces are ignored.
    key = _name_key(name)
    if key and any(c.verified and _name_key(c.name) == key for c in contacts.values()):
        return IMPOSTOR
    return NEW


def _name_key(name: str) -> str:
    return "".join(unicodedata.normalize("NFKC", name).lower().split())
