"""Push-Wecker und Sdui-Durchreiche für die Web-App.

Speichert je Gerät nur ein Web-Push-Abo samt Uhrzeit, Zeitzone und Wochentagen —
keine Zugangsdaten, keinen Namen, keinen Bestellstand. Zur gewählten Zeit geht
ein Push mit {"t": "check"} hinaus; ob es etwas zu melden gibt, entscheidet der
Service Worker auf dem Gerät, der IBS5 selbst abfragt.

Die id ist öffentlich, ändern oder löschen darf nur, wer das beim Anlegen
ausgegebene Geheimnis kennt (gespeichert wird nur dessen SHA-256).

/api/sdui/… reicht genau die Sdui-Aufrufe der App an api.sdui.app durch, weil
Sdui Browserzugriffe von fremden Seiten sperrt. Nichts davon wird gespeichert
oder protokolliert; Passwort und Token laufen nur hindurch.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid
from pywebpush import WebPushException, webpush

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "push.sqlite")
KEY_PATH = os.path.join(DATA_DIR, "vapid_private.pem")
# Pflichtangabe für VAPID: Kontakt des Absenders. Eine URL statt einer Mailadresse,
# ohne abschließenden Schrägstrich — sonst lehnt py_vapid sie ab.
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "https://sunshine.thomschke.info")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 4096
MAX_SUBSCRIPTIONS = 5000
PUSH_TTL = 3 * 3600
# Jedes Abo wird um einen festen Zufallswert später geweckt: Handys hinter
# derselben Mobilfunk-IP (CGNAT) sollen IBS5 nicht in derselben Minute abfragen,
# sonst sperrt IBS5 die IP.
MAX_OFFSET_MIN = 9

# Nur echte Push-Dienste, sonst ließe sich der Server als Relay für beliebige URLs missbrauchen.
PUSH_HOSTS = re.compile(
    r"^(fcm\.googleapis\.com|android\.googleapis\.com|([\w-]+\.)*push\.apple\.com|"
    r"updates\.push\.services\.mozilla\.com|([\w-]+\.)*notify\.windows\.com)$"
)
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SDUI_BASE = "https://api.sdui.app/v1"
# Nur die Aufrufe der App: Login, eigenes Konto, Kind, Stundenplan.
SDUI_ROUTES = [
    ("POST", re.compile(r"^auth/login$")),
    ("GET", re.compile(r"^users/(self|\d{1,12})$")),
    ("GET", re.compile(r"^timetables/users/\d{1,12}/timetable\?begins_at=\d{4}-\d{2}-\d{2}&ends_at=\d{4}-\d{2}-\d{2}$")),
]
SDUI_LIMIT = (20, 600)  # höchstens 20 Aufrufe je Absender in 10 Minuten
sdui_hits: dict[str, deque] = defaultdict(deque)
sdui_lock = threading.Lock()


def sdui_allowed(client: str) -> bool:
    n, window = SDUI_LIMIT
    now = time.monotonic()
    with sdui_lock:
        q = sdui_hits[client]
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= n:
            return False
        q.append(now)
        # Alte Absender vergessen, damit die Tabelle nicht wächst.
        if len(sdui_hits) > 10000:
            for k in [k for k, v in sdui_hits.items() if not v or now - v[-1] > window]:
                del sdui_hits[k]
        return True

log = logging.getLogger("push")
db_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


CONN: sqlite3.Connection


def init() -> Vapid:
    global CONN
    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(KEY_PATH):
        v = Vapid()
        v.generate_keys()
        v.save_key(KEY_PATH)
        os.chmod(KEY_PATH, 0o600)
        log.info("neues VAPID-Schlüsselpaar erzeugt")
    CONN = db()
    with db_lock:
        CONN.execute(
            """CREATE TABLE IF NOT EXISTS subs (
                 id TEXT PRIMARY KEY,
                 secret_hash TEXT NOT NULL,
                 endpoint TEXT NOT NULL UNIQUE,
                 keys TEXT NOT NULL,
                 time TEXT NOT NULL,
                 weekdays TEXT NOT NULL,
                 tz TEXT NOT NULL,
                 last_sent TEXT,
                 created TEXT NOT NULL,
                 offset_min INTEGER)"""
        )
        cols = {r["name"] for r in CONN.execute("PRAGMA table_info(subs)")}
        if "offset_min" not in cols:
            CONN.execute("ALTER TABLE subs ADD COLUMN offset_min INTEGER")
        CONN.execute(f"UPDATE subs SET offset_min = abs(random()) % {MAX_OFFSET_MIN + 1} WHERE offset_min IS NULL")
        CONN.commit()
    return Vapid.from_file(KEY_PATH)


def public_key_b64(v: Vapid) -> str:
    raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


class BadRequest(Exception):
    pass


def parse_settings(body: dict, partial: bool = False) -> dict:
    out = {}
    if "time" in body or not partial:
        t = body.get("time", "12:00")
        if not isinstance(t, str) or not TIME_RE.match(t):
            raise BadRequest("time muss HH:MM sein")
        out["time"] = t
    if "weekdays" in body or not partial:
        w = body.get("weekdays", [1, 2, 3, 4, 5])
        if not isinstance(w, list) or not w or not all(isinstance(x, int) and 1 <= x <= 7 for x in w):
            raise BadRequest("weekdays muss eine Liste aus 1–7 sein")
        out["weekdays"] = "".join(str(x) for x in sorted(set(w)))
    if "tz" in body or not partial:
        tz = body.get("tz", "Europe/Berlin")
        try:
            ZoneInfo(tz)
        except (ZoneInfoNotFoundError, ValueError, TypeError):
            raise BadRequest("unbekannte Zeitzone")
        out["tz"] = tz
    if "subscription" in body or not partial:
        sub = body.get("subscription")
        if not isinstance(sub, dict):
            raise BadRequest("subscription fehlt")
        endpoint = sub.get("endpoint")
        keys = sub.get("keys") or {}
        parts = urlsplit(endpoint or "")
        if parts.scheme != "https" or not PUSH_HOSTS.match(parts.hostname or ""):
            raise BadRequest("kein bekannter Push-Dienst")
        if not isinstance(keys.get("p256dh"), str) or not isinstance(keys.get("auth"), str):
            raise BadRequest("subscription.keys unvollständig")
        out["endpoint"] = endpoint
        out["keys"] = json.dumps({"p256dh": keys["p256dh"], "auth": keys["auth"]})
    return out


def send(row: sqlite3.Row, vapid: Vapid, kind: str = "check") -> bool:
    """True = zugestellt; ein abgelaufenes Abo wird dabei gelöscht."""
    info = {"endpoint": row["endpoint"], "keys": json.loads(row["keys"])}
    try:
        webpush(
            info,
            data=json.dumps({"t": kind}),
            vapid_private_key=vapid,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=PUSH_TTL,
            headers={"Urgency": "high"},
        )
        return True
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        if status in (404, 410):
            with db_lock:
                CONN.execute("DELETE FROM subs WHERE id = ?", (row["id"],))
                CONN.commit()
            log.info("Abo abgelaufen und gelöscht")
        else:
            log.warning("Push fehlgeschlagen: HTTP %s", status)
        return False
    except Exception:
        log.exception("Push nicht versendbar")
        return False


def is_due(row, now: dt.datetime) -> bool:
    """Wochentag passt, heute noch nicht geweckt, Uhrzeit + Verschiebung erreicht (bis 1 h nachholen)."""
    due = now.replace(hour=int(row["time"][:2]), minute=int(row["time"][3:]), second=0, microsecond=0)
    # Verschiebung nie über Mitternacht hinaus, sonst fiele der Tag aus.
    due += dt.timedelta(minutes=min(row["offset_min"] or 0, 23 * 60 + 59 - due.hour * 60 - due.minute))
    late = (now - due).total_seconds()
    return (
        str(now.isoweekday()) in row["weekdays"]
        and row["last_sent"] != now.date().isoformat()
        and 0 <= late < 3600
    )


def scheduler(vapid: Vapid) -> None:
    while True:
        # Kurz nach jeder vollen Minute prüfen.
        time.sleep(61 - dt.datetime.now().second)
        try:
            with db_lock:
                rows = CONN.execute("SELECT * FROM subs").fetchall()
            sent = 0
            for row in rows:
                now = dt.datetime.now(ZoneInfo(row["tz"]))
                today = now.date().isoformat()
                if is_due(row, now):
                    with db_lock:
                        CONN.execute("UPDATE subs SET last_sent = ? WHERE id = ?", (today, row["id"]))
                        CONN.commit()
                    sent += send(row, vapid)
            if sent:
                log.info("%d Weckrufe verschickt", sent)
        except Exception:  # Der Wecker darf nie stehen bleiben.
            log.exception("Fehler im Zeitplan")


class Handler(BaseHTTPRequestHandler):
    server_version = "push"
    sys_version = ""
    vapid: Vapid

    def log_message(self, *args):  # keine IPs, keine Pfade mit ids im Log
        pass

    def reply(self, status: int, body: dict | None = None) -> None:
        data = json.dumps(body or {}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise BadRequest("zu groß")
        try:
            obj = json.loads(self.rfile.read(n) or b"{}")
        except json.JSONDecodeError:
            raise BadRequest("kein JSON")
        if not isinstance(obj, dict):
            raise BadRequest("kein Objekt")
        return obj

    def owned(self, sub_id: str) -> sqlite3.Row | None:
        auth = self.headers.get("Authorization", "")
        secret = auth[7:] if auth.startswith("Bearer ") else ""
        with db_lock:
            row = CONN.execute("SELECT * FROM subs WHERE id = ?", (sub_id,)).fetchone()
        if row is None or not secret or not secrets.compare_digest(row["secret_hash"], sha(secret)):
            return None
        return row

    def route(self) -> tuple[str, str | None, str | None]:
        m = re.match(r"^/api/subscriptions(?:/([\w-]{16,64}))?(/test)?$", self.path.split("?")[0])
        return ("subs", m.group(1), m.group(2)) if m else (self.path.split("?")[0], None, None)

    def sdui(self, method: str) -> None:
        rest = self.path[len("/api/sdui/"):]
        if not any(m == method and r.match(rest) for m, r in SDUI_ROUTES):
            return self.reply(404)
        # Absender nur flüchtig im Speicher für die Begrenzung, nie im Log.
        client = (self.headers.get("X-Forwarded-For") or self.client_address[0]).split(",")[0].strip()
        if not sdui_allowed(client):
            return self.reply(429, {"error": "zu viele Anfragen, bitte später"})
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self.reply(413)
        headers = {"Accept": "application/json", "User-Agent": "immerhin.satt (+https://github.com/thmschk/sunshine-reminder)"}
        if self.headers.get("Authorization", "").startswith("Bearer "):
            headers["Authorization"] = self.headers["Authorization"]
        data = self.rfile.read(n) if method == "POST" else None
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{SDUI_BASE}/{rest}", data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status, body = r.status, r.read()
        except urllib.error.HTTPError as exc:
            status, body = exc.code, exc.read()
        except Exception:
            return self.reply(502, {"error": "Sdui nicht erreichbar"})
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/sdui/"):
            return self.sdui("GET")
        if self.path.split("?")[0] == "/api/vapid":
            return self.reply(200, {"publicKey": public_key_b64(self.vapid)})
        self.reply(404)

    def do_POST(self):
        if self.path.startswith("/api/sdui/"):
            return self.sdui("POST")
        kind, sub_id, test = self.route()
        try:
            if kind == "subs" and sub_id is None:
                s = parse_settings(self.body())
                new_id, secret = secrets.token_urlsafe(18), secrets.token_urlsafe(24)
                with db_lock:
                    if CONN.execute("SELECT COUNT(*) FROM subs").fetchone()[0] >= MAX_SUBSCRIPTIONS:
                        return self.reply(503, {"error": "voll"})
                    # Dasselbe Gerät neu angemeldet: altes Abo ersetzen.
                    CONN.execute("DELETE FROM subs WHERE endpoint = ?", (s["endpoint"],))
                    CONN.execute(
                        "INSERT INTO subs (id, secret_hash, endpoint, keys, time, weekdays, tz, created, offset_min) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_id, sha(secret), s["endpoint"], s["keys"], s["time"], s["weekdays"], s["tz"],
                         dt.date.today().isoformat(), secrets.randbelow(MAX_OFFSET_MIN + 1)),
                    )
                    CONN.commit()
                return self.reply(201, {"id": new_id, "secret": secret})
            if kind == "subs" and test:
                row = self.owned(sub_id)
                if row is None:
                    return self.reply(404)
                return self.reply(200 if send(row, self.vapid, "test") else 502)
        except BadRequest as exc:
            return self.reply(400, {"error": str(exc)})
        self.reply(404)

    def do_PUT(self):
        kind, sub_id, test = self.route()
        if kind != "subs" or not sub_id or test:
            return self.reply(404)
        row = self.owned(sub_id)
        if row is None:
            return self.reply(404)
        try:
            s = parse_settings(self.body(), partial=True)
        except BadRequest as exc:
            return self.reply(400, {"error": str(exc)})
        if s:
            cols = ", ".join(f"{k} = ?" for k in s)
            with db_lock:
                if "endpoint" in s:
                    CONN.execute("DELETE FROM subs WHERE endpoint = ? AND id != ?", (s["endpoint"], sub_id))
                CONN.execute(f"UPDATE subs SET {cols} WHERE id = ?", (*s.values(), sub_id))
                CONN.commit()
        self.reply(200)

    def do_DELETE(self):
        kind, sub_id, test = self.route()
        if kind != "subs" or not sub_id or test or self.owned(sub_id) is None:
            return self.reply(404)
        with db_lock:
            CONN.execute("DELETE FROM subs WHERE id = ?", (sub_id,))
            CONN.commit()
        self.reply(200)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    vapid = init()
    Handler.vapid = vapid
    threading.Thread(target=scheduler, args=(vapid,), daemon=True).start()
    log.info("lauscht auf :%d", PORT)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
