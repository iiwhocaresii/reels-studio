"""Reels Studio as a desktop app: serves the panel on http://127.0.0.1:48765 and adds what a
plain web page can't do – download your Shorts, hand their files to the panel, open the folder.

Start it with the "Reels Studio" desktop shortcut (or: python tools/studio.py). It listens only
on 127.0.0.1, so nothing is reachable from the network. A second start just opens the browser.
"""

import json
import os
import subprocess
import sys
import threading
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
if sys.stdout is None:  # started via pythonw (no console): keep a log instead
    sys.stdout = sys.stderr = open(TOOLS / "studio.log", "a", encoding="utf-8", buffering=1)  # noqa: SIM115

from download_shorts import OUT_DIR, download_new, local_files  # noqa: E402

PORT = 48765
PANEL = TOOLS.parent / "panel"
MIGRATED = TOOLS / ".panel-migrated"  # the old file:// panel already handed its settings over

state = {"running": False, "log": [], "downloaded": [], "error": None}
lock = threading.Lock()


def run_download(channel: str) -> None:
    def log(line: str) -> None:
        with lock:
            state["log"] = (state["log"] + [line])[-40:]

    try:
        ids = download_new(channel, log)
        with lock:
            state["downloaded"] = ids
    except Exception as exc:  # noqa: BLE001
        with lock:
            state["error"] = str(exc)[:500]
    finally:
        with lock:
            state["running"] = False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PANEL), **kwargs)

    def log_message(self, *args):  # quiet (runs without a console window)
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # always the current panel version
        super().end_headers()

    # Only this machine, and (for actions) only the panel itself: blocks other websites
    # and DNS-rebinding tricks from using the app.
    def _host_ok(self) -> bool:
        return self.headers.get("Host", "") in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def _json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self._host_ok():
            return self.send_error(403)
        path = urlparse(self.path).path
        if path == "/api/ping":
            return self._json({"app": "reels-studio", "folder": str(OUT_DIR)})
        if path == "/api/shorts":
            return self._json({vid: {"name": p.name, "size": p.stat().st_size} for vid, p in local_files().items()})
        if path.startswith("/api/shorts/"):
            p = local_files().get(path.rsplit("/", 1)[-1])
            if not p:
                return self.send_error(404)
            data = p.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "video/quicktime" if p.suffix.lower() == ".mov" else "video/mp4")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-File-Name", p.name.encode("ascii", "replace").decode())
            self.end_headers()
            self.wfile.write(data)
            return None
        if path == "/api/download":
            with lock:
                return self._json(dict(state))
        return super().do_GET()

    def do_POST(self):
        length = min(int(self.headers.get("Content-Length") or 0), 64_000)
        raw = self.rfile.read(length) if length else b""  # read first, so a refusal doesn't reset the connection
        if not self._host_ok() or self.headers.get("Origin") not in {f"http://127.0.0.1:{PORT}", f"http://localhost:{PORT}"}:
            return self.send_error(403)
        path = urlparse(self.path).path
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            return self.send_error(400)
        if path == "/api/download":
            channel = str(body.get("channel") or "").strip()
            if not channel:
                return self._json({"error": "No channel set"}, 400)
            with lock:
                if not state["running"]:
                    state.update(running=True, log=[], downloaded=[], error=None)
                    threading.Thread(target=run_download, args=(channel,), daemon=True).start()
                return self._json(dict(state))
        if path == "/api/open-folder":
            OUT_DIR.mkdir(parents=True, exist_ok=True)
            p = local_files().get(str(body.get("id") or ""))
            if os.name == "nt":
                if p:
                    subprocess.Popen(["explorer", "/select,", str(p)])  # noqa: S603,S607
                else:
                    os.startfile(OUT_DIR)  # noqa: S606
            return self._json({"ok": True})
        return self.send_error(404)


def already_running() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/ping", timeout=1) as r:
            return json.load(r).get("app") == "reels-studio"
    except Exception:  # noqa: BLE001
        return False


def open_panel() -> None:
    if not MIGRATED.exists():
        # First start: open the old file:// panel once; it forwards its saved settings to the app.
        MIGRATED.write_text("1", encoding="utf-8")
        webbrowser.open((PANEL / "to-app.html").as_uri())
    else:
        webbrowser.open(f"http://127.0.0.1:{PORT}/")


def main() -> None:
    if already_running():
        open_panel()
        return
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as exc:
        # Another program holds the port. There's no console window, so say it in a message box.
        msg = f"Reels Studio can't start: port {PORT} is used by another program.\n\n{exc}"
        print(msg)
        if os.name == "nt":
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, msg, "Reels Studio", 0x10)
        return
    threading.Timer(0.5, open_panel).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
