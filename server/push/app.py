"""Push-Wecker und Sdui-Durchreiche für die Web-App.

Speichert je Gerät nur ein Web-Push-Abo (Adresse, Schlüssel) mit Uhrzeit,
gegebenenfalls Morgenzeit, Wochentagen, Zeitzone, Zufallsverschiebung, Tag des
letzten Weckrufs je Art, Anlagedatum, SHA-256 des Abo-Geheimnisses,
Betreiber-Kennzeichen (is_admin), Tag der letzten geglückten Zustellung (last_ok), Tag
des ersten gescheiterten Versands seit der letzten Zustellung (fail_since) und
Beginn einer Ablehnung durch den Push-Dienst (auth_failed_since) — keine Zugangsdaten,
keinen Namen, keinen Bestellstand.
Zur gewählten Zeit geht ein Push mit {"t": "check"} hinaus, zur Morgenzeit
(falls gewählt) {"t": "today"}; was gemeldet wird, entscheidet der Service Worker
auf dem Gerät, der IBS5 selbst abfragt.

Öffentlich unter /api/stats: nur Summen über alle Abos (Anzahl, Push-Dienst, neu in
7/30 Tagen) und deren Tagesverlauf (stats_daily). /api/health antwortet 503, wenn der
Zeitplan steht oder heute nur Zustellungen scheitern (für externes Monitoring).

Die id ist öffentlich, ändern oder löschen darf nur, wer das beim Anlegen
ausgegebene Geheimnis kennt (gespeichert wird nur dessen SHA-256).

/api/sdui/… reicht genau die Sdui-Aufrufe der App an api.sdui.app durch, weil
Sdui Browserzugriffe von fremden Seiten sperrt. Nichts davon wird gespeichert
oder protokolliert; Passwort und Token laufen nur hindurch.
"""

from __future__ import annotations

import base64
import datetime as dt
import email.utils
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import sys
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from py_vapid import Vapid
import requests
from pywebpush import WebPushException, webpush

DATA_DIR = os.environ.get("DATA_DIR", "/data")
DB_PATH = os.path.join(DATA_DIR, "push.sqlite")
KEY_PATH = os.path.join(DATA_DIR, "vapid_private.pem")
# Pflichtangabe für VAPID: Kontakt des Absenders. Eine URL statt einer Mailadresse,
# ohne abschließenden Schrägstrich — sonst lehnt py_vapid sie ab.
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "https://sunshine-order.de")
PORT = int(os.environ.get("PORT", "8080"))
MAX_BODY = 4096
# Socket-Timeout je Lesevorgang (s), Gesamtfrist je Verbindung (s) und Obergrenze
# gleichzeitiger Verbindungen. Die Gesamtfrist fängt Clients ab, die Byte für Byte
# knapp unter dem Socket-Timeout tröpfeln.
HANDLER_TIMEOUT = 30
REQUEST_DEADLINE = 60
MAX_CONNECTIONS = 64
# Obergrenze für Abos ohne eine einzige geglückte Zustellung (last_ok IS NULL) und für alle Abos.
MAX_UNCONFIRMED = 1000
MAX_SUBSCRIPTIONS = 20000
# Abo ohne eine einzige Zustellung: gelöscht nach UNCONFIRMED_DAYS Tagen, frühestens einen Tag
# nach dem ersten fälligen Weckruf (Wochentage nur Sa: erst nach dem Samstag) und nur, wenn
# ein Versand gescheitert ist (fail_since), mindestens einen Tag danach.
UNCONFIRMED_DAYS = 2
# Abo, bei dem seit so vielen Tagen jeder Versand scheitert (fail_since, gleich welcher Fehler), wird gelöscht.
# Beide Fristen laufen frühestens ab dem Start des Dienstes: nach einem Ausfall oder einem
# Stand ohne fail_since bekommt jedes Abo erst wieder Weckrufe.
STALE_DAYS = 14
# Aufgeräumt wird nur, solange überhaupt noch zugestellt wird: eine eigene Störung
# (Netz, Schlüssel) träfe sonst alle Abos.
CLEANUP_GUARD_DAYS = 4
PUSH_TTL = 3 * 3600
PUSH_TIMEOUT = 10
# Versuche je Weckruf und Tag; dazwischen wartet der Zeitplan 1, 2, 4, 8 min oder so lange,
# wie der Push-Dienst per Retry-After verlangt (höchstens RETRY_AFTER_MAX s).
SEND_TRIES = 5
RETRY_AFTER_MAX = 1800
# Längste Meldung an die Betreiber-Geräte (Zeichen).
ALARM_MAX = 200
# /api/health: 503, wenn der letzte Durchlauf des Zeitplans älter ist oder heute bei mindestens
# HEALTH_MIN_GAVE_UP verschiedenen Abos (bzw. allen, wenn es weniger gibt) ein Weckruf aufgegeben
# wurde und keiner glückte.
HEALTH_STALE_S = 300
HEALTH_MIN_GAVE_UP = 5
# Totmannschalter: GET auf HEARTBEAT_URL (leer = aus) höchstens alle HEARTBEAT_EVERY s, solange /api/health gesund ist.
HEARTBEAT_EVERY = 300
# So viele Tage darf ein Push-Dienst ein Abo mit 401/403 ablehnen, bevor es gelöscht wird.
# 401/403 heißt meist: Abo gehört zu einem anderen VAPID-Schlüssel. Es kann aber auch an
# uns liegen (JWT, Uhr) und träfe dann alle Abos zugleich; die Frist lässt Zeit, den
# Fehler zu beheben oder den Schlüssel aus dem Backup zurückzuholen.
AUTH_FAIL_DAYS = 7
MAX_ENDPOINT_LEN = 1024
# Jedes Abo wird um eine feste Verschiebung später geweckt, gleichmäßig über eine
# halbe Stunde verteilt: Handys hinter derselben Mobilfunk-IP (CGNAT) sollen IBS5
# nicht in derselben Minute abfragen, sonst sperrt IBS5 die IP.
MAX_OFFSET_MIN = 29
# Die Morgenmeldung („heute gibt's …“) soll vor dem Losgehen ankommen: nur bis 9 min später.
MORNING_MAX_OFFSET_MIN = 9

# Nur echte Push-Dienste, sonst ließe sich der Server als Relay für beliebige URLs missbrauchen.
PUSH_HOSTS = re.compile(
    r"^(fcm\.googleapis\.com|android\.googleapis\.com|([\w-]+\.)*push\.apple\.com|"
    r"updates\.push\.services\.mozilla\.com|([\w-]+\.)*notify\.windows\.com)$"
)
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")

SDUI_BASE = "https://api.sdui.app/v1"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Umleitungen nie folgen: urllib gäbe den Authorization-Header (Sdui-Token) an jedes Ziel weiter."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


SDUI_OPENER = urllib.request.build_opener(NoRedirect)
# Nur die Aufrufe der App: Login, eigenes Konto, Kind, Stundenplan.
SDUI_ROUTES = [
    ("POST", re.compile(r"^auth/login$", re.ASCII)),
    ("GET", re.compile(r"^users/(self|\d{1,12})$", re.ASCII)),
    ("GET", re.compile(r"^timetables/users/\d{1,12}/timetable\?begins_at=\d{4}-\d{2}-\d{2}&ends_at=\d{4}-\d{2}-\d{2}$", re.ASCII)),
]


class RateLimit:
    """Höchstens n Treffer je Schlüssel im Zeitfenster (Sekunden); nur im Arbeitsspeicher.

    Höchstens max_keys Schlüssel: vorne steht, was am längsten nicht kam; Abgelaufenes wird
    dort bei jedem Aufruf abgeräumt, bei Überlauf fällt der älteste Schlüssel heraus."""

    def __init__(self, n: int, window: float, max_keys: int = 4096):
        self.n, self.window, self.max_keys = n, window, max_keys
        self.hits: OrderedDict[str, deque] = OrderedDict()
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            while self.hits:
                oldest, q = next(iter(self.hits.items()))
                if q and now - q[-1] <= self.window:
                    break
                del self.hits[oldest]
            q = self.hits.get(key)
            if q is None:
                q = self.hits[key] = deque()
                if len(self.hits) > self.max_keys:
                    self.hits.popitem(last=False)
            else:
                self.hits.move_to_end(key)
            while q and now - q[0] > self.window:
                q.popleft()
            if len(q) >= self.n:
                return False
            q.append(now)
            return True


# Schlüssel der Begrenzungen: net_key() der Absender-IP, siehe dort.
sdui_limit = RateLimit(20, 600)  # alle Sdui-Aufrufe je IPv4-Adresse bzw. IPv6-/64 in 10 Minuten
sdui_login_limit = RateLimit(5, 3600)  # Sdui-Logins je /24 bzw. /64 und Stunde
SDUI_LOGINS_PER_HOUR = 100
sdui_login_total = RateLimit(SDUI_LOGINS_PER_HOUR, 3600)  # alle Sdui-Logins zusammen; darüber Alarm
sub_limit = RateLimit(10, 3600)  # neue Abos je /24 bzw. /64 und Stunde
admin_limit = RateLimit(5, 3600)  # Versuche, ein Gerät als Betreiber zu markieren, je /24 bzw. /64
test_limit = RateLimit(5, 3600)  # Test-Weckrufe je Abo und Stunde
alarm_limit = RateLimit(1, 3600)  # Betreiber-Alarme außerhalb der Selbstprüfung, je Anlass
SDUI_LOGIN_KEYS = {"identifier", "password", "slink"}
SLINK_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# Seiten, deren Browser den Sdui-Relay benutzen dürfen.
ALLOWED_ORIGINS = ("https://sunshine-order.de",)


def net_key(ip: str, v4_prefix: int = 24) -> str:
    """Begrenzungsschlüssel einer IP: IPv4 je /24 (bzw. v4_prefix), IPv6 je /64.

    Ein Anschluss bekommt bei IPv6 meist ein ganzes /64, bei IPv4 kostet ein /24 Aufwand."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return ip
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    prefix = v4_prefix if addr.version == 4 else 64
    return str(ipaddress.ip_network(f"{addr}/{prefix}", strict=False))


def sdui_allowed(client: str) -> bool:
    return sdui_limit.allow(net_key(client, 32))


def cross_site(headers) -> bool:
    """Anfrage kam vom Browser auf einer fremden Seite.

    Browser setzen Sec-Fetch-Site bzw. Origin immer selbst; fehlen beide, ist es kein Browser,
    und der könnte die Header ohnehin beliebig setzen. Abgelehnt wird also nur, was ein Browser
    als fremd ausweist."""
    if headers.get("Sec-Fetch-Site", "").strip().lower() in ("cross-site", "same-site"):
        return True
    origin = headers.get("Origin")
    return origin is not None and origin.strip() not in ALLOWED_ORIGINS


def sdui_route_ok(method: str, rest: str) -> bool:
    """Pfad nach /api/sdui/ ist erlaubt: keine Kodierungs- oder Traversal-Tricks, nur bekannte Routen."""
    if "%" in rest or ".." in rest or "\\" in rest or "//" in rest:
        return False
    return any(m == method and r.match(rest) for m, r in SDUI_ROUTES)


def sdui_login_body(raw: bytes) -> bytes:
    """Prüft den Login-Body und serialisiert ihn neu; sonst BadRequest."""
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise BadRequest("kein JSON")
    if not isinstance(obj, dict) or set(obj) != SDUI_LOGIN_KEYS or not all(isinstance(v, str) for v in obj.values()):
        raise BadRequest("identifier, password und slink erwartet")
    if not (1 <= len(obj["identifier"]) <= 200 and 1 <= len(obj["password"]) <= 200):
        raise BadRequest("identifier oder password ungültig")
    # Sdui verlangt das Schulkürzel klein geschrieben; eingetippt wird es oft groß.
    obj["slink"] = obj["slink"].strip().lower()
    if not SLINK_RE.match(obj["slink"]):
        raise BadRequest("Schulkürzel ungültig: nur Buchstaben, Ziffern und Bindestrich")
    return json.dumps({k: obj[k] for k in ("identifier", "password", "slink")}).encode()


def client_ip(headers, client_address) -> str:
    """Letzter X-Forwarded-For-Eintrag, sonst die Peer-Adresse. Nur für Begrenzungen, nie im Log.

    Caddy (ohne trusted_proxies) ersetzt einen mitgeschickten X-Forwarded-For durch die echte
    Peer-Adresse; der letzte Eintrag hält auch, falls dort einmal angehängt statt ersetzt wird."""
    return (headers.get("X-Forwarded-For") or client_address[0]).split(",")[-1].strip()


log = logging.getLogger("push")
db_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # Gelöschte Abos werden in der Datei überschrieben, nicht nur als frei markiert.
    conn.execute("PRAGMA secure_delete = ON")
    return conn


CONN: sqlite3.Connection

# Spalten, die nach der ersten Fassung von subs dazukamen; init() ergänzt jede fehlende einzeln.
SUBS_COLUMNS = [
    ("offset_min", "INTEGER"),
    ("is_admin", "INTEGER NOT NULL DEFAULT 0"),
    ("morning_time", "TEXT"),
    ("morning_last_sent", "TEXT"),
    ("auth_failed_since", "TEXT"),
    ("last_ok", "TEXT"),
    ("fail_since", "TEXT"),
]
# PRAGMA user_version: 2 = last_ok eingeführt (bestehende Abos gelten ab da als bestätigt),
# 3 = fail_since eingeführt (anfangs leer: kein Abo gilt als gescheitert).
SCHEMA_VERSION = 3


def migrate(conn: sqlite3.Connection, today: dt.date) -> None:
    """Schema auf SCHEMA_VERSION bringen, ganz oder gar nicht (eine Transaktion)."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS subs (
                 id TEXT PRIMARY KEY,
                 secret_hash TEXT NOT NULL,
                 endpoint TEXT NOT NULL UNIQUE,
                 keys TEXT NOT NULL,
                 time TEXT NOT NULL,
                 weekdays TEXT NOT NULL,
                 tz TEXT NOT NULL,
                 last_sent TEXT,
                 created TEXT NOT NULL)"""
        )
        cols = {r[1] for r in conn.execute("PRAGMA table_info(subs)")}
        for name, decl in SUBS_COLUMNS:
            if name not in cols:
                conn.execute(f"ALTER TABLE subs ADD COLUMN {name} {decl}")
        # Tagessummen für /api/stats; gelöschte Abos verschwinden aus subs, der Verlauf bleibt hier.
        conn.execute(
            """CREATE TABLE IF NOT EXISTS stats_daily (
                 day TEXT PRIMARY KEY,
                 subs INTEGER NOT NULL,
                 apple INTEGER NOT NULL,
                 morning INTEGER NOT NULL)"""
        )
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version < 2:
            # Abos von vor last_ok: Zustellung unbekannt, gelten als bestätigt (sonst
            # räumte cleanup_subs sie als unbestätigt ab).
            conn.execute("UPDATE subs SET last_ok = ? WHERE last_ok IS NULL", (today.isoformat(),))
        conn.execute(f"UPDATE subs SET offset_min = abs(random()) % {MAX_OFFSET_MIN + 1} WHERE offset_min IS NULL")
        conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        conn.commit()
    except BaseException:
        conn.rollback()
        raise


def init() -> Vapid:
    global CONN
    os.makedirs(DATA_DIR, exist_ok=True)
    new_key = not os.path.exists(KEY_PATH)
    if new_key:
        v = Vapid()
        v.generate_keys()
        v.save_key(KEY_PATH)
        os.chmod(KEY_PATH, 0o600)
        log.info("neues VAPID-Schlüsselpaar erzeugt")
    CONN = db()
    with db_lock:
        migrate(CONN, dt.date.today())
        subs = CONN.execute("SELECT COUNT(*) FROM subs").fetchone()[0]
    if 0 < len(os.environ.get("ADMIN_KEY", "")) < 22:
        log.warning("ADMIN_KEY ist kürzer als 128 Bit, neu erzeugen: python3 -c 'import secrets; print(secrets.token_urlsafe(24))'")
    if new_key and subs:
        # Alle vorhandenen Abos gehören zum alten Schlüssel und werden ab jetzt mit 401/403 abgelehnt.
        log.warning("VAPID-Schlüssel fehlte und wurde NEU erzeugt, obwohl %d Abos bestehen: "
                    "Container stoppen und vapid_private.pem aus dem Backup zurückholen (docs/betrieb.md), "
                    "sonst löscht der Versand diese Abos nach %d Tagen", subs, AUTH_FAIL_DAYS)
    return Vapid.from_file(KEY_PATH)


def public_key_b64(v: Vapid) -> str:
    raw = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def pick_offset(conn: sqlite3.Connection, time_: str) -> int:
    """Die am wenigsten belegte Minute im Fenster derselben Uhrzeit; bei Gleichstand zufällig."""
    used = dict(conn.execute("SELECT offset_min, COUNT(*) FROM subs WHERE time = ? GROUP BY offset_min", (time_,)).fetchall())
    counts = [used.get(m, 0) for m in range(MAX_OFFSET_MIN + 1)]
    low = min(counts)
    free = [m for m, c in enumerate(counts) if c == low]
    return free[secrets.randbelow(len(free))]


def admin_key_ok(given: str) -> bool:
    """Betreiber-Schlüssel aus ADMIN_KEY (nur auf dem Server); ohne gesetzten Schlüssel nie."""
    want = os.environ.get("ADMIN_KEY", "")
    return bool(want) and bool(given) and secrets.compare_digest(given.encode(), want.encode())


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


class BadRequest(Exception):
    pass


def b64url_decode(s: str) -> bytes:
    """Strenges base64url (mit oder ohne Padding); sonst ValueError."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+={0,2}", s):
        raise ValueError("kein base64url")
    return base64.urlsafe_b64decode(s.rstrip("=") + "=" * (-len(s.rstrip("=")) % 4))


def check_endpoint(endpoint) -> None:
    """Nur https-URL eines bekannten Push-Dienstes, ohne Benutzerinfo und Sonderport."""
    if not isinstance(endpoint, str) or len(endpoint) > MAX_ENDPOINT_LEN:
        raise BadRequest("kein bekannter Push-Dienst")
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError:
        raise BadRequest("kein bekannter Push-Dienst")
    if (
        parts.scheme != "https"
        or not PUSH_HOSTS.match(parts.hostname or "")
        or "@" in parts.netloc
        or port not in (None, 443)
    ):
        raise BadRequest("kein bekannter Push-Dienst")


def check_keys(keys) -> None:
    """p256dh = unkomprimierter EC-Punkt (65 Bytes, 0x04), auth = 16 Bytes."""
    try:
        p256dh, auth = b64url_decode(keys["p256dh"]), b64url_decode(keys["auth"])
    except (ValueError, KeyError, TypeError):
        raise BadRequest("subscription.keys ungültig")
    if len(p256dh) != 65 or p256dh[0] != 4 or len(auth) != 16:
        raise BadRequest("subscription.keys ungültig")
    # Ein Punkt neben der Kurve scheitert erst beim Verschlüsseln, ohne 404/410 — das Abo bliebe für immer.
    try:
        ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), p256dh)
    except ValueError:
        raise BadRequest("subscription.keys ungültig")


def parse_settings(body: dict, partial: bool = False) -> dict:
    out = {}
    if "time" in body or not partial:
        t = body.get("time", "12:00")
        if not isinstance(t, str) or not TIME_RE.match(t):
            raise BadRequest("time muss HH:MM sein")
        out["time"] = t
    if "morning_time" in body or not partial:
        m = body.get("morning_time")
        if m is not None and (not isinstance(m, str) or not TIME_RE.match(m)):
            raise BadRequest("morning_time muss HH:MM oder null sein")
        out["morning_time"] = m
    if "weekdays" in body or not partial:
        w = body.get("weekdays", [1, 2, 3, 4, 5])
        if not isinstance(w, list) or not w or not all(isinstance(x, int) and not isinstance(x, bool) and 1 <= x <= 7 for x in w):
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
        keys = sub.get("keys")
        check_endpoint(endpoint)
        if not isinstance(keys, dict):
            raise BadRequest("subscription.keys unvollständig")
        check_keys(keys)
        out["endpoint"] = endpoint
        out["keys"] = json.dumps({"p256dh": keys["p256dh"], "auth": keys["auth"]})
    return out


class Sent:
    """Ergebnis eines Push-Versands; wahr = zugestellt. gone: Abo wurde gelöscht (abgelaufen, unbrauchbar)."""

    __slots__ = ("ok", "status", "retry_after", "gone")

    def __init__(self, ok: bool, status: int | None = None, retry_after: float | None = None, gone: bool = False):
        self.ok, self.status, self.retry_after, self.gone = ok, status, retry_after, gone

    def __bool__(self) -> bool:
        return self.ok


def short_id(sub_id: str) -> str:
    """Gekürzte Abo-id fürs Log."""
    return (sub_id or "")[:6]


def retry_after(resp) -> float | None:
    """Retry-After in Sekunden (Zahl oder HTTP-Datum), sonst None."""
    raw = getattr(resp, "headers", None)
    raw = raw.get("Retry-After") if raw is not None else None
    if not isinstance(raw, str) or not raw.strip():
        return None
    raw = raw.strip()
    if raw.isascii() and raw.isdigit():
        return float(raw)
    try:
        when = email.utils.parsedate_to_datetime(raw)
    except (TypeError, ValueError):
        return None
    return max(0.0, when.timestamp() - time.time()) if when.tzinfo else None


def msg_ref(resp, endpoint: str) -> str:
    """Kennung der Nachricht beim Push-Dienst (apns-id oder letzter Teil der Location), nie die Abo-Adresse."""
    try:
        ref = resp.headers.get("apns-id") or (resp.headers.get("Location") or "").rstrip("/").rsplit("/", 1)[-1]
    except AttributeError:
        return ""
    if not isinstance(ref, str) or not ref or ref in endpoint:
        return ""
    return ref[:40]


def note_failure(row: sqlite3.Row) -> None:
    """Ersten gescheiterten Versand seit der letzten Zustellung vermerken (fail_since, für cleanup_subs)."""
    with db_lock:
        CONN.execute("UPDATE subs SET fail_since = ? WHERE id = ? AND endpoint = ? AND fail_since IS NULL",
                     (dt.date.today().isoformat(), row["id"], row["endpoint"]))
        CONN.commit()


def send(row: sqlite3.Row, vapid: Vapid, kind: str = "check", message: str = "") -> Sent:
    """Ein Push an ein Abo, eine Logzeile (gekürzte id, Art, HTTP-Status, Dauer, Kennung beim
    Push-Dienst; nie die Endpoint-URL, sie ist das Push-Token). Ein abgelaufenes Abo wird dabei gelöscht."""
    info = {"endpoint": row["endpoint"], "keys": json.loads(row["keys"])}
    payload = {"t": kind, "sent": int(time.time())}
    if message:
        payload["m"] = message[:ALARM_MAX]
    sid = short_id(row["id"])
    t0 = time.monotonic()

    def ms() -> int:
        return int((time.monotonic() - t0) * 1000)

    try:
        # Umleitungen nie verfolgen (SSRF): max_redirects=0 lässt requests bei einer Umleitung abbrechen.
        with requests.Session() as session:
            session.max_redirects = 0
            resp = webpush(
                info,
                data=json.dumps(payload),
                vapid_private_key=vapid,
                vapid_claims={"sub": VAPID_SUBJECT},
                ttl=PUSH_TTL,
                headers={"Urgency": "high"},
                timeout=PUSH_TIMEOUT,
                requests_session=session,
            )
        status = getattr(resp, "status_code", None)
        status = status if isinstance(status, int) else None
        ref = msg_ref(resp, row["endpoint"])
        log.info("Weckruf %s an %s: HTTP %s, %d ms%s", kind, sid, status, ms(), f", Kennung {ref}" if ref else "")
        with db_lock:
            CONN.execute("UPDATE subs SET last_ok = ?, fail_since = NULL, auth_failed_since = NULL WHERE id = ? AND endpoint = ?",
                         (dt.date.today().isoformat(), row["id"], row["endpoint"]))
            CONN.commit()
        return Sent(True, status)
    except WebPushException as exc:
        status = exc.response.status_code if exc.response is not None else None
        # Immer nur dieses Abo samt Endpoint: wurde es inzwischen erneuert, bleibt es.
        if status in (404, 410):
            with db_lock:
                CONN.execute("DELETE FROM subs WHERE id = ? AND endpoint = ?", (row["id"], row["endpoint"]))
                CONN.commit()
            log.info("Weckruf %s an %s: HTTP %s, %d ms, Abo abgelaufen und gelöscht", kind, sid, status, ms())
            return Sent(False, status, gone=True)
        if status in (401, 403):
            today = dt.date.today()
            note_failure(row)
            with db_lock:
                CONN.execute("UPDATE subs SET auth_failed_since = ? WHERE id = ? AND endpoint = ? AND auth_failed_since IS NULL",
                             (today.isoformat(), row["id"], row["endpoint"]))
                gone = CONN.execute("DELETE FROM subs WHERE id = ? AND endpoint = ? AND auth_failed_since <= ?",
                                    (row["id"], row["endpoint"], (today - dt.timedelta(days=AUTH_FAIL_DAYS)).isoformat())).rowcount
                CONN.commit()
            if gone:
                log.warning("Weckruf %s an %s: HTTP %s, Abo seit %d Tagen abgelehnt (anderer VAPID-Schlüssel?), gelöscht",
                            kind, sid, status, AUTH_FAIL_DAYS)
                return Sent(False, status, gone=True)
            log.warning("Weckruf %s an %s abgelehnt: HTTP %s, %d ms (anderer VAPID-Schlüssel?)", kind, sid, status, ms())
            return Sent(False, status)
        note_failure(row)
        wait = retry_after(exc.response) if status == 429 or (status or 0) >= 500 else None
        log.warning("Weckruf %s an %s fehlgeschlagen: HTTP %s, %d ms%s", kind, sid, status, ms(),
                    f", Retry-After {wait:.0f} s" if wait is not None else "")
        return Sent(False, status, retry_after=wait)
    except requests.TooManyRedirects:
        note_failure(row)
        log.warning("Weckruf %s an %s fehlgeschlagen: Umleitung nicht gefolgt, %d ms", kind, sid, ms())
        return Sent(False)
    except requests.RequestException as exc:
        # Nur der Typ: Meldung und Traceback enthalten die Endpoint-URL (= Push-Token).
        note_failure(row)
        log.warning("Weckruf %s an %s fehlgeschlagen: %s, %d ms", kind, sid, type(exc).__name__, ms())
        return Sent(False)
    except ValueError:
        # Schlüssel oder Adresse nicht verwendbar (die Prüfung beim Anlegen fängt das meist ab): wird nie zustellbar.
        with db_lock:
            CONN.execute("DELETE FROM subs WHERE id = ? AND endpoint = ?", (row["id"], row["endpoint"]))
            CONN.commit()
        log.warning("Weckruf %s an %s: unbrauchbares Abo gelöscht", kind, sid)
        return Sent(False, gone=True)
    except Exception as exc:
        log.error("Weckruf %s an %s nicht versendbar: %s", kind, sid, type(exc).__name__)
        note_failure(row)
        return Sent(False)


# Tägliche Selbstprüfung: Gerade die Eigenheiten, von denen die Web-Version lebt,
# können unbemerkt kippen (CORS-Freigabe von IBS5, Login ohne Preflight, Sdui),
# und die mitgelieferten Ferientermine laufen irgendwann aus.
# Weicht etwas ab, geht eine Meldung an die Betreiber-Abos (is_admin).
SELFCHECK_AT = os.environ.get("SELFCHECK_AT", "06:30")
ORIGIN = "https://sunshine-order.de"
# So lange vorher mahnt die Selbstprüfung, ferien.json neu zu erzeugen (tools/ferien.py).
FERIEN_WARN_DAYS = 180
selfcheck_state = {"at": None, "ok": None, "problems": []}
BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"


def selfcheck() -> list[str]:
    """Prüft ohne Zugangsdaten, ob IBS5 und Sdui sich noch so verhalten, wie die Web-Version es braucht."""
    problems = []

    def req(method, url, headers=None, data=None, limit=2000):
        # Sicherheitshalber wie ein Browser (Origin, User-Agent), so wie die Web-App anfragt.
        h = {"Origin": ORIGIN, "User-Agent": BROWSER_UA, **(headers or {})}
        r = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(r, timeout=20) as resp:
                return resp.status, resp.headers, resp.read(limit)
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers, exc.read(limit)

    ibs = "https://ibs.sunshine-catering.de/ibs5"
    try:
        # Anmeldung mit Kundennummer 0: gibt es nicht. Bis 09.10.2026 kam HTTP 200 mit
        # errorMessage, seit dem neuen Layout 403 ohne Inhalt (wie bei jedem falschen
        # Passwort). Beides heißt: der Login ist ohne Preflight erreichbar und lesbar (CORS).
        st, hd, body = req("POST", f"{ibs}/Login/Login", {"Accept-Language": "de-DE",
                           "Content-Type": "application/x-www-form-urlencoded"},
                           b"identifierValue=0&secretValue=x&identifierType=0&secretType=0")
        rejected = st == 403 or (st == 200 and b"errorMessage" in body)
        if not rejected or hd.get("Access-Control-Allow-Origin") not in ("*", ORIGIN):
            snippet = body[:80].decode("utf-8", "replace").replace("\n", " ")
            problems.append(f"IBS5-Login ohne Preflight: HTTP {st}, Allow-Origin={hd.get('Access-Control-Allow-Origin')}, Antwort: {snippet!r}")
        st, hd, _ = req("OPTIONS", f"{ibs}/Mealplan/WeekplanMobile", {"Access-Control-Request-Method": "GET",
                        "Access-Control-Request-Headers": "authorization,x-requested-with", "Accept-Language": "de-DE"})
        if st != 200 or hd.get("Access-Control-Allow-Origin") not in ("*", ORIGIN):
            problems.append(f"IBS5-Preflight Tagesansicht: HTTP {st}, Allow-Origin={hd.get('Access-Control-Allow-Origin')}")
    except Exception as exc:
        problems.append(f"IBS5 nicht erreichbar: {type(exc).__name__}")
    try:
        st, _, _ = req("GET", f"{SDUI_BASE}/users/self")
        if st != 401:
            problems.append(f"Sdui ohne Token: HTTP {st} statt 401")
    except Exception as exc:
        problems.append(f"Sdui nicht erreichbar: {type(exc).__name__}")
    problem = ferien_problem(lambda: req("GET", f"{ORIGIN}/ferien.json", limit=200_000), dt.date.today())
    if problem:
        problems.append(problem)
    return problems


def ferien_problem(get, today: dt.date) -> str | None:
    """Meldung, wenn ferien.json fehlt, kaputt ist oder in weniger als FERIEN_WARN_DAYS Tagen ausläuft."""
    try:
        st, _, body = get()
        until = dt.date.fromisoformat(json.loads(body)["until"]) if st == 200 else None
    except Exception as exc:
        return f"ferien.json nicht lesbar: {type(exc).__name__}"
    if until is None:
        return f"ferien.json: HTTP {st}"
    if (until - today).days < FERIEN_WARN_DAYS:
        return f"Ferientermine nur bis {until.isoformat()}: tools/ferien.py ausführen und deployen"
    return None


def alarm(vapid: Vapid, text: str) -> None:
    """Meldung an alle Betreiber-Abos (is_admin), gekürzt auf ALARM_MAX Zeichen."""
    with db_lock:
        rows = CONN.execute("SELECT * FROM subs WHERE is_admin = 1").fetchall()
    for row in rows:
        send(row, vapid, "alarm", text[:ALARM_MAX])


def run_selfcheck(vapid: Vapid) -> None:
    try:
        problems = selfcheck()
        selfcheck_state.update(at=dt.datetime.now().isoformat(timespec="minutes"), ok=not problems, problems=problems)
        if problems:
            log.warning("Selbstprüfung: %s", "; ".join(problems))
            alarm(vapid, "Selbstprüfung: " + "; ".join(problems))
        else:
            log.info("Selbstprüfung ok")
    except Exception as exc:
        log.error("Selbstprüfung abgebrochen: %s", type(exc).__name__)


# Weckruf-Arten je Abo: Push-Inhalt → (Spalte Uhrzeit, Spalte letzter Versand, größte Verschiebung).
SLOTS = {
    "check": ("time", "last_sent", MAX_OFFSET_MIN),
    "today": ("morning_time", "morning_last_sent", MORNING_MAX_OFFSET_MIN),
}


def is_due(row, now: dt.datetime, kind: str = "check") -> bool:
    """Wochentag passt, heute noch nicht geweckt, Uhrzeit + Verschiebung erreicht (bis 1 h nachholen)."""
    time_col, last_col, max_offset = SLOTS[kind]
    if not row[time_col]:
        return False
    due = now.replace(hour=int(row[time_col][:2]), minute=int(row[time_col][3:]), second=0, microsecond=0)
    # Verschiebung nie über Mitternacht hinaus, sonst fiele der Tag aus.
    offset = (row["offset_min"] or 0) % (max_offset + 1)
    due += dt.timedelta(minutes=min(offset, 23 * 60 + 59 - due.hour * 60 - due.minute))
    # Über Zeitstempel, nicht über die Uhrzeit: am Tag der Sommerzeit-Umstellung gibt es
    # 02:xx nicht, die Wanduhr-Differenz zu 03:00 wäre schon eine volle Stunde.
    late = now.timestamp() - due.timestamp()
    return (
        str(now.isoweekday()) in row["weekdays"]
        and row[last_col] != now.date().isoformat()
        and 0 <= late < 3600
    )


def selfcheck_due(now: dt.datetime, last: dt.date | None) -> bool:
    """Heute noch nicht geprüft und SELFCHECK_AT erreicht, auch wenn der Durchlauf die Minute verpasst hat."""
    return last != now.date() and now.strftime("%H:%M") >= SELFCHECK_AT


def mark_sent(row, today: str, kind: str = "check") -> None:
    """Versand nur vermerken, wenn Uhrzeit und Endpoint seit dem Schnappschuss gleich geblieben sind (#4 S3)."""
    time_col, last_col, _ = SLOTS[kind]
    with db_lock:
        CONN.execute(
            f"UPDATE subs SET {last_col} = ? WHERE id = ? AND {time_col} = ? AND endpoint = ?",
            (today, row["id"], row[time_col], row["endpoint"]),
        )
        CONN.commit()


# Push-Dienst je Endpoint-Host, für die Statistik (nur Summen).
PUSH_SERVICES = [
    ("apple", re.compile(r"(^|\.)push\.apple\.com$")),
    ("google", re.compile(r"^(fcm|android)\.googleapis\.com$")),
    ("mozilla", re.compile(r"^updates\.push\.services\.mozilla\.com$")),
    ("microsoft", re.compile(r"(^|\.)notify\.windows\.com$")),
]
STATS_DAYS = 365


def push_service(endpoint: str) -> str:
    host = urlsplit(endpoint).hostname or ""
    return next((name for name, rx in PUSH_SERVICES if rx.search(host)), "andere")


def stats_snapshot(today: str) -> None:
    """Tagessumme von heute fortschreiben, nur wenn sie sich geändert hat; der letzte Stand des Tages bleibt stehen."""
    with db_lock:
        rows = CONN.execute("SELECT endpoint, morning_time FROM subs").fetchall()
        values = (len(rows), sum(push_service(r["endpoint"]) == "apple" for r in rows),
                  sum(r["morning_time"] is not None for r in rows))
        old = CONN.execute("SELECT subs, apple, morning FROM stats_daily WHERE day = ?", (today,)).fetchone()
        if old is not None and tuple(old) == values:
            return
        CONN.execute("INSERT OR REPLACE INTO stats_daily (day, subs, apple, morning) VALUES (?, ?, ?, ?)", (today, *values))
        CONN.commit()


def first_due(created: dt.date, weekdays: str) -> dt.date:
    """Erster Tag nach dem Anlegen mit einem fälligen Weckruf; der Tag selbst zählt nicht (Uhrzeit evtl. schon vorbei)."""
    for i in range(1, 8):
        day = created + dt.timedelta(days=i)
        if str(day.isoweekday()) in weekdays:
            return day
    return created + dt.timedelta(days=7)


def cleanup_subs(today: dt.date, started: dt.date | None = None) -> int:
    """Löscht Abos ohne eine einzige Zustellung (UNCONFIRMED_DAYS, frühestens Tag nach dem ersten
    fälligen Weckruf) und Abos, bei denen seit STALE_DAYS jeder Versand scheitert; beides nur nach
    einem gescheiterten Versand (fail_since) und nur, solange überhaupt zugestellt wird.
    started: Start des Dienstes, früher beginnt keine Frist."""
    with db_lock:
        rows = CONN.execute("SELECT id, endpoint, created, weekdays, last_ok, fail_since FROM subs").fetchall()
        newest = CONN.execute("SELECT MAX(last_ok) FROM subs").fetchone()[0]
    if not rows:
        return 0
    if newest is None or newest < (today - dt.timedelta(days=CLEANUP_GUARD_DAYS)).isoformat():
        log.warning("Aufräumen ausgesetzt: seit %s keine Zustellung", newest or "jeher")
        return 0
    unconfirmed, old = [], []
    for r in rows:
        # Nie versucht (Dienst stand, älterer Stand ohne fail_since) oder zuletzt zugestellt: bleibt.
        if r["fail_since"] is None:
            continue
        failed = dt.date.fromisoformat(r["fail_since"])
        if started is not None:
            failed = max(failed, started)
        if r["last_ok"] is None:
            created = dt.date.fromisoformat(r["created"])
            deadline = max(created + dt.timedelta(days=UNCONFIRMED_DAYS),
                           first_due(created, r["weekdays"]) + dt.timedelta(days=1),
                           failed + dt.timedelta(days=1))
            if started is not None:
                deadline = max(deadline, started + dt.timedelta(days=UNCONFIRMED_DAYS))
            if today > deadline:
                unconfirmed.append(r)
        elif failed < today - dt.timedelta(days=STALE_DAYS):
            old.append(r)
    if not unconfirmed and not old:
        return 0
    with db_lock:
        # Mit Endpoint und fail_since: was inzwischen erneuert oder zugestellt wurde, bleibt.
        for r in unconfirmed:
            CONN.execute("DELETE FROM subs WHERE id = ? AND endpoint = ? AND last_ok IS NULL AND fail_since = ?",
                         (r["id"], r["endpoint"], r["fail_since"]))
        for r in old:
            CONN.execute("DELETE FROM subs WHERE id = ? AND endpoint = ? AND fail_since = ?",
                         (r["id"], r["endpoint"], r["fail_since"]))
        CONN.commit()
    log.info("Aufgeräumt: %d Abos ohne jede Zustellung, %d seit %d Tagen ohne Zustellung gelöscht",
             len(unconfirmed), len(old), STALE_DAYS)
    return len(unconfirmed) + len(old)


def stats(today: dt.date) -> dict:
    """Nur Summen: keine ids, Endpoints, Uhrzeiten oder Daten einzelner Abos."""
    with db_lock:
        rows = CONN.execute("SELECT endpoint, morning_time, created, auth_failed_since FROM subs").fetchall()
        daily = CONN.execute(
            "SELECT day, subs, apple, morning FROM stats_daily WHERE day >= ? ORDER BY day",
            ((today - dt.timedelta(days=STATS_DAYS)).isoformat(),),
        ).fetchall()
    services = {name: 0 for name, _ in PUSH_SERVICES} | {"andere": 0}
    for r in rows:
        services[push_service(r["endpoint"])] += 1
    def since(days: int) -> int:
        return sum(r["created"] >= (today - dt.timedelta(days=days)).isoformat() for r in rows)

    return {
        "date": today.isoformat(),
        "subs": len(rows),
        "morning": sum(r["morning_time"] is not None for r in rows),
        "rejected": sum(r["auth_failed_since"] is not None for r in rows),
        "new_7d": since(7),
        "new_30d": since(30),
        "services": services,
        "daily": [dict(r) for r in daily],
    }


BERLIN = ZoneInfo("Europe/Berlin")
STARTED = time.monotonic()
# Letzter vollständiger Durchlauf des Zeitplans (Uhrzeit für /api/health, monotone Zeit für die Prüfung).
sched_state: dict = {"at": None, "mono": None}
# Weckrufe von heute (Europe/Berlin): zugestellt, gescheiterte Versuche, Abos mit aufgegebenem Weckruf
# (je Abo einmal, gleich welche Art; die ids dazu in gave_up_ids, nur im Speicher).
day_counts: dict = {"day": None, "sent_ok": 0, "sent_fail": 0, "gave_up": 0}
gave_up_ids: set = set()
counts_lock = threading.Lock()


def count(field: str, today: str | None = None, sub_id: str | None = None) -> None:
    today = today or dt.datetime.now(BERLIN).date().isoformat()
    with counts_lock:
        if day_counts["day"] != today:
            day_counts.update(day=today, sent_ok=0, sent_fail=0, gave_up=0)
            gave_up_ids.clear()
        if field == "gave_up":
            if sub_id in gave_up_ids:
                return
            gave_up_ids.add(sub_id)
        day_counts[field] += 1


def health() -> tuple[int, dict]:
    """Zustand für /api/health und den Totmannschalter: 503 bei problems, warn nur zur Info."""
    today = dt.datetime.now(BERLIN).date().isoformat()
    with counts_lock:
        counts = {k: (day_counts[k] if day_counts["day"] == today else 0) for k in ("sent_ok", "sent_fail", "gave_up")}
    with db_lock:
        rejected = CONN.execute("SELECT COUNT(*) FROM subs WHERE auth_failed_since IS NOT NULL").fetchone()[0]
        admins = CONN.execute("SELECT COUNT(*) FROM subs WHERE is_admin = 1").fetchone()[0]
        total = CONN.execute("SELECT COUNT(*) FROM subs").fetchone()[0]
    problems, warn = [], []
    # Vor dem ersten Durchlauf zählt der Start des Dienstes.
    if time.monotonic() - (sched_state["mono"] or STARTED) > HEALTH_STALE_S:
        problems.append("Zeitplan steht")
    # Einzelne abgelehnte oder tote Abos lösen das nicht aus, erst mehrere verschiedene;
    # bei weniger Abos insgesamt reicht es, wenn alle aufgegeben haben.
    if counts["sent_ok"] == 0 and counts["gave_up"] >= max(1, min(HEALTH_MIN_GAVE_UP, total)):
        problems.append("heute nur Fehlschläge")
    # Kein Ausfall, aber Alarme der Selbstprüfung erreichen dann niemanden.
    if admins == 0:
        warn.append("keine Betreiber-Abos")
    # Öffentlich nur die Kategorie je Problem der Selbstprüfung (Text vor dem ersten ":"); Details stehen im Log.
    public = {**selfcheck_state, "problems": [p.split(":")[0] for p in selfcheck_state["problems"]]}
    body = {
        "ok": not problems,
        "problems": problems,
        "warn": warn,
        "scheduler_at": sched_state["at"],
        **counts,
        # auth_rejected > 0: Push-Dienste lehnen Abos mit 401/403 ab, siehe AUTH_FAIL_DAYS.
        "auth_rejected": rejected,
        "admins": admins,
        "selfcheck": public,
    }
    return (503 if problems else 200), body


def ping(url: str) -> None:
    """GET auf eine Überwachungs-URL; Fehler nur mit Typ ins Log (die URL enthält ein Token)."""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "sunshine-push"}), timeout=10) as r:
            r.read(256)
    except Exception as exc:
        log.warning("Totmannschalter nicht erreichbar: %s", type(exc).__name__)


class Scheduler:
    """Jede Minute: fällige Weckrufe, Tagessumme, stündliches Aufräumen, tägliche Selbstprüfung, Totmannschalter."""

    def __init__(self, vapid: Vapid):
        self.vapid = vapid
        now = dt.datetime.now(BERLIN)
        # Nach SELFCHECK_AT gestartet: die Prüfung beim Start (main) zählt für heute.
        self.selfcheck_last = now.date() if now.strftime("%H:%M") >= SELFCHECK_AT else None
        self.selfcheck_thread: threading.Thread | None = None
        # (Abo-id, Tag, Art) → (gescheiterte Versuche, frühester nächster Versuch als Zeitstempel).
        self.failures: dict[tuple[str, str, str], tuple[int, float]] = {}
        self.cleaned: tuple[str, int] | None = None
        self.started = now.date()
        self.pinged: float | None = None

    def run(self) -> None:
        while True:
            # Kurz nach jeder vollen Minute prüfen.
            time.sleep(61 - dt.datetime.now().second)
            try:
                self.tick()
            except Exception:  # Der Wecker darf nie stehen bleiben.
                log.exception("Fehler im Zeitplan")

    def tick(self, now: dt.datetime | None = None) -> None:
        now = now or dt.datetime.now(dt.timezone.utc)
        with db_lock:
            rows = CONN.execute("SELECT * FROM subs").fetchall()
        sent = 0
        for row in rows:
            try:
                sent += self.wake(row, now)
            except Exception as exc:  # Ein kaputtes Abo hält die übrigen nicht auf.
                log.error("Fehler bei Abo %s: %s", short_id(row["id"]), type(exc).__name__)
        if sent:
            log.info("%d Weckrufe verschickt", sent)
        berlin = now.astimezone(BERLIN)
        yesterday = (berlin.date() - dt.timedelta(days=1)).isoformat()
        for key in [k for k in self.failures if k[1] < yesterday]:
            del self.failures[key]
        for step in (self.stats, self.cleanup, self.selfcheck):
            try:
                step(berlin)
            except Exception:
                log.exception("Fehler im Zeitplan (%s)", step.__name__)
        sched_state.update(at=berlin.isoformat(timespec="seconds"), mono=time.monotonic())
        self.heartbeat()

    def wake(self, row, now: dt.datetime) -> int:
        """Fällige Weckrufe eines Abos; Zahl der zugestellten."""
        local = now.astimezone(ZoneInfo(row["tz"]))
        today = local.date().isoformat()
        ts = now.timestamp()
        sent = 0
        for kind in SLOTS:
            if not is_due(row, local, kind):
                continue
            # Erst nach erfolgreicher Zustellung als erledigt markieren: scheitert der Push-Dienst
            # kurz, versucht ein späterer Durchlauf es im Nachholfenster erneut, mit wachsendem
            # Abstand und höchstens SEND_TRIES-mal; danach bleibt der Weckruf für heute aus.
            # 401/403 (Abo abgelehnt) wird heute nicht wiederholt, 404/410 hat das Abo schon gelöscht.
            key = (row["id"], today, kind)
            tries, next_at = self.failures.get(key, (0, 0.0))
            if tries >= SEND_TRIES or ts < next_at:
                continue
            res = send(row, self.vapid, kind)
            if res:
                mark_sent(row, today, kind)
                self.failures.pop(key, None)
                count("sent_ok", berlin_day(now))
                sent += 1
                continue
            if res.gone:
                continue
            tries = SEND_TRIES if res.status in (401, 403) else tries + 1
            count("sent_fail", berlin_day(now))
            delay = res.retry_after if res.retry_after is not None else 60 * 2 ** (tries - 1)
            # Durchläufe liegen gut 60 s auseinander; 5 s Spiel, damit „in 1 min“ nicht 2 min wird.
            self.failures[key] = (tries, ts + min(delay, RETRY_AFTER_MAX) - 5)
            if tries >= SEND_TRIES:
                count("gave_up", berlin_day(now), row["id"])
                if res.status in (401, 403):
                    log.warning("Weckruf %s an %s abgelehnt (HTTP %s), heute kein weiterer Versuch",
                                kind, short_id(row["id"]), res.status)
                else:
                    log.warning("Weckruf %s an %s nach %d Versuchen aufgegeben (zuletzt HTTP %s)",
                                kind, short_id(row["id"]), tries, res.status)
        return sent

    def stats(self, berlin: dt.datetime) -> None:
        stats_snapshot(berlin.date().isoformat())

    def cleanup(self, berlin: dt.datetime) -> None:
        hour = (berlin.date().isoformat(), berlin.hour)
        if self.cleaned != hour:
            self.cleaned = hour
            cleanup_subs(berlin.date(), self.started)

    def selfcheck(self, berlin: dt.datetime) -> None:
        # In eigenem Thread: sie dauert bis gut eine Minute und darf den Morgenversand nicht aufhalten.
        if not selfcheck_due(berlin, self.selfcheck_last):
            return
        if self.selfcheck_thread is not None and self.selfcheck_thread.is_alive():
            return
        self.selfcheck_last = berlin.date()
        self.selfcheck_thread = threading.Thread(target=run_selfcheck, args=(self.vapid,), daemon=True, name="selfcheck")
        self.selfcheck_thread.start()

    def heartbeat(self) -> None:
        url = os.environ.get("HEARTBEAT_URL", "").strip()
        if not url or (self.pinged is not None and time.monotonic() - self.pinged < HEARTBEAT_EVERY):
            return
        if health()[0] != 200:
            return
        self.pinged = time.monotonic()
        threading.Thread(target=ping, args=(url,), daemon=True, name="heartbeat").start()


def berlin_day(now: dt.datetime) -> str:
    return now.astimezone(BERLIN).date().isoformat()


# Sdui-Logins mit 401 (falsches Passwort o. Ä.) je Tag; ins Log kommt nur diese Zahl.
sdui_rejected = {"day": None, "n": 0}


class Handler(BaseHTTPRequestHandler):
    server_version = "push"
    sys_version = ""
    # Langsame oder abgebrochene Clients halten sonst ewig einen Thread.
    timeout = HANDLER_TIMEOUT
    vapid: Vapid
    replied = False

    def log_message(self, *args):  # keine IPs, keine Pfade mit ids im Log
        pass

    def guarded(self, handler) -> None:
        """Unbehandelte Ausnahme: 500 und eine Logzeile nur mit dem Typ (Meldungen können Abo-Daten enthalten)."""
        try:
            handler()
        except Exception as exc:
            if isinstance(exc, OSError):
                log.info("Verbindung abgebrochen (%s %s)", self.command, type(exc).__name__)
                return
            log.error("Fehler bei %s: %s", self.command, type(exc).__name__)
            if not self.replied:
                try:
                    self.reply(500)
                except OSError:
                    pass

    def do_GET(self):
        self.guarded(self.get)

    def do_POST(self):
        self.guarded(self.post)

    def do_PUT(self):
        self.guarded(self.put)

    def do_DELETE(self):
        self.guarded(self.delete)

    def start(self, status: int, length: int) -> None:
        self.replied = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(length))
        self.end_headers()

    def reply(self, status: int, body: dict | None = None) -> None:
        data = json.dumps(body or {}).encode()
        self.start(status, len(data))
        self.wfile.write(data)

    def content_length(self) -> int:
        """Content-Length als Zahl in 0..MAX_BODY; sonst BadRequest."""
        raw = (self.headers.get("Content-Length") or "0").strip()
        if not raw.isascii() or not raw.isdigit():
            raise BadRequest("Content-Length ungültig")
        n = int(raw)
        if n > MAX_BODY:
            raise BadRequest("zu groß")
        return n

    def read_body(self, n: int) -> bytes:
        try:
            data = self.rfile.read(n)
        except TimeoutError:
            raise BadRequest("Zeitüberschreitung")
        # Weniger als angekündigt: Verbindung abgebrochen oder von der Gesamtfrist geschlossen.
        if len(data) < n:
            raise BadRequest("Zeitüberschreitung")
        return data

    def body(self) -> dict:
        try:
            obj = json.loads(self.read_body(self.content_length()) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise BadRequest("kein JSON")
        if not isinstance(obj, dict):
            raise BadRequest("kein Objekt")
        return obj

    def client(self) -> str:
        return client_ip(self.headers, self.client_address)

    def owned(self, sub_id: str) -> sqlite3.Row | None:
        auth = self.headers.get("Authorization", "")
        secret = auth[7:] if auth.startswith("Bearer ") else ""
        with db_lock:
            row = CONN.execute("SELECT * FROM subs WHERE id = ?", (sub_id,)).fetchone()
        if row is None or not secret or not secrets.compare_digest(row["secret_hash"], sha(secret)):
            return None
        return row

    def route(self) -> tuple[str, str | None, str | None]:
        m = re.match(r"^/api/subscriptions(?:/([\w-]{16,64}))?(/test|/admin)?$", self.path.split("?")[0])
        return ("subs", m.group(1), m.group(2)) if m else (self.path.split("?")[0], None, None)

    def sdui(self, method: str) -> None:
        rest = self.path[len("/api/sdui/"):]
        if not sdui_route_ok(method, rest):
            return self.reply(404)
        if cross_site(self.headers):
            return self.reply(403, {"error": "nur von dieser Seite"})
        if not sdui_allowed(self.client()):
            return self.reply(429, {"error": "zu viele Anfragen, bitte später"})
        login = method == "POST"
        if login:
            if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
                return self.reply(415, {"error": "Content-Type application/json erwartet"})
            if not sdui_login_limit.allow(net_key(self.client())):
                return self.reply(429, {"error": "zu viele Anmeldeversuche, bitte später"})
            if not sdui_login_total.allow("alle"):
                if alarm_limit.allow("sdui-login"):
                    log.warning("Sdui-Relay: mehr als %d Logins in einer Stunde", SDUI_LOGINS_PER_HOUR)
                    threading.Thread(target=alarm, daemon=True, args=(
                        self.vapid, f"Sdui-Relay: mehr als {SDUI_LOGINS_PER_HOUR} Logins in einer Stunde, weitere abgewiesen")).start()
                return self.reply(429, {"error": "zu viele Anmeldeversuche, bitte später"})
        try:
            n = self.content_length()
        except BadRequest as exc:
            return self.reply(413 if str(exc) == "zu groß" else 400, {"error": str(exc)})
        headers = {"Accept": "application/json", "User-Agent": "sunshine (+https://github.com/thmschk/sunshine-reminder)"}
        if self.headers.get("Authorization", "").startswith("Bearer "):
            headers["Authorization"] = self.headers["Authorization"]
        data = None
        if login:
            try:
                data = sdui_login_body(self.read_body(n))
            except BadRequest as exc:
                return self.reply(400, {"error": str(exc)})
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(f"{SDUI_BASE}/{rest}", data=data, method=method, headers=headers)
        try:
            with SDUI_OPENER.open(req, timeout=20) as r:
                status, body = r.status, r.read()
        except urllib.error.HTTPError as exc:
            with exc:
                if 300 <= exc.code < 400:
                    return self.reply(502, {"error": "Sdui leitet um, nicht gefolgt"})
                status, body = exc.code, exc.read()
        except Exception:
            return self.reply(502, {"error": "Sdui nicht erreichbar"})
        if login and status == 401:
            today = dt.date.today().isoformat()
            if sdui_rejected["day"] != today:
                sdui_rejected.update(day=today, n=0)
            sdui_rejected["n"] += 1
            log.info("Sdui-Login abgelehnt (401), heute %d", sdui_rejected["n"])
        # Bewusst keine Access-Control-Allow-*-Header: fremde Origins können die Antwort nicht lesen.
        self.start(status, len(body))
        self.wfile.write(body)

    def get(self):
        if self.path.startswith("/api/sdui/"):
            return self.sdui("GET")
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self.reply(*health())
        if path == "/api/stats":
            return self.reply(200, stats(dt.datetime.now(BERLIN).date()))
        if path == "/api/vapid":
            return self.reply(200, {"publicKey": public_key_b64(self.vapid)})
        self.reply(404)

    def post(self):
        if self.path.startswith("/api/sdui/"):
            return self.sdui("POST")
        kind, sub_id, test = self.route()
        try:
            if kind == "subs" and sub_id is None:
                s = parse_settings(self.body())
                if not sub_limit.allow(net_key(self.client())):
                    return self.reply(429, {"error": "zu viele neue Abos, bitte später"})
                new_id, secret = secrets.token_urlsafe(18), secrets.token_urlsafe(24)
                with db_lock:
                    # Dasselbe Gerät zählt nicht mit: es ersetzt nur sein altes Abo. Begrenzt sind vor allem
                    # Abos ohne eine einzige Zustellung; cleanup_subs räumt sie nach wenigen Tagen ab.
                    unconfirmed, total = CONN.execute(
                        "SELECT COUNT(*) FILTER (WHERE last_ok IS NULL), COUNT(*) FROM subs WHERE endpoint != ?",
                        (s["endpoint"],)).fetchone()
                    if unconfirmed >= MAX_UNCONFIRMED or total >= MAX_SUBSCRIPTIONS:
                        return self.reply(503, {"error": "voll"})
                    # Dasselbe Gerät neu angemeldet: altes Abo ersetzen. is_admin wird nicht übernommen
                    # (der Endpoint ist kein Geheimnis); Betreiber markieren sich per ADMIN_KEY neu.
                    CONN.execute("DELETE FROM subs WHERE endpoint = ?", (s["endpoint"],))
                    CONN.execute(
                        "INSERT INTO subs (id, secret_hash, endpoint, keys, time, weekdays, tz, created, offset_min, is_admin, morning_time) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        (new_id, sha(secret), s["endpoint"], s["keys"], s["time"], s["weekdays"], s["tz"],
                         dt.date.today().isoformat(), pick_offset(CONN, s["time"]), 0,
                         s["morning_time"]),
                    )
                    CONN.commit()
                return self.reply(201, {"id": new_id, "secret": secret, "is_admin": False})
            if kind == "subs" and test == "/test":
                row = self.owned(sub_id)
                if row is None:
                    return self.reply(404)
                if not test_limit.allow(row["id"]):
                    return self.reply(429, {"error": "zu viele Tests, bitte später"})
                # {"kind": "today"} probt die Morgenmeldung, sonst die Erinnerung.
                push_kind = "today-test" if self.body().get("kind") == "today" else "test"
                ok = send(row, self.vapid, push_kind)
                return self.reply(200 if ok else 502, {"is_admin": bool(row["is_admin"])})
            if kind == "subs" and test == "/admin":
                # Gerät als Betreiber-Gerät markieren: Geheimnis des Abos UND Betreiber-Schlüssel.
                if not admin_limit.allow(net_key(self.client())):
                    return self.reply(429, {"error": "zu viele Versuche, bitte später"})
                row = self.owned(sub_id)
                if row is None or not admin_key_ok(self.headers.get("X-Admin-Key", "")):
                    return self.reply(403)
                with db_lock:
                    CONN.execute("UPDATE subs SET is_admin = 1 WHERE id = ?", (sub_id,))
                    CONN.commit()
                return self.reply(200, {"admin": True, "is_admin": True})
        except BadRequest as exc:
            return self.reply(400, {"error": str(exc)})
        self.reply(404)

    def put(self):
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
            with db_lock:
                if "time" in s and s["time"] != row["time"]:
                    s["offset_min"] = pick_offset(CONN, s["time"])
                    # Neue Uhrzeit: heute zur neuen Zeit wecken, auch wenn die alte schon dran war.
                    s["last_sent"] = None
                if "morning_time" in s and s["morning_time"] != row["morning_time"]:
                    s["morning_last_sent"] = None
            if "endpoint" in s:
                s["auth_failed_since"] = None
                s["fail_since"] = None
            cols = ", ".join(f"{k} = ?" for k in s)
            with db_lock:
                if "endpoint" in s:
                    CONN.execute("DELETE FROM subs WHERE endpoint = ? AND id != ?", (s["endpoint"], sub_id))
                CONN.execute(f"UPDATE subs SET {cols} WHERE id = ?", (*s.values(), sub_id))
                CONN.commit()
        self.reply(200, {"is_admin": bool(row["is_admin"])})

    def delete(self):
        kind, sub_id, test = self.route()
        if kind != "subs" or not sub_id or test or self.owned(sub_id) is None:
            return self.reply(404)
        with db_lock:
            CONN.execute("DELETE FROM subs WHERE id = ?", (sub_id,))
            CONN.commit()
        self.reply(200)


class LimitedServer(ThreadingHTTPServer):
    """Höchstens MAX_CONNECTIONS gleichzeitige Verbindungen; weitere bekommen sofort 503.

    Jede Verbindung hat REQUEST_DEADLINE Sekunden; danach schließt ein Wächter-Thread sie."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        self.deadlines: dict[socket.socket, float] = {}
        self.deadline_lock = threading.Lock()
        self.closed = threading.Event()
        threading.Thread(target=self.watchdog, daemon=True, name="watchdog").start()

    def watchdog(self) -> None:
        while not self.closed.wait(0.5):
            now = time.monotonic()
            with self.deadline_lock:
                late = [s for s, t in self.deadlines.items() if now > t]
                for s in late:
                    del self.deadlines[s]
            for s in late:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def server_close(self) -> None:
        self.closed.set()
        super().server_close()

    def handle_error(self, request, client_address) -> None:
        # Ohne Traceback (könnte Anfragedaten enthalten) und ohne Client-Adresse.
        exc = sys.exc_info()[1]
        log.info("Verbindung abgebrochen: %s", type(exc).__name__)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:  # Thread nicht gestartet: Platz sofort freigeben.
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        with self.deadline_lock:
            self.deadlines[request] = time.monotonic() + REQUEST_DEADLINE
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.deadline_lock:
                self.deadlines.pop(request, None)
            self.slots.release()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    vapid = init()
    Handler.vapid = vapid
    threading.Thread(target=Scheduler(vapid).run, daemon=True, name="scheduler").start()
    threading.Thread(target=run_selfcheck, args=(vapid,), daemon=True, name="selfcheck").start()
    log.info("lauscht auf :%d", PORT)
    LimitedServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
