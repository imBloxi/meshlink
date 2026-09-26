"""MeshLink Windows app (tkinter)."""
import json
import queue
import time
import tkinter as tk
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, simpledialog, ttk

from . import protocol as p
from .contacts import ContactStore
from .identity import Identity, format_fp
from .link import Disconnected, SerialLink, available_ports
from .messenger import ChatLine, Messenger, Notice
from .simlink import SimLink

ANNOUNCE_EVERY_S = 30
POLL_MS = 50


class App(tk.Tk):
    def __init__(self, data_dir: Path, sim: bool):
        super().__init__()
        self.data_dir = data_dir
        self.sim = sim
        self.title("MeshLink" + (" (simulator)" if sim else ""))
        self.geometry("820x520")
        self.minsize(640, 400)

        self.identity = Identity.load_or_create(data_dir / "identity.key")
        self.contacts = ContactStore(data_dir / "contacts.json")
        self.name = self._load_name()

        self.link = None
        self.messenger = None
        self.history: dict[bytes, list[ChatLine]] = {}
        self.list_fps: list[bytes] = []
        self.last_announce = 0.0

        self._build_ui()
        self._refresh_ports()
        self._refresh_contacts()
        self._notice(f"You are '{self.name}'. Your key: {format_fp(self.identity.fp)}")
        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(POLL_MS, self._poll)

    # ---- Setup ----

    def _load_name(self) -> str:
        cfg = self.data_dir / "config.json"
        if cfg.exists():
            return json.loads(cfg.read_text("utf-8"))["name"]
        name = simpledialog.askstring("MeshLink", "Your display name:", parent=self) or "anon"
        cfg.write_text(json.dumps({"name": name}), "utf-8")
        return name

    def _build_ui(self):
        top = ttk.Frame(self, padding=6)
        top.pack(fill="x")
        ttk.Label(top, text="Node:").pack(side="left")
        self.port_var = tk.StringVar()
        self.port_box = ttk.Combobox(top, textvariable=self.port_var, width=34, state="readonly")
        self.port_box.pack(side="left", padx=4)
        ttk.Button(top, text="Refresh", command=self._refresh_ports).pack(side="left")
        self.connect_btn = ttk.Button(top, text="Connect", command=self._toggle_connect)
        self.connect_btn.pack(side="left", padx=4)
        self.status = ttk.Label(top, text="Disconnected", foreground="gray")
        self.status.pack(side="left", padx=8)
        ttk.Button(top, text="My key", command=self._show_key).pack(side="right")

        body = ttk.PanedWindow(self, orient="horizontal")
        body.pack(fill="both", expand=True, padx=6, pady=(0, 6))

        left = ttk.Frame(body)
        ttk.Label(left, text="Contacts").pack(anchor="w")
        self.contact_list = tk.Listbox(left, width=26, exportselection=False)
        self.contact_list.pack(fill="both", expand=True)
        self.contact_list.bind("<<ListboxSelect>>", lambda e: self._show_history())
        ttk.Button(left, text="Mark key verified", command=self._verify).pack(fill="x", pady=(4, 0))
        body.add(left, weight=1)

        right = ttk.Frame(body)
        self.chat = tk.Text(right, state="disabled", wrap="word")
        self.chat.tag_configure("me", foreground="#1a5fb4")
        self.chat.tag_configure("notice", foreground="#888888")
        self.chat.pack(fill="both", expand=True)
        entry_row = ttk.Frame(right)
        entry_row.pack(fill="x", pady=(4, 0))
        self.entry = ttk.Entry(entry_row)
        self.entry.pack(side="left", fill="x", expand=True)
        self.entry.bind("<Return>", lambda e: self._send())
        ttk.Button(entry_row, text="Send", command=self._send).pack(side="left", padx=(4, 0))
        body.add(right, weight=3)

        self.notices: list[str] = []

    # ---- Connection ----

    def _refresh_ports(self):
        if self.sim:
            self.port_box["values"] = ["Simulator (localhost UDP)"]
        else:
            self.port_box["values"] = [f"{dev} - {desc}" for dev, desc in available_ports()]
        if self.port_box["values"]:
            self.port_box.current(0)

    def _toggle_connect(self):
        if self.link:
            self._disconnect("Disconnected")
            return
        choice = self.port_var.get()
        if not choice:
            messagebox.showwarning("MeshLink", "Plug in a node and press Refresh.")
            return
        try:
            self.link = SimLink() if self.sim else SerialLink(choice.split(" - ")[0])
            self.link.open()
        except Exception as e:  # noqa: BLE001  Port errors vary by driver.
            self.link = None
            messagebox.showerror("MeshLink", f"Could not open port:\n{e}")
            return
        self.messenger = Messenger(self.identity, self.contacts, self.name, self.link.send)
        self.connect_btn.config(text="Disconnect")
        self.status.config(text="Waiting for node...", foreground="orange")
        # ESP boards may reboot on port open; ask for info after boot.
        self.after(1500, self._after_connect)

    def _after_connect(self):
        if self.link:
            self.link.send(p.build_info_req())
            self._announce()

    def _announce(self):
        self.messenger.announce()
        self.last_announce = time.time()

    def _disconnect(self, reason: str):
        if self.link:
            self.link.close()
        self.link = None
        self.messenger = None
        self.connect_btn.config(text="Connect")
        self.status.config(text=reason, foreground="gray")

    # ---- Event loop ----

    def _poll(self):
        if self.link:
            try:
                while True:
                    self._on_event(self.link.events.get_nowait())
            except queue.Empty:
                pass
            if self.link and time.time() - self.last_announce > ANNOUNCE_EVERY_S:
                self._announce()
        self.after(POLL_MS, self._poll)

    def _on_event(self, event):
        if isinstance(event, Disconnected):
            self._disconnect(f"Lost node: {event.reason}")
            return
        if isinstance(event, p.NodeInfo):
            self.status.config(text=f"Node {event.chip_id:08X} ({event.mac})", foreground="green")
            return
        if isinstance(event, p.Log):
            self._notice(f"node: {event.text}")
            return
        for item in self.messenger.handle(event):
            if isinstance(item, ChatLine):
                self.history.setdefault(item.peer_fp, []).append(item)
                if self._selected_fp() == item.peer_fp:
                    self._append_line(item)
                else:
                    self._notice(f"New message from {item.sender}")
            elif isinstance(item, Notice):
                self._notice(item.text)
        self._refresh_contacts()

    # ---- Contacts and chat ----

    def _refresh_contacts(self):
        sel = self._selected_fp()
        self.contact_list.delete(0, "end")
        self.list_fps = []
        now = time.time()
        for fp, c in sorted(self.contacts.by_fp.items(), key=lambda kv: kv[1].name.lower()):
            online = "●" if now - c.last_seen < ANNOUNCE_EVERY_S * 2.5 else "○"
            mark = " ✔" if c.verified else ""
            self.contact_list.insert("end", f"{online} {c.name}{mark}")
            self.list_fps.append(fp)
        if sel in self.list_fps:
            self.contact_list.selection_set(self.list_fps.index(sel))

    def _selected_fp(self):
        sel = self.contact_list.curselection()
        return self.list_fps[sel[0]] if sel else None

    def _show_history(self):
        fp = self._selected_fp()
        self.chat.config(state="normal")
        self.chat.delete("1.0", "end")
        self.chat.config(state="disabled")
        if fp is None:
            return
        c = self.contacts.by_fp[fp]
        self._write(f"Chat with {c.name}  key {format_fp(fp)}"
                    f"{'' if c.verified else '  (NOT verified)'}\n", "notice")
        for line in self.history.get(fp, []):
            self._append_line(line)

    def _append_line(self, line: ChatLine):
        stamp = datetime.fromtimestamp(line.ts).strftime("%H:%M")
        self._write(f"[{stamp}] {line.sender}: {line.text}\n", "me" if line.sender == "me" else None)

    def _notice(self, text: str):
        self._write(f"* {text}\n", "notice")

    def _write(self, text: str, tag=None):
        self.chat.config(state="normal")
        self.chat.insert("end", text, tag)
        self.chat.see("end")
        self.chat.config(state="disabled")

    def _send(self):
        text = self.entry.get().strip()
        fp = self._selected_fp()
        if not text:
            return
        if not self.messenger:
            messagebox.showinfo("MeshLink", "Connect to a node first.")
            return
        if fp is None:
            messagebox.showinfo("MeshLink", "Select a contact first.")
            return
        for line in self.messenger.send_text(self.contacts.by_fp[fp], text):
            self.history.setdefault(fp, []).append(line)
            self._append_line(line)
        self.entry.delete(0, "end")

    def _verify(self):
        fp = self._selected_fp()
        if fp is None:
            return
        c = self.contacts.by_fp[fp]
        ok = messagebox.askyesno(
            "Verify key",
            f"Compare this key with {c.name}'s screen, in person:\n\n{format_fp(fp)}\n\nDo they match?")
        c.verified = ok
        self.contacts.save()
        self._refresh_contacts()

    def _show_key(self):
        messagebox.showinfo("My key", f"Name: {self.name}\nKey: {format_fp(self.identity.fp)}")

    def _on_close(self):
        if self.link:
            self.link.close()
        self.destroy()
