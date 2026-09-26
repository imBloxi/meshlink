"""USB serial link to a MeshLink node, on a background thread."""
import queue
import threading

import serial
from serial.tools import list_ports

from .framing import FrameReader, encode_frame
from .protocol import parse_host_frame


def available_ports():
    return [(p.device, p.description) for p in list_ports.comports()]


class Disconnected:
    def __init__(self, reason: str):
        self.reason = reason


class SerialLink:
    """Reads frames into `events` (a queue of protocol events). Thread-safe send()."""

    def __init__(self, port: str, baud: int = 115200):
        self.events: queue.Queue = queue.Queue()
        self._ser = serial.Serial()
        self._ser.port = port
        self._ser.baudrate = baud
        self._ser.timeout = 0.1
        # Keep DTR/RTS low so opening the port does not reset or hold the board.
        self._ser.dtr = False
        self._ser.rts = False
        self._lock = threading.Lock()
        self._running = False
        self._reader = FrameReader()

    def open(self):
        self._ser.open()
        self._running = True
        threading.Thread(target=self._run, daemon=True).start()

    def send(self, frame: bytes):
        with self._lock:
            self._ser.write(encode_frame(frame))

    def close(self):
        self._running = False
        try:
            self._ser.close()
        except serial.SerialException:
            pass

    def _run(self):
        try:
            while self._running:
                data = self._ser.read(self._ser.in_waiting or 1)
                for frame in self._reader.feed(data):
                    event = parse_host_frame(frame)
                    if event is not None:
                        self.events.put(event)
        except (serial.SerialException, OSError) as e:
            if self._running:
                self.events.put(Disconnected(str(e)))
