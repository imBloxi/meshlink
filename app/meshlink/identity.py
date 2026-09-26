"""User identity and end-to-end encryption (X25519 + XSalsa20-Poly1305)."""
import hashlib
from pathlib import Path

from nacl.public import Box, PrivateKey, PublicKey

from .protocol import FP_LEN


def fingerprint(pubkey: bytes) -> bytes:
    return hashlib.blake2b(pubkey, digest_size=FP_LEN).digest()


def format_fp(fp: bytes) -> str:
    h = fp.hex().upper()
    return " ".join(h[i:i + 4] for i in range(0, len(h), 4))


class Identity:
    def __init__(self, private_key: PrivateKey):
        self._sk = private_key
        self.pubkey = bytes(private_key.public_key)
        self.fp = fingerprint(self.pubkey)

    @classmethod
    def load_or_create(cls, path: Path) -> "Identity":
        # Note: key is stored unencrypted. Protect the Windows account.
        if path.exists():
            return cls(PrivateKey(path.read_bytes()))
        sk = PrivateKey.generate()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(bytes(sk))
        return cls(sk)

    def seal(self, their_pubkey: bytes, plaintext: bytes):
        """Encrypt for one recipient. Returns (nonce, ciphertext)."""
        enc = Box(self._sk, PublicKey(their_pubkey)).encrypt(plaintext)
        return enc.nonce, enc.ciphertext

    def open(self, their_pubkey: bytes, nonce: bytes, ciphertext: bytes) -> bytes:
        """Decrypt and authenticate. Raises nacl.exceptions.CryptoError on tamper."""
        return Box(self._sk, PublicKey(their_pubkey)).decrypt(ciphertext, nonce)
