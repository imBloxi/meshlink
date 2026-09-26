"""Fake node over localhost UDP, for trying the app without hardware.

Every app instance started with --sim binds one port in SIM_PORTS and
"broadcasts" SEND frames to the other ports as RECV events.
"""
import queue
import random
import socket
import struct
import threading

from . import protocol as p

SIM_PORTS = range(47000, 47010)


class SimLink:
    def __init__(self):
        self.events: queue.Queue = queue.Queue()
        self.chip_id = random.getrandbits(32)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._port = None

    def open(self):
        for port in SIM_PORTS:
            try:
                self._sock.bind(("127.0.0.1", port))
                self._port = port
                break
            except OSError:
                continue
        if self._port is None:
            raise OSError("all simulator ports busy")
        self._sock.settimeout(0.2)
        threading.Thread(target=self._run, daemon=True).start()
        self.events.put(p.NodeInfo(p.VERSION, self.chip_id, "SIM", 0))

    def send(self, frame: bytes):
        if frame[0] != p.H_SEND:
            return
        msg_id = random.getrandbits(32) or 1
        recv = bytes([p.H_RECV, frame[1], 3]) + struct.pack("<II", self.chip_id, msg_id) + frame[2:]
        for port in SIM_PORTS:
            if port != self._port:
                self._sock.sendto(recv, ("127.0.0.1", port))
        self.events.put(p.Sent(msg_id))

    def close(self):
        self._sock.close()

    def _run(self):
        while True:
            try:
                data, _ = self._sock.recvfrom(1024)
            except (socket.timeout, ConnectionResetError):
                continue  # Windows reports ICMP "port unreachable" as a reset.
            except OSError:
                return  # Socket closed.
            event = p.parse_host_frame(data)
            if event is not None:
                self.events.put(event)
