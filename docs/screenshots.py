"""Screenshots der Web-App für README und Flyer: echte App, erfundene Daten.

Nutzt web/tests/screenshot.html (IBS5 wird dabei nicht gefragt), ein
Headless-Chrome und das DevTools-Protokoll (pip: websockets). Danach
`python3 docs/flugblatt.py` für den Flyer.
"""
import asyncio
import base64
import functools
import http.server
import json
import pathlib
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request

import websockets

ROOT = pathlib.Path(__file__).resolve().parent.parent
HERE = ROOT / "docs"
CHROME = shutil.which("google-chrome") or shutil.which("chromium") or "chromium"
SHOTS = {"screenshot-web-start.png": "start", "screenshot-web-bestellen.png": "bestellen"}


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def shoot(ws_url, url, out):
    async with websockets.connect(ws_url, max_size=None) as ws:
        n = 0

        async def call(method, **params):
            nonlocal n
            n += 1
            await ws.send(json.dumps({"id": n, "method": method, "params": params}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == n:
                    return msg.get("result", {})

        # Handy: 390 × 760 CSS-Pixel, doppelte Auflösung.
        await call("Emulation.setDeviceMetricsOverride", width=390, height=760, deviceScaleFactor=2, mobile=True)
        await call("Page.navigate", url=url)
        for _ in range(300):
            r = await call("Runtime.evaluate", expression="document.documentElement.dataset.ready || ''", returnByValue=True)
            if r.get("result", {}).get("value") == "1":
                break
            await asyncio.sleep(0.1)
        else:
            raise SystemExit(f"{url}: nicht fertig geworden")
        await asyncio.sleep(0.4)  # Übergänge (Fortschrittslinie, Sprung) auslaufen lassen
        shot = await call("Page.captureScreenshot", format="png")
        out.write_bytes(base64.b64decode(shot["data"]))


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
threading.Thread(target=server.serve_forever, daemon=True).start()

for name, view in SHOTS.items():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as profile:
        # Eigenes Profil je Aufnahme: IndexedDB und Zwischenspeicher fangen leer an.
        port = free_port()
        chrome = subprocess.Popen([
            CHROME, "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
            f"--user-data-dir={profile}", f"--remote-debugging-port={port}", "about:blank",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    pages = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list"))
                    page = next(p for p in pages if p["type"] == "page")
                    break
                except (OSError, StopIteration):
                    time.sleep(0.1)
            url = f"http://127.0.0.1:{server.server_address[1]}/web/tests/screenshot.html?view={view}"
            asyncio.run(shoot(page["webSocketDebuggerUrl"], url, HERE / name))
        finally:
            chrome.terminate()
            chrome.wait()
    print("geschrieben:", HERE / name)

server.shutdown()
