"""Fälligkeit der Weckrufe: python3 -m unittest test_app (im Container oder mit pywebpush installiert)."""
import base64
import datetime as dt
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app import (
    SDUI_OPENER, BadRequest, RateLimit, check_endpoint, check_keys, ferien_problem, is_due, parse_settings, sdui_login_body, sdui_route_ok,
)

TZ = ZoneInfo("Europe/Berlin")


class MitDb(unittest.TestCase):
    """Echte Datenbank, angelegt über init() in einem Temp-Verzeichnis."""

    def setUp(self):
        import app
        self.app = app
        self.old = getattr(app, "CONN", None)
        self.dir = tempfile.TemporaryDirectory()
        d = self.dir.name
        self.dbpatch = mock.patch.multiple(app, DATA_DIR=d, DB_PATH=os.path.join(d, "push.sqlite"),
                                           KEY_PATH=os.path.join(d, "vapid_private.pem"))
        self.dbpatch.start()
        self.vapid = app.init()

    def tearDown(self):
        self.app.CONN.close()
        self.dbpatch.stop()
        self.app.CONN = self.old
        self.dir.cleanup()

    def add(self, sub_id="a", endpoint="https://fcm.googleapis.com/alt", **cols):
        row = {"id": sub_id, "secret_hash": "h", "endpoint": endpoint, "keys": "{}", "time": "12:00",
               "weekdays": "12345", "tz": "Europe/Berlin", "created": "2026-10-05", "offset_min": 0, **cols}
        self.app.CONN.execute(f"INSERT INTO subs ({', '.join(row)}) VALUES ({', '.join('?' * len(row))})", tuple(row.values()))
        self.app.CONN.commit()
        return self.get(sub_id)

    def get(self, sub_id="a"):
        return self.app.CONN.execute("SELECT * FROM subs WHERE id = ?", (sub_id,)).fetchone()


def at(h, m, day=5):  # 2026-10-05 ist ein Montag
    return dt.datetime(2026, 10, day, h, m, 30, tzinfo=TZ)


def row(time="12:00", offset=0, weekdays="12345", last_sent=None):
    return {"time": time, "offset_min": offset, "weekdays": weekdays, "last_sent": last_sent}


class IsDue(unittest.TestCase):
    def test_genau_zur_zeit_plus_verschiebung(self):
        self.assertFalse(is_due(row(offset=7), at(12, 6)))
        self.assertTrue(is_due(row(offset=7), at(12, 7)))

    def test_nur_einmal_am_tag(self):
        self.assertFalse(is_due(row(last_sent="2026-10-05"), at(12, 0)))
        self.assertTrue(is_due(row(last_sent="2026-10-04"), at(12, 0)))

    def test_nachholen_hoechstens_eine_stunde(self):
        self.assertTrue(is_due(row(), at(12, 59)))
        self.assertFalse(is_due(row(), at(13, 0)))

    def test_wochenende(self):
        self.assertFalse(is_due(row(), at(12, 0, day=10)))  # Samstag

    def test_verschiebung_nicht_ueber_mitternacht(self):
        self.assertTrue(is_due(row(time="23:55", offset=9), at(23, 59)))


class Morgens(unittest.TestCase):
    def morning(self, **kw):
        return {**row(**kw), "morning_time": "07:00", "morning_last_sent": None}

    def test_aus_heisst_nie(self):
        self.assertFalse(is_due({**row(), "morning_time": None, "morning_last_sent": None}, at(7, 0), "today"))

    def test_verschiebung_hoechstens_neun_minuten(self):
        self.assertTrue(is_due(self.morning(offset=3), at(7, 3), "today"))
        self.assertFalse(is_due(self.morning(offset=23), at(7, 2), "today"))  # 23 % 10 = 3
        self.assertTrue(is_due(self.morning(offset=23), at(7, 3), "today"))

    def test_unabhaengig_von_der_erinnerung(self):
        r = {**self.morning(last_sent="2026-10-05"), "morning_last_sent": None}
        self.assertTrue(is_due(r, at(7, 0), "today"))
        self.assertFalse(is_due({**r, "morning_last_sent": "2026-10-05"}, at(7, 0), "today"))
        self.assertFalse(is_due(r, at(12, 0)))  # Erinnerung heute schon verschickt

    def test_gleiche_wochentage(self):
        self.assertFalse(is_due(self.morning(), at(7, 0, day=10), "today"))  # Samstag

    def test_einstellung(self):
        self.assertEqual(parse_settings({"morning_time": "07:00"}, partial=True), {"morning_time": "07:00"})
        self.assertEqual(parse_settings({"morning_time": None}, partial=True), {"morning_time": None})
        self.assertEqual(parse_settings({"time": "17:00"}, partial=True), {"time": "17:00"})
        for bad in ("7:00", "24:00", 700, ""):
            with self.assertRaises(BadRequest):
                parse_settings({"morning_time": bad}, partial=True)



class SduiRoutes(unittest.TestCase):
    def allowed(self, method, rest):
        from app import SDUI_ROUTES
        return any(m == method and r.match(rest) for m, r in SDUI_ROUTES)

    def test_erlaubt(self):
        self.assertTrue(self.allowed("POST", "auth/login"))
        self.assertTrue(self.allowed("GET", "users/self"))
        self.assertTrue(self.allowed("GET", "users/12345"))
        self.assertTrue(self.allowed("GET", "timetables/users/12345/timetable?begins_at=2026-10-05&ends_at=2026-10-19"))

    def test_alles_andere_nicht(self):
        self.assertFalse(self.allowed("GET", "auth/login"))
        self.assertFalse(self.allowed("POST", "users/self"))
        self.assertFalse(self.allowed("GET", "users/self/../admin"))
        self.assertFalse(self.allowed("GET", "conversations"))
        self.assertFalse(self.allowed("GET", "timetables/users/1/timetable?begins_at=x&ends_at=y"))
        self.assertFalse(self.allowed("GET", "timetables/users/1/timetable?begins_at=2026-10-05&ends_at=2026-10-19&x=1"))

    def test_begrenzung(self):
        import app
        app.sdui_limit.hits.clear()
        results = [app.sdui_allowed("1.2.3.4") for _ in range(25)]
        self.assertEqual(results.count(True), 20)
        self.assertTrue(app.sdui_allowed("5.6.7.8"))


def b64(raw, pad=False):
    s = base64.urlsafe_b64encode(raw).decode()
    return s if pad else s.rstrip("=")


def point():
    """Öffentlicher P-256-Schlüssel wie aus PushSubscription.getKey("p256dh")."""
    return ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)


GOOD_KEYS = {"p256dh": b64(point()), "auth": b64(os.urandom(16))}


class PushEndpoints(unittest.TestCase):
    def test_abgelehnt(self):
        for url in (
            "http://fcm.googleapis.com/x",
            "https://localhost/x",
            "https://169.254.169.254/x",
            "https://evil.example/x",
            "https://user@fcm.googleapis.com/x",
            "https://fcm.googleapis.com:8443/x",
            "https://fcm.googleapis.com/" + "a" * 1100,
        ):
            with self.subTest(url=url), self.assertRaises(BadRequest):
                parse_settings({"subscription": {"endpoint": url, "keys": GOOD_KEYS}})

    def test_angenommen(self):
        s = parse_settings({"subscription": {"endpoint": "https://fcm.googleapis.com/fcm/send/abc", "keys": GOOD_KEYS}})
        self.assertEqual(s["endpoint"], "https://fcm.googleapis.com/fcm/send/abc")
        check_endpoint("https://fcm.googleapis.com:443/fcm/send/abc")


class PushKeys(unittest.TestCase):
    def test_gueltig(self):
        check_keys(GOOD_KEYS)
        check_keys({"p256dh": b64(point(), pad=True), "auth": b64(os.urandom(16), pad=True)})

    def test_ungueltig(self):
        auth = b64(os.urandom(16))
        for keys in (
            {"p256dh": b64(b"\x04" + os.urandom(63)), "auth": auth},  # zu kurz
            {"p256dh": b64(b"\x02" + os.urandom(64)), "auth": auth},  # falsches erstes Byte
            {"p256dh": b64(b"\x04" + bytes(64)), "auth": auth},  # Punkt neben der Kurve
            {"p256dh": b64(point()), "auth": b64(os.urandom(15))},
            {"p256dh": "kein base64!", "auth": auth},
            {"p256dh": GOOD_KEYS["p256dh"]},
            {"p256dh": 1, "auth": auth},
        ):
            with self.subTest(keys=keys), self.assertRaises(BadRequest):
                check_keys(keys)


class RateLimitTest(unittest.TestCase):
    def test_grenze_und_schluessel(self):
        rl = RateLimit(3, 3600)
        self.assertEqual([rl.allow("a") for _ in range(4)], [True, True, True, False])
        self.assertTrue(rl.allow("b"))

    def test_fenster_laeuft_ab(self):
        rl = RateLimit(1, 0.05)
        self.assertTrue(rl.allow("a"))
        self.assertFalse(rl.allow("a"))
        import time
        time.sleep(0.06)
        self.assertTrue(rl.allow("a"))


class SduiUmleitung(unittest.TestCase):
    def test_token_geht_nie_an_ein_umleitungsziel(self):
        import http.server
        import threading
        import urllib.error
        import urllib.request

        seen = []

        class Ziel(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()

            def log_message(self, *a):
                pass

        ziel = http.server.HTTPServer(("127.0.0.1", 0), Ziel)

        class Umleiter(Ziel):
            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{ziel.server_port}/x")
                self.end_headers()

        quelle = http.server.HTTPServer(("127.0.0.1", 0), Umleiter)
        for s in (ziel, quelle):
            threading.Thread(target=s.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{quelle.server_port}/users/self",
                                         headers={"Authorization": "Bearer geheim"})
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                SDUI_OPENER.open(req, timeout=5)
            ctx.exception.close()
            self.assertEqual(ctx.exception.code, 302)
            self.assertEqual(seen, [], "Umleitungsziel darf nicht aufgerufen werden")
        finally:
            for srv in (ziel, quelle):
                srv.shutdown()
                srv.server_close()


class SduiPfad(unittest.TestCase):
    def test_pfadpruefung(self):
        self.assertTrue(sdui_route_ok("GET", "users/self"))
        for rest in ("users/../admin", "users/%2e%2e", "users/12a", "users//1", "users\\1", "users/\u0661\u0662"):
            with self.subTest(rest=rest):
                self.assertFalse(sdui_route_ok("GET", rest))


class SduiLogin(unittest.TestCase):
    def body(self, **kw):
        d = {"identifier": "a@b.de", "password": "pw", "slink": "schule-1"}
        d.update(kw)
        return json.dumps(d).encode()

    def test_gueltig(self):
        out = json.loads(sdui_login_body(self.body()))
        self.assertEqual(out, {"identifier": "a@b.de", "password": "pw", "slink": "schule-1"})

    def test_kuerzel_wird_klein_geschrieben(self):
        self.assertEqual(json.loads(sdui_login_body(self.body(slink=" Schule-1 ")))["slink"], "schule-1")

    def test_abgelehnt(self):
        extra = json.dumps({"identifier": "a", "password": "b", "slink": "x", "z": "1"}).encode()
        cases = [extra, b"kein json", b"[]", self.body(slink="../x"), self.body(slink="Groß"), self.body(slink=""),
                 self.body(password="x" * 201), self.body(password=""), self.body(identifier=1)]
        for raw in cases:
            with self.subTest(raw=raw), self.assertRaises(BadRequest):
                sdui_login_body(raw)


class Verteilung(unittest.TestCase):
    def test_gleichmaessig_ueber_die_halbe_stunde(self):
        import sqlite3
        import app
        c = sqlite3.connect(":memory:")
        self.addCleanup(c.close)
        c.execute("CREATE TABLE subs (time TEXT, offset_min INTEGER)")
        for _ in range(60):
            c.execute("INSERT INTO subs VALUES ('17:00', ?)", (app.pick_offset(c, "17:00"),))
        counts = [n for (n,) in c.execute("SELECT COUNT(*) FROM subs GROUP BY offset_min")]
        self.assertEqual(len(counts), app.MAX_OFFSET_MIN + 1)
        self.assertEqual(set(counts), {2})

    def test_andere_uhrzeit_zaehlt_nicht(self):
        import sqlite3
        import app
        c = sqlite3.connect(":memory:")
        self.addCleanup(c.close)
        c.execute("CREATE TABLE subs (time TEXT, offset_min INTEGER)")
        c.executemany("INSERT INTO subs VALUES ('12:00', ?)", [(m,) for m in range(30)])
        self.assertIn(app.pick_offset(c, "17:00"), range(30))


class Betreiber(unittest.TestCase):
    def test_schluessel(self):
        import os
        import app
        os.environ.pop("ADMIN_KEY", None)
        self.assertFalse(app.admin_key_ok("x"))
        os.environ["ADMIN_KEY"] = "geheim-123"
        self.assertTrue(app.admin_key_ok("geheim-123"))
        self.assertFalse(app.admin_key_ok("geheim-12"))
        self.assertFalse(app.admin_key_ok(""))
        os.environ.pop("ADMIN_KEY")


class Ferien(unittest.TestCase):
    TODAY = dt.date(2026, 10, 9)

    def problem(self, status=200, body=None, until="2030-08-17"):
        body = json.dumps({"until": until, "holidays": []}).encode() if body is None else body
        return ferien_problem(lambda: (status, {}, body), self.TODAY)

    def test_lange_genug(self):
        self.assertIsNone(self.problem())

    def test_laeuft_bald_aus(self):
        self.assertIn("tools/ferien.py", self.problem(until="2027-03-01"))

    def test_fehlt_oder_kaputt(self):
        self.assertIn("HTTP 404", self.problem(status=404, body=b""))
        self.assertIn("nicht lesbar", self.problem(body=b"<html>"))

    def test_nicht_erreichbar(self):
        def boom():
            raise OSError("weg")
        self.assertIn("OSError", ferien_problem(boom, self.TODAY))


class Sommerzeit(unittest.TestCase):
    # 2026-03-29 (Sonntag): 02:00 MEZ springt auf 03:00 MESZ.
    def test_weckruf_in_der_fehlenden_stunde_kommt_um_drei(self):
        r = row(time="02:00", weekdays="7")
        self.assertTrue(is_due(r, dt.datetime(2026, 3, 29, 3, 0, 30, tzinfo=TZ)))
        self.assertFalse(is_due(r, dt.datetime(2026, 3, 29, 4, 0, 30, tzinfo=TZ)))

    def test_normaler_tag_unveraendert(self):
        r = row(time="02:00", weekdays="1234567")
        self.assertTrue(is_due(r, dt.datetime(2026, 3, 28, 2, 59, 30, tzinfo=TZ)))
        self.assertFalse(is_due(r, dt.datetime(2026, 3, 28, 3, 0, 30, tzinfo=TZ)))


class Selbstpruefung(unittest.TestCase):
    def test_auch_wenn_die_minute_verpasst_wurde(self):
        from app import selfcheck_due
        today = dt.date(2026, 10, 5)
        self.assertFalse(selfcheck_due(at(6, 29), None))
        self.assertTrue(selfcheck_due(at(6, 30), None))
        self.assertTrue(selfcheck_due(at(6, 33), today - dt.timedelta(days=1)))
        self.assertFalse(selfcheck_due(at(6, 33), today))


class VersandUndAenderung(MitDb):
    """Schnappschuss der Zeilen vs. Änderungen während des Durchlaufs (#4 S3)."""

    def setUp(self):
        super().setUp()
        self.snap = self.add(morning_time="07:00")

    def test_neue_uhrzeit_bleibt_heute_offen(self):
        self.app.CONN.execute("UPDATE subs SET time = '13:00', last_sent = NULL")
        self.app.mark_sent(self.snap, "2026-10-05")
        self.assertIsNone(self.get()["last_sent"])

    def test_unveraendert_wird_markiert(self):
        self.app.mark_sent(self.snap, "2026-10-05")
        self.assertEqual(self.get()["last_sent"], "2026-10-05")

    def test_morgens_getrennt_markiert(self):
        self.app.mark_sent(self.snap, "2026-10-05", "today")
        self.assertEqual(self.get()["morning_last_sent"], "2026-10-05")
        self.assertIsNone(self.get()["last_sent"])

    def test_neue_morgenzeit_bleibt_heute_offen(self):
        self.app.CONN.execute("UPDATE subs SET morning_time = '06:30'")
        self.app.mark_sent(self.snap, "2026-10-05", "today")
        self.assertIsNone(self.get()["morning_last_sent"])

    def test_410_loescht_kein_erneuertes_abo(self):
        from unittest import mock
        from pywebpush import WebPushException
        self.app.CONN.execute("UPDATE subs SET endpoint = 'https://fcm.googleapis.com/neu'")
        gone = WebPushException("weg", response=mock.Mock(status_code=410))
        with mock.patch.object(self.app, "webpush", side_effect=gone):
            self.assertFalse(self.app.send(self.snap, None))
        self.assertIsNotNone(self.get())
        with mock.patch.object(self.app, "webpush", side_effect=gone):
            self.app.send(self.get(), None)
        self.assertIsNone(self.get())


class AbgelehntesAbo(MitDb):
    """401/403: anderer VAPID-Schlüssel oder eigener JWT-Fehler, gelöscht wird erst nach AUTH_FAIL_DAYS."""

    def setUp(self):
        super().setUp()
        self.snap = self.add(morning_time="07:00")

    def send(self, status, day, row=None):
        from unittest import mock
        from pywebpush import WebPushException
        exc = WebPushException("abgelehnt", response=mock.Mock(status_code=status))
        with mock.patch.object(self.app, "webpush", side_effect=exc), \
                mock.patch.object(self.app.dt, "date", mock.Mock(today=lambda: day)):
            return self.app.send(row or self.get(), None)

    def test_erst_vormerken_dann_loeschen(self):
        start = dt.date(2026, 10, 5)
        self.assertFalse(self.send(403, start))
        self.assertEqual(self.get()["auth_failed_since"], "2026-10-05")
        self.send(401, start + dt.timedelta(days=self.app.AUTH_FAIL_DAYS - 1))
        self.assertEqual(self.get()["auth_failed_since"], "2026-10-05")
        self.send(403, start + dt.timedelta(days=self.app.AUTH_FAIL_DAYS))
        self.assertIsNone(self.get())

    def test_zustellung_hebt_vormerkung_auf(self):
        from unittest import mock
        self.send(403, dt.date(2026, 10, 5))
        with mock.patch.object(self.app, "webpush"):
            self.assertTrue(self.app.send(self.get(), None))
        self.assertIsNone(self.get()["auth_failed_since"])

    def test_erneuertes_abo_bleibt(self):
        self.app.CONN.execute("UPDATE subs SET auth_failed_since = '2026-09-01'")
        self.app.CONN.execute("UPDATE subs SET endpoint = 'https://fcm.googleapis.com/neu'")
        self.send(403, dt.date(2026, 10, 5), self.snap)
        self.assertIsNotNone(self.get())

    def test_andere_fehler_merken_nichts_vor(self):
        self.assertFalse(self.send(500, dt.date(2026, 10, 5)))
        self.assertIsNone(self.get()["auth_failed_since"])


class NeuerSchluessel(unittest.TestCase):
    """Fehlt vapid_private.pem, entsteht ein neuer Schlüssel; bei vorhandenen Abos laut warnen."""

    def setUp(self):
        import tempfile
        from unittest import mock
        import app
        self.app = app
        self.old = getattr(app, "CONN", None)
        self.dir = tempfile.TemporaryDirectory()
        d = self.dir.name
        self.patches = [mock.patch.multiple(app, DATA_DIR=d, DB_PATH=os.path.join(d, "push.sqlite"),
                                            KEY_PATH=os.path.join(d, "vapid_private.pem"))]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        if self.app.CONN is not self.old:
            self.app.CONN.close()
        self.app.CONN = self.old
        self.dir.cleanup()

    def test_ohne_abos_still(self):
        with self.assertNoLogs("push", "WARNING"):
            self.app.init()
        self.assertTrue(os.path.exists(self.app.KEY_PATH))

    def test_mit_abos_warnung(self):
        self.app.init()
        self.app.CONN.execute("INSERT INTO subs (id, secret_hash, endpoint, keys, time, weekdays, tz, created) "
                              "VALUES ('a', 'h', 'https://fcm.googleapis.com/x', '{}', '12:00', '12345', 'Europe/Berlin', '2026-10-05')")
        self.app.CONN.commit()
        self.app.CONN.close()
        with self.assertNoLogs("push", "WARNING"):
            self.app.init()  # Schlüssel noch da
        self.app.CONN.close()
        os.remove(self.app.KEY_PATH)
        with self.assertLogs("push", "WARNING") as logs:
            self.app.init()
        self.assertIn("1 Abos", logs.output[0])


class HttpServer(MitDb):
    """Handler gegen einen echten lokalen Server: kaputte Content-Length, Timeout, Verbindungslimit."""

    def setUp(self):
        import threading
        super().setUp()
        self.app.Handler.vapid = self.vapid
        self.patch = mock.patch.object(self.app.Handler, "timeout", 1)
        self.patch.start()
        for name in ("sub_limit", "admin_limit", "test_limit", "sdui_limit", "sdui_login_limit", "sdui_login_total", "alarm_limit"):
            p = mock.patch.object(self.app, name, self.app.RateLimit(getattr(self.app, name).n, 3600))
            p.start()
            self.addCleanup(p.stop)
        self.srv = self.app.LimitedServer(("127.0.0.1", 0), self.app.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.patch.stop()
        super().tearDown()

    def raw(self, request: bytes, wait=True) -> bytes:
        import socket
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        s.sendall(request)
        if not wait:
            return s
        out = b""
        try:
            while chunk := s.recv(4096):
                out += chunk
        except TimeoutError:
            pass
        s.close()
        return out

    def post(self, length: str, body=b""):
        return self.raw(b"POST /api/subscriptions HTTP/1.1\r\nHost: x\r\nContent-Length: " + length.encode() + b"\r\n\r\n" + body)

    def test_content_length_keine_zahl(self):
        for bad in ("abc", "-5", "1e3", "", "٣"):
            self.assertIn(b" 400 ", self.post(bad).split(b"\r\n")[0], bad)

    def test_content_length_negativ_und_zu_gross_sdui(self):
        json_ct = b"Content-Type: application/json\r\n"
        out = self.raw(b"POST /api/sdui/auth/login HTTP/1.1\r\nHost: x\r\n" + json_ct + b"Content-Length: -1\r\n\r\n")
        self.assertIn(b" 400 ", out.split(b"\r\n")[0])
        out = self.raw(b"POST /api/sdui/auth/login HTTP/1.1\r\nHost: x\r\n" + json_ct + b"Content-Length: 99999\r\n\r\n")
        self.assertIn(b" 413 ", out.split(b"\r\n")[0])

    def test_zu_wenig_bytes_laufen_in_den_timeout(self):
        import time
        t = time.monotonic()
        out = self.post("100", b"{}")
        self.assertIn(b" 400 ", out.split(b"\r\n")[0])
        self.assertLess(time.monotonic() - t, 4)

    def test_verbindungslimit_503(self):
        from unittest import mock
        with mock.patch.object(self.srv, "slots", __import__("threading").BoundedSemaphore(1)):
            hold = self.raw(b"GET /nix HTTP/1.1\r\nHost: x\r\n", wait=False)  # Kopf unvollständig: belegt den Platz
            import time
            time.sleep(0.2)
            out = self.raw(b"GET /nix HTTP/1.1\r\nHost: x\r\n\r\n")
            self.assertTrue(out.startswith(b"HTTP/1.1 503"))
            hold.close()
            time.sleep(0.3)
            self.assertTrue(self.srv.slots.acquire(blocking=False))  # Platz wurde wieder frei

    # --- Handler-Pfade mit Tabelle ---

    def api(self, method, path, body=None, headers=None):
        import http.client
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, json.dumps(body) if body is not None else None, headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, (json.loads(data) if data else None)

    def abo(self, endpoint, headers=None):
        return self.api("POST", "/api/subscriptions", {"subscription": {"endpoint": endpoint, "keys": GOOD_KEYS}}, headers)

    def test_post_uebernimmt_is_admin_nicht(self):
        ep = "https://fcm.googleapis.com/fcm/send/abc"
        st, a = self.abo(ep)
        self.assertEqual(st, 201)
        self.app.CONN.execute("UPDATE subs SET is_admin = 1 WHERE id = ?", (a["id"],))
        st, b = self.abo(ep)
        self.assertEqual(st, 201)
        rows = self.app.CONN.execute("SELECT id, is_admin FROM subs").fetchall()
        self.assertEqual([(r["id"], r["is_admin"]) for r in rows], [(b["id"], 0)])  # altes Abo weg, kein Admin geerbt

    def test_put_endpoint_loescht_altes_abo_ohne_is_admin_erbe(self):
        st, a = self.abo("https://fcm.googleapis.com/fcm/send/a")
        st, b = self.abo("https://fcm.googleapis.com/fcm/send/b")
        self.app.CONN.execute("UPDATE subs SET is_admin = 1 WHERE id = ?", (a["id"],))
        st, _ = self.api("PUT", f"/api/subscriptions/{b['id']}",
                         {"subscription": {"endpoint": "https://fcm.googleapis.com/fcm/send/a", "keys": GOOD_KEYS}},
                         {"Authorization": "Bearer " + b["secret"]})
        self.assertEqual(st, 200)
        rows = self.app.CONN.execute("SELECT id, is_admin FROM subs").fetchall()
        self.assertEqual([(r["id"], r["is_admin"]) for r in rows], [(b["id"], 0)])

    def test_put_endpoint_setzt_fehlschlag_zurueck(self):
        st, a = self.abo("https://fcm.googleapis.com/fcm/send/a")
        self.app.CONN.execute("UPDATE subs SET fail_since = '2026-09-01', auth_failed_since = '2026-09-01'")
        self.app.CONN.commit()
        st, _ = self.api("PUT", f"/api/subscriptions/{a['id']}",
                         {"subscription": {"endpoint": "https://fcm.googleapis.com/fcm/send/neu", "keys": GOOD_KEYS}},
                         {"Authorization": "Bearer " + a["secret"]})
        self.assertEqual(st, 200)
        row = self.app.CONN.execute("SELECT fail_since, auth_failed_since FROM subs").fetchone()
        self.assertEqual(tuple(row), (None, None))

    def test_rate_limit_je_echter_ip(self):
        from unittest import mock
        with mock.patch.object(self.app, "sub_limit", RateLimit(2, 3600)):
            def von(ip, n):
                return self.abo(f"https://fcm.googleapis.com/fcm/send/{n}", {"X-Forwarded-For": ip})[0]
            # Vorangestellter, gefälschter Eintrag ändert den Schlüssel nicht.
            self.assertEqual([von("1.1.1.%d, 9.9.9.9" % i, i) for i in range(3)], [201, 201, 429])
            self.assertEqual(von("1.1.1.1, 8.8.8.8", 10), 201)  # andere echte IP: eigenes Kontingent

    def test_health_ohne_antwortinhalte(self):
        old = dict(self.app.selfcheck_state)
        self.addCleanup(self.app.selfcheck_state.update, old)
        self.app.selfcheck_state.update(ok=False, problems=["IBS5-Login ohne Preflight: HTTP 200, Antwort: 'geheim'", "Sdui nicht erreichbar: URLError"])
        st, out = self.api("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(out["selfcheck"]["problems"], ["IBS5-Login ohne Preflight", "Sdui nicht erreichbar"])
        self.assertNotIn("geheim", json.dumps(out))
        self.assertEqual(out["auth_rejected"], 0)


class Statistik(unittest.TestCase):
    def setUp(self):
        import sqlite3
        import app
        self.app = app
        self.old = getattr(app, "CONN", None)
        app.CONN = sqlite3.connect(":memory:", check_same_thread=False)
        app.CONN.row_factory = sqlite3.Row
        app.CONN.execute("CREATE TABLE subs (id TEXT, endpoint TEXT, morning_time TEXT, created TEXT, auth_failed_since TEXT)")
        app.CONN.execute("CREATE TABLE stats_daily (day TEXT PRIMARY KEY, subs INTEGER NOT NULL, apple INTEGER NOT NULL, morning INTEGER NOT NULL)")
        app.CONN.executemany("INSERT INTO subs VALUES (?, ?, ?, ?, ?)", [
            ("a", "https://web.push.apple.com/geheim-a", "07:00", "2026-10-05", None),
            ("b", "https://fcm.googleapis.com/fcm/send/geheim-b", None, "2026-09-01", "2026-10-04"),
            ("c", "https://updates.push.services.mozilla.com/wpush/v2/geheim-c", None, "2026-10-01", None),
        ])

    def tearDown(self):
        self.app.CONN.close()
        self.app.CONN = self.old

    def test_summen(self):
        out = self.app.stats(dt.date(2026, 10, 7))  # Mittwoch
        self.assertEqual((out["subs"], out["morning"], out["rejected"]), (3, 1, 1))
        self.assertEqual((out["new_7d"], out["new_30d"]), (2, 2))
        self.assertEqual(out["services"], {"apple": 1, "google": 1, "mozilla": 1, "microsoft": 0, "andere": 0})

    def test_keine_einzeldaten(self):
        self.app.stats_snapshot("2026-10-07")
        text = json.dumps(self.app.stats(dt.date(2026, 10, 7)))
        for leak in ("geheim", "push.apple", "07:00", '"a"'):
            self.assertNotIn(leak, text)

    def test_tagesstand_wird_fortgeschrieben(self):
        self.app.stats_snapshot("2026-10-07")
        self.app.CONN.execute("DELETE FROM subs WHERE id = 'a'")
        self.app.stats_snapshot("2026-10-07")
        daily = self.app.stats(dt.date(2026, 10, 7))["daily"]
        self.assertEqual(daily, [{"day": "2026-10-07", "subs": 2, "apple": 0, "morning": 0}])

    def test_fremder_host_ist_andere(self):
        self.assertEqual(self.app.push_service("https://evilpush.apple.com.example/x"), "andere")
        self.assertEqual(self.app.push_service("https://wns2-db5p.notify.windows.com/w/?token=x"), "microsoft")


class ClientIp(unittest.TestCase):
    def test_letzter_eintrag(self):
        from app import client_ip
        self.assertEqual(client_ip({"X-Forwarded-For": "6.6.6.6, 1.2.3.4"}, ("127.0.0.1", 1)), "1.2.3.4")
        self.assertEqual(client_ip({"X-Forwarded-For": " 1.2.3.4 "}, ("127.0.0.1", 1)), "1.2.3.4")

    def test_ohne_header_peer(self):
        from app import client_ip
        self.assertEqual(client_ip({}, ("10.0.0.5", 1)), "10.0.0.5")


class Wochentage(unittest.TestCase):
    def test_bool_ist_kein_wochentag(self):
        with self.assertRaises(BadRequest):
            parse_settings({"weekdays": [True]}, partial=True)
        self.assertEqual(parse_settings({"weekdays": [1, 7]}, partial=True)["weekdays"], "17")


class PushFehlerLog(unittest.TestCase):
    def test_endpoint_nicht_im_log(self):
        import requests
        from unittest import mock
        import app
        url = "https://fcm.googleapis.com/fcm/send/GEHEIMES-TOKEN"
        r = {"id": "a", "endpoint": url, "keys": "{}"}
        for exc in (requests.ConnectionError(url), requests.ReadTimeout(url)):
            with mock.patch.object(app, "webpush", side_effect=exc), mock.patch.object(app, "note_failure"), \
                    self.assertLogs("push", "WARNING") as logs:
                self.assertFalse(app.send(r, None))
            text = "\n".join(logs.output)
            self.assertNotIn("GEHEIMES-TOKEN", text)
            self.assertIn(type(exc).__name__, text)
            self.assertNotIn("Traceback", text)


class HttpAbo(HttpServer):
    """Antworten zu einem Abo, Löschen, Begrenzungen und Fehler im Handler."""

    def neu(self, endpoint="https://fcm.googleapis.com/fcm/send/x"):
        st, out = self.abo(endpoint)
        self.assertEqual(st, 201)
        return out

    def test_is_admin_in_post_put_admin(self):
        a = self.neu()
        self.assertIs(a["is_admin"], False)
        auth = {"Authorization": "Bearer " + a["secret"]}
        st, out = self.api("PUT", f"/api/subscriptions/{a['id']}", {"time": "13:00"}, auth)
        self.assertEqual((st, out), (200, {"is_admin": False}))
        with mock.patch.dict(os.environ, {"ADMIN_KEY": "k" * 32}):
            st, out = self.api("POST", f"/api/subscriptions/{a['id']}/admin", None, {**auth, "X-Admin-Key": "k" * 32})
        self.assertEqual((st, out), (200, {"admin": True, "is_admin": True}))
        st, out = self.api("PUT", f"/api/subscriptions/{a['id']}", {}, auth)
        self.assertEqual((st, out), (200, {"is_admin": True}))

    def test_admin_fehlversuche_begrenzt(self):
        a = self.neu()
        auth = {"Authorization": "Bearer " + a["secret"], "X-Admin-Key": "falsch"}
        with mock.patch.dict(os.environ, {"ADMIN_KEY": "k" * 32}):
            codes = [self.api("POST", f"/api/subscriptions/{a['id']}/admin", None, auth)[0] for _ in range(6)]
        self.assertEqual(codes, [403] * 5 + [429])

    def test_delete(self):
        a = self.neu()
        st, _ = self.api("DELETE", f"/api/subscriptions/{a['id']}", None, {"Authorization": "Bearer falsch"})
        self.assertEqual(st, 404)
        self.assertIsNotNone(self.get(a["id"]))
        st, _ = self.api("DELETE", f"/api/subscriptions/{a['id']}", None, {"Authorization": "Bearer " + a["secret"]})
        self.assertEqual(st, 200)
        self.assertIsNone(self.get(a["id"]))
        st, _ = self.api("DELETE", f"/api/subscriptions/{a['id']}", None, {"Authorization": "Bearer " + a["secret"]})
        self.assertEqual(st, 404)

    def test_hoechstens_fuenf_tests_je_stunde(self):
        a = self.neu()
        auth = {"Authorization": "Bearer " + a["secret"]}
        with mock.patch.object(self.app, "send", return_value=self.app.Sent(True, 201)):
            codes = [self.api("POST", f"/api/subscriptions/{a['id']}/test", {}, auth)[0] for _ in range(6)]
        self.assertEqual(codes, [200] * 5 + [429])

    def test_grenze_nur_fuer_unbestaetigte(self):
        with mock.patch.object(self.app, "MAX_UNCONFIRMED", 2):
            self.neu("https://fcm.googleapis.com/fcm/send/1")
            b = self.neu("https://fcm.googleapis.com/fcm/send/2")
            self.assertEqual(self.abo("https://fcm.googleapis.com/fcm/send/3")[0], 503)
            self.app.CONN.execute("UPDATE subs SET last_ok = '2026-10-05' WHERE id = ?", (b["id"],))
            self.app.CONN.commit()
            self.assertEqual(self.abo("https://fcm.googleapis.com/fcm/send/3")[0], 201)

    def test_rate_limit_je_netz(self):
        with mock.patch.object(self.app, "sub_limit", RateLimit(2, 3600)):
            def von(ip, n):
                return self.abo(f"https://fcm.googleapis.com/fcm/send/{n}", {"X-Forwarded-For": ip})[0]
            self.assertEqual([von("1.1.1.1", 0), von("1.1.1.200", 1), von("1.1.1.7", 2)], [201, 201, 429])
            self.assertEqual(von("1.1.2.1", 3), 201)
            self.assertEqual([von("2001:db8::1", 4), von("2001:db8::ffff:1", 5), von("2001:db8::2", 6)], [201, 201, 429])

    def test_unbehandelte_ausnahme_500_ohne_details(self):
        with mock.patch.object(self.app, "stats", side_effect=RuntimeError("geheim-endpoint")), \
                self.assertLogs("push", "ERROR") as logs:
            st, _ = self.api("GET", "/api/stats")
        self.assertEqual(st, 500)
        self.assertNotIn("geheim", "\n".join(logs.output))
        self.assertIn("RuntimeError", "\n".join(logs.output))

    def test_gesamtfrist_schliesst_troepfelnde_verbindung(self):
        import socket
        import time
        with mock.patch.object(self.app, "REQUEST_DEADLINE", 1):
            s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            s.sendall(b"POST /api/subscriptions HTTP/1.1\r\nHost: x\r\nContent-Length: 50\r\n\r\n{")
            t = time.monotonic()
            # Alle 0,5 s ein Byte: das Socket-Timeout (1 s) läuft so nie ab.
            try:
                while time.monotonic() - t < 4:
                    s.sendall(b" ")
                    time.sleep(0.5)
            except OSError:
                pass
            s.close()
        self.assertLess(time.monotonic() - t, 3.5)

    def test_health(self):
        st, out = self.api("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(out["admins"], 0)
        self.assertEqual(out["warn"], ["keine Betreiber-Abos"])
        for k in ("scheduler_at", "sent_ok", "sent_fail", "gave_up", "auth_rejected"):
            self.assertIn(k, out)
        with mock.patch.object(self.app, "STARTED", self.app.STARTED - 3600), \
                mock.patch.dict(self.app.sched_state, {"mono": None}):
            st, out = self.api("GET", "/api/health")
        self.assertEqual((st, out["problems"]), (503, ["Zeitplan steht"]))

    def test_health_nur_fehlschlaege(self):
        today = dt.datetime.now(TZ).date().isoformat()
        n = self.app.HEALTH_MIN_GAVE_UP
        with mock.patch.dict(self.app.day_counts, {"day": today, "sent_ok": 0, "sent_fail": 5 * n, "gave_up": n}):
            self.assertEqual(self.app.health()[0], 503)
        with mock.patch.dict(self.app.day_counts, {"day": today, "sent_ok": 1, "sent_fail": 99, "gave_up": 99}):
            self.assertEqual(self.app.health()[0], 200)
        # Wenige abgelehnte unter vielen Abos: viele Fehlschläge, aber zu wenige verschiedene Abos.
        for i in range(n):
            self.app.CONN.execute(
                "INSERT INTO subs (id, secret_hash, endpoint, keys, time, weekdays, tz, created, offset_min)"
                " VALUES (?, 'h', ?, '{}', '12:00', '12345', 'Europe/Berlin', '2026-10-05', 0)",
                (f"v{i}", f"https://fcm.googleapis.com/v{i}"))
        self.app.CONN.commit()
        with mock.patch.dict(self.app.day_counts, {"day": today, "sent_ok": 0, "sent_fail": 99, "gave_up": n - 1}):
            self.assertEqual(self.app.health()[0], 200)


class SduiRelay(HttpServer):
    """Fremde Seiten, Content-Type und Login-Begrenzung, ohne Sdui zu erreichen."""

    LOGIN = {"identifier": "a@b.de", "password": "pw", "slink": "schule"}

    def login(self, headers=None, body=None):
        h = {"Content-Type": "application/json", **(headers or {})}
        return self.api("POST", "/api/sdui/auth/login", self.LOGIN if body is None else body, h)

    def sdui_antwortet(self, status):
        import io
        import urllib.error
        def antwort(*a, **kw):
            raise urllib.error.HTTPError("x", status, "x", {}, io.BytesIO(b"{}"))
        return mock.patch.object(self.app.SDUI_OPENER, "open", side_effect=antwort)

    def test_fremde_seite_403(self):
        with self.sdui_antwortet(401) as op:
            for h in ({"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}, {"Origin": "https://evil.example"},
                      {"Origin": "https://sunshine.thomschke.info"}, {"Origin": "null"}):
                with self.subTest(h=h):
                    self.assertEqual(self.login(h)[0], 403)
                    self.assertEqual(self.api("GET", "/api/sdui/users/self", None, h)[0], 403)
            op.assert_not_called()

    def test_eigene_seite_und_ohne_header(self):
        with self.sdui_antwortet(401):
            self.assertEqual(self.login({"Sec-Fetch-Site": "same-origin", "Origin": "https://sunshine-order.de"})[0], 401)
            self.assertEqual(self.login()[0], 401)

    def test_login_nur_als_json(self):
        with self.sdui_antwortet(401) as op:
            st, _ = self.api("POST", "/api/sdui/auth/login", self.LOGIN, {"Content-Type": "text/plain"})
            self.assertEqual(st, 415)
            st, _ = self.api("POST", "/api/sdui/auth/login", self.LOGIN, {"Content-Type": "application/json; charset=utf-8"})
            self.assertEqual(st, 401)
            self.assertEqual(op.call_count, 1)

    def test_login_je_netz_begrenzt_und_401_nur_gezaehlt(self):
        with self.sdui_antwortet(401), self.assertLogs("push", "INFO") as logs:
            codes = [self.login({"X-Forwarded-For": f"5.5.5.{i}"})[0] for i in range(6)]
        self.assertEqual(codes, [401] * 5 + [429])
        text = "\n".join(logs.output)
        self.assertIn("heute", text)
        self.assertNotIn("a@b.de", text)

    def test_login_gesamt_begrenzt_mit_einem_alarm(self):
        with mock.patch.object(self.app, "sdui_login_total", RateLimit(2, 3600)), \
                mock.patch.object(self.app, "alarm") as al, self.sdui_antwortet(401):
            codes = [self.login({"X-Forwarded-For": f"5.5.{i}.1"})[0] for i in range(4)]
            import time
            time.sleep(0.2)
        self.assertEqual(codes, [401, 401, 429, 429])
        self.assertEqual(al.call_count, 1)


class Zeitplan(MitDb):
    """Scheduler.tick: Versuche, Abstände, Fehler je Zeile, Selbstprüfung im eigenen Thread."""

    NOW = dt.datetime(2026, 10, 5, 12, 0, 30, tzinfo=TZ)  # Montag

    def setUp(self):
        super().setUp()
        self.s = self.app.Scheduler(self.vapid)
        self.s.selfcheck_last = self.NOW.date()
        p = mock.patch.object(self.app, "cleanup_subs")  # eigene Tests in Aufraeumen
        p.start()
        self.addCleanup(p.stop)
        self.counts = mock.patch.dict(self.app.day_counts, {"day": None, "sent_ok": 0, "sent_fail": 0, "gave_up": 0})
        self.counts.start()
        self.addCleanup(self.counts.stop)

    def tick(self, minutes=0, result=None):
        result = self.app.Sent(False, 500) if result is None else result
        with mock.patch.object(self.app, "send", return_value=result) as send:
            self.s.tick(self.NOW + dt.timedelta(minutes=minutes))
        return send.call_count

    def test_zustellung_markiert(self):
        self.add()
        self.assertEqual(self.tick(result=self.app.Sent(True, 201)), 1)
        self.assertEqual(self.get()["last_sent"], "2026-10-05")
        self.assertEqual(self.app.day_counts["sent_ok"], 1)

    def test_abstand_waechst_und_nach_send_tries_schluss(self):
        self.add()
        calls = [m for m in range(60) if self.tick(m)]
        self.assertEqual(calls, [0, 1, 3, 7, 15])
        self.assertEqual(len(calls), self.app.SEND_TRIES)
        self.assertIsNone(self.get()["last_sent"], "aufgegeben heißt nicht zugestellt")
        self.assertEqual(self.app.day_counts["sent_fail"], 5)
        self.assertEqual(self.app.day_counts["gave_up"], 1)

    def test_retry_after(self):
        self.add()
        self.tick(0, self.app.Sent(False, 429, retry_after=600))
        self.assertEqual([m for m in range(1, 12) if self.tick(m)], [10])

    def test_abgelehnt_wird_nicht_wiederholt(self):
        self.add(morning_time="12:00")
        with self.assertLogs("push", "WARNING"):
            self.assertEqual(self.tick(0, self.app.Sent(False, 403)), 2)
        self.assertEqual([m for m in range(1, 30) if self.tick(m, self.app.Sent(False, 403))], [])
        # Beide Arten aufgegeben, gezählt wird das Abo einmal.
        self.assertEqual((self.app.day_counts["sent_fail"], self.app.day_counts["gave_up"]), (2, 1))

    def test_wenige_abgelehnte_abos_kein_alarm(self):
        self.app.gave_up_ids.clear()
        self.add("sa", "https://fcm.googleapis.com/sa", weekdays="6")  # heute nicht fällig, also nicht gescheitert
        for i in range(self.app.HEALTH_MIN_GAVE_UP - 1):
            self.add(f"r{i}", f"https://fcm.googleapis.com/r{i}", morning_time="12:00")
        with self.assertLogs("push", "WARNING"):
            for m in range(30):
                self.tick(m, self.app.Sent(False, 401))
        with mock.patch.object(self.app.dt, "datetime", mock.Mock(now=lambda tz=None: self.NOW)):
            self.assertNotIn("heute nur Fehlschläge", self.app.health()[1]["problems"])
        self.add("r9", "https://fcm.googleapis.com/r9")
        with self.assertLogs("push", "WARNING"):
            self.tick(30, self.app.Sent(False, 401))
        with mock.patch.object(self.app.dt, "datetime", mock.Mock(now=lambda tz=None: self.NOW)):
            self.assertIn("heute nur Fehlschläge", self.app.health()[1]["problems"])

    def test_alle_von_wenigen_abos_gescheitert_ist_alarm(self):
        # Bei weniger als HEALTH_MIN_GAVE_UP Abos insgesamt reicht es, wenn alle aufgegeben haben.
        self.app.gave_up_ids.clear()
        for i in range(2):
            self.add(f"w{i}", f"https://fcm.googleapis.com/w{i}")
        with self.assertLogs("push", "WARNING"):
            for m in range(30):
                self.tick(m, self.app.Sent(False, 401))
        with mock.patch.object(self.app.dt, "datetime", mock.Mock(now=lambda tz=None: self.NOW)):
            self.assertIn("heute nur Fehlschläge", self.app.health()[1]["problems"])

    def test_fehler_bei_einem_abo_haelt_die_anderen_nicht_auf(self):
        self.add("a", "https://fcm.googleapis.com/a")
        self.add("b", "https://fcm.googleapis.com/b", tz="Kein/Ort")  # ZoneInfo scheitert erst im Durchlauf
        self.add("c", "https://fcm.googleapis.com/c")
        with self.assertLogs("push", "ERROR") as logs:
            self.assertEqual(self.tick(result=self.app.Sent(True, 201)), 2)
        self.assertIn("Fehler bei Abo b", "\n".join(logs.output))
        self.assertIsNotNone(self.app.sched_state["at"])

    def test_statistik_fehler_haelt_zeitplan_nicht_auf(self):
        self.add()
        with mock.patch.object(self.app, "stats_snapshot", side_effect=RuntimeError), self.assertLogs("push", "ERROR"):
            self.assertEqual(self.tick(result=self.app.Sent(True, 201)), 1)

    def test_selbstpruefung_im_eigenen_thread(self):
        import threading
        self.s.selfcheck_last = None
        gate = threading.Event()
        with mock.patch.object(self.app, "run_selfcheck", side_effect=lambda v: gate.wait(5)) as rs:
            self.s.tick(dt.datetime(2026, 10, 5, 6, 31, tzinfo=TZ))  # kehrt zurück, obwohl die Prüfung noch läuft
            self.assertTrue(self.s.selfcheck_thread.is_alive())
            gate.set()
            self.s.selfcheck_thread.join(5)
        self.assertEqual(rs.call_count, 1)

    def test_totmannschalter(self):
        with mock.patch.dict(os.environ, {"HEARTBEAT_URL": "https://hc.example/x"}), \
                mock.patch.object(self.app, "ping") as p:
            self.tick(0)
            self.tick(1)
            for t in __import__("threading").enumerate():
                if t.name == "heartbeat":
                    t.join(2)
        self.assertEqual(p.call_count, 1)


class Selbstpruefungsalarm(MitDb):
    def test_alarm_an_betreiber_gekuerzt(self):
        self.add("a", "https://fcm.googleapis.com/a", is_admin=1)
        self.add("b", "https://fcm.googleapis.com/b")
        with mock.patch.object(self.app, "selfcheck", return_value=["IBS5 nicht erreichbar: X" * 30]), \
                mock.patch.object(self.app, "send") as send, self.assertLogs("push", "WARNING"):
            self.app.run_selfcheck(self.vapid)
        self.assertEqual(send.call_count, 1)
        row, _, kind, text = send.call_args.args
        self.assertEqual((row["id"], kind), ("a", "alarm"))
        self.assertLessEqual(len(text), self.app.ALARM_MAX)
        self.assertFalse(self.app.selfcheck_state["ok"])

    def test_ausnahme_wird_geloggt(self):
        with mock.patch.object(self.app, "selfcheck", side_effect=OSError), self.assertLogs("push", "ERROR"):
            self.app.run_selfcheck(self.vapid)


class Versand(MitDb):
    def test_payload_und_logzeile(self):
        self.add(endpoint="https://fcm.googleapis.com/fcm/send/GEHEIM")
        resp = mock.Mock(status_code=201, headers={"Location": "https://fcm.googleapis.com/0:123%abc"})
        with mock.patch.object(self.app, "webpush", return_value=resp) as wp, self.assertLogs("push", "INFO") as logs:
            self.assertTrue(self.app.send(self.get(), None, "check"))
        payload = json.loads(wp.call_args.kwargs["data"])
        self.assertEqual(payload["t"], "check")
        self.assertIsInstance(payload["sent"], int)
        text = "\n".join(logs.output)
        self.assertIn("HTTP 201", text)
        self.assertIn("0:123%abc", text)
        self.assertNotIn("GEHEIM", text)
        self.assertEqual(self.get()["last_ok"], dt.date.today().isoformat())

    def test_location_mit_token_wird_nicht_geloggt(self):
        self.assertEqual(self.app.msg_ref(mock.Mock(headers={"Location": "https://x/GEHEIM"}), "https://x/GEHEIM"), "")
        self.assertEqual(self.app.msg_ref(mock.Mock(headers={"apns-id": "ABC"}), "https://x/y"), "ABC")

    def test_alarmtext_gekuerzt(self):
        self.add()
        with mock.patch.object(self.app, "webpush") as wp:
            self.app.send(self.get(), None, "alarm", "x" * 500)
        self.assertEqual(len(json.loads(wp.call_args.kwargs["data"])["m"]), self.app.ALARM_MAX)

    def test_retry_after_wird_gelesen(self):
        from pywebpush import WebPushException
        self.add()
        exc = WebPushException("x", response=mock.Mock(status_code=429, headers={"Retry-After": "120"}))
        with mock.patch.object(self.app, "webpush", side_effect=exc), self.assertLogs("push", "WARNING"):
            res = self.app.send(self.get(), None)
        self.assertEqual((bool(res), res.status, res.retry_after), (False, 429, 120.0))

    def test_secure_delete(self):
        self.assertEqual(self.app.CONN.execute("PRAGMA secure_delete").fetchone()[0], 1)


class Migration(unittest.TestCase):
    """init() auf alten Schemata: jede Spalte einzeln, Datenumstellung genau einmal (user_version)."""

    def setUp(self):
        import sqlite3
        import app
        self.app, self.sqlite3 = app, sqlite3
        self.old = getattr(app, "CONN", None)
        self.dir = tempfile.TemporaryDirectory()
        d = self.dir.name
        self.db = os.path.join(d, "push.sqlite")
        p = mock.patch.multiple(app, DATA_DIR=d, DB_PATH=self.db, KEY_PATH=os.path.join(d, "vapid_private.pem"))
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        if self.app.CONN is not self.old:
            self.app.CONN.close()
        self.app.CONN = self.old
        self.dir.cleanup()

    def alt(self, extra_cols=""):
        c = self.sqlite3.connect(self.db)
        c.execute("CREATE TABLE subs (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL, "
                  "time TEXT NOT NULL, weekdays TEXT NOT NULL, tz TEXT NOT NULL, last_sent TEXT, created TEXT NOT NULL" + extra_cols + ")")
        c.execute("INSERT INTO subs (id, secret_hash, endpoint, keys, time, weekdays, tz, created) "
                  "VALUES ('a', 'h', 'https://fcm.googleapis.com/x', '{}', '12:00', '12345', 'Europe/Berlin', '2026-01-01')")
        c.commit()
        c.close()

    def test_aeltestes_schema(self):
        self.alt()
        self.app.init()
        cols = {r[1] for r in self.app.CONN.execute("PRAGMA table_info(subs)")}
        self.assertTrue({c for c, _ in self.app.SUBS_COLUMNS} <= cols)
        row = self.app.CONN.execute("SELECT * FROM subs").fetchone()
        self.assertEqual(row["last_ok"], dt.date.today().isoformat())  # Bestand gilt als bestätigt
        self.assertIn(row["offset_min"], range(self.app.MAX_OFFSET_MIN + 1))
        self.assertEqual(self.app.CONN.execute("PRAGMA user_version").fetchone()[0], self.app.SCHEMA_VERSION)

    def test_von_version_2(self):
        # Stand mit last_ok, ohne fail_since: last_ok bleibt, fail_since kommt leer dazu.
        self.alt(", offset_min INTEGER, is_admin INTEGER NOT NULL DEFAULT 0, morning_time TEXT, morning_last_sent TEXT, "
                 "auth_failed_since TEXT, last_ok TEXT")
        c = self.sqlite3.connect(self.db)
        c.execute("UPDATE subs SET last_ok = '2026-09-01'")
        c.execute("PRAGMA user_version = 2")
        c.commit()
        c.close()
        self.app.init()
        row = self.app.CONN.execute("SELECT last_ok, fail_since FROM subs").fetchone()
        self.assertEqual(tuple(row), ("2026-09-01", None))
        self.assertEqual(self.app.CONN.execute("PRAGMA user_version").fetchone()[0], 3)

    def test_halb_migriert(self):
        # morning_time da, morning_last_sent fehlt: früher nur an morning_time geprüft.
        self.alt(", offset_min INTEGER, morning_time TEXT")
        self.app.init()
        cols = {r[1] for r in self.app.CONN.execute("PRAGMA table_info(subs)")}
        self.assertIn("morning_last_sent", cols)

    def test_neue_abos_bleiben_unbestaetigt(self):
        self.app.init()
        self.app.CONN.execute("INSERT INTO subs (id, secret_hash, endpoint, keys, time, weekdays, tz, created) "
                              "VALUES ('n', 'h', 'https://fcm.googleapis.com/n', '{}', '12:00', '12345', 'Europe/Berlin', '2026-10-05')")
        self.app.CONN.commit()
        self.app.CONN.close()
        self.app.init()
        self.assertIsNone(self.app.CONN.execute("SELECT last_ok FROM subs").fetchone()[0])

    def test_fehler_rollt_alles_zurueck(self):
        self.alt()
        c = self.sqlite3.connect(self.db)
        c.row_factory = self.sqlite3.Row
        with mock.patch.object(self.app, "SUBS_COLUMNS", self.app.SUBS_COLUMNS + [("kaputt", "NICHT GÜLTIG (")]), \
                self.assertRaises(self.sqlite3.OperationalError):
            self.app.migrate(c, dt.date(2026, 10, 5))
        cols = {r[1] for r in c.execute("PRAGMA table_info(subs)")}
        self.assertNotIn("offset_min", cols)
        self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], 0)
        c.close()


class Aufraeumen(MitDb):
    TODAY = dt.date(2026, 10, 15)  # Donnerstag

    def setUp(self):
        super().setUp()
        self.add("ok", "https://fcm.googleapis.com/ok", last_ok="2026-10-14")

    def ids(self):
        return {r[0] for r in self.app.CONN.execute("SELECT id FROM subs")}

    def days_ago(self, n):
        return (self.TODAY - dt.timedelta(days=n)).isoformat()

    def test_unbestaetigt_nach_zwei_tagen(self):
        self.add("neu", "https://fcm.googleapis.com/neu", created="2026-10-13", fail_since="2026-10-14")  # Di, erster Weckruf Mi
        self.add("alt", "https://fcm.googleapis.com/alt", created="2026-10-12", fail_since="2026-10-13")  # Mo
        with self.assertLogs("push", "INFO"):
            self.app.cleanup_subs(self.TODAY)
        self.assertEqual(self.ids(), {"ok", "neu"})

    def test_nur_samstags_wartet_bis_nach_dem_samstag(self):
        # Mo, erster Weckruf Sa 17.; der Test-Push beim Anlegen scheiterte schon.
        self.add("sa", "https://fcm.googleapis.com/sa", created="2026-10-12", weekdays="6", fail_since="2026-10-12")
        self.app.CONN.execute("UPDATE subs SET last_ok = '2026-10-18' WHERE id = 'ok'")
        self.app.cleanup_subs(dt.date(2026, 10, 18))
        self.assertIn("sa", self.ids())
        with self.assertLogs("push", "INFO"):
            self.app.cleanup_subs(dt.date(2026, 10, 19))
        self.assertNotIn("sa", self.ids())

    def test_lange_ohne_zustellung(self):
        self.add("still", "https://fcm.googleapis.com/still", last_ok=self.days_ago(20), fail_since=self.days_ago(15))
        self.add("knapp", "https://fcm.googleapis.com/knapp", last_ok=self.days_ago(20), fail_since=self.days_ago(14))
        with self.assertLogs("push", "INFO"):
            self.app.cleanup_subs(self.TODAY)
        self.assertEqual(self.ids(), {"ok", "knapp"})

    def test_ohne_versuch_bleibt(self):
        # Älterer Stand (Rollback) setzt weder last_ok noch fail_since; der Dienst stand länger.
        self.add("rollback", "https://fcm.googleapis.com/rb", created=self.days_ago(10))
        self.add("pause", "https://fcm.googleapis.com/pause", last_ok=self.days_ago(30))
        self.app.cleanup_subs(self.TODAY)
        self.assertEqual(self.ids(), {"ok", "rollback", "pause"})

    def test_fristen_ab_dienststart(self):
        self.add("still", "https://fcm.googleapis.com/still", last_ok=self.days_ago(30), fail_since=self.days_ago(20))
        self.add("neu", "https://fcm.googleapis.com/neu", created=self.days_ago(10), fail_since=self.days_ago(9))
        self.app.cleanup_subs(self.TODAY, started=self.TODAY - dt.timedelta(days=1))
        self.assertEqual(self.ids(), {"ok", "still", "neu"})
        with self.assertLogs("push", "INFO"):
            self.app.cleanup_subs(self.TODAY, started=self.TODAY - dt.timedelta(days=3))
        self.assertEqual(self.ids(), {"ok", "still"})
        with self.assertLogs("push", "INFO"):
            self.app.cleanup_subs(self.TODAY, started=self.TODAY - dt.timedelta(days=15))
        self.assertEqual(self.ids(), {"ok"})

    def test_inzwischen_zugestellt_bleibt(self):
        self.add("still", "https://fcm.googleapis.com/still", last_ok=self.days_ago(30), fail_since=self.days_ago(20))
        real = self.app.CONN.execute

        def zugestellt_vor_dem_loeschen(sql, *args):
            if sql.startswith("DELETE"):
                real("UPDATE subs SET last_ok = ?, fail_since = NULL WHERE id = 'still'", (self.TODAY.isoformat(),))
            return real(sql, *args)
        with mock.patch.object(self.app, "CONN", mock.Mock(wraps=self.app.CONN, execute=zugestellt_vor_dem_loeschen)), \
                self.assertLogs("push", "INFO"):
            self.app.cleanup_subs(self.TODAY)
        self.assertIn("still", self.ids())

    def test_nichts_loeschen_wenn_gar_nichts_mehr_ankommt(self):
        self.app.CONN.execute("UPDATE subs SET last_ok = '2026-09-01'")
        self.add("neu", "https://fcm.googleapis.com/neu", created="2026-10-01", fail_since="2026-10-02")
        with self.assertLogs("push", "WARNING"):
            self.assertEqual(self.app.cleanup_subs(self.TODAY), 0)
        self.assertEqual(self.ids(), {"ok", "neu"})


class FehlschlagSeit(MitDb):
    """fail_since: erster gescheiterter Versand seit der letzten Zustellung."""

    def send(self, day, exc=None):
        with mock.patch.object(self.app, "webpush", side_effect=exc), \
                mock.patch.object(self.app.dt, "date", mock.Mock(today=lambda: day)):
            return self.app.send(self.get(), None)

    def test_erster_fehlschlag_bleibt_zustellung_loescht(self):
        import requests
        from pywebpush import WebPushException
        self.add()
        with self.assertLogs("push", "WARNING"):
            self.send(dt.date(2026, 10, 5), WebPushException("x", response=mock.Mock(status_code=500, headers={})))
            self.send(dt.date(2026, 10, 6), requests.ConnectionError("x"))
            self.send(dt.date(2026, 10, 7), WebPushException("x", response=mock.Mock(status_code=403)))
        self.assertEqual(self.get()["fail_since"], "2026-10-05")
        self.assertTrue(self.send(dt.date(2026, 10, 8)))
        self.assertIsNone(self.get()["fail_since"])
        self.assertEqual(self.get()["last_ok"], "2026-10-08")


class NetzSchluessel(unittest.TestCase):
    def test_praefixe(self):
        from app import net_key
        self.assertEqual(net_key("1.2.3.4"), "1.2.3.0/24")
        self.assertEqual(net_key("1.2.3.4", 32), "1.2.3.4/32")
        self.assertEqual(net_key("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64")
        self.assertEqual(net_key("2001:db8:1:2:3:4:5:6", 32), "2001:db8:1:2::/64")
        self.assertEqual(net_key("::ffff:1.2.3.4"), "1.2.3.0/24")
        self.assertEqual(net_key("kaputt"), "kaputt")


class RateLimitLru(unittest.TestCase):
    def test_obergrenze_schluessel(self):
        rl = RateLimit(1, 3600, max_keys=3)
        for k in "abcd":
            rl.allow(k)
        self.assertEqual(list(rl.hits), ["b", "c", "d"])
        self.assertTrue(rl.allow("a"))  # vergessen: wieder frei

    def test_abgelaufene_vorne_raeumen(self):
        import time
        rl = RateLimit(1, 0.05)
        rl.allow("a")
        time.sleep(0.06)
        rl.allow("b")
        self.assertEqual(list(rl.hits), ["b"])


class StatistikSchreibtNurBeiAenderung(MitDb):
    def test_unveraendert_kein_schreiben(self):
        self.add()
        self.app.stats_snapshot("2026-10-07")
        before = self.app.CONN.total_changes
        self.app.stats_snapshot("2026-10-07")
        self.assertEqual(self.app.CONN.total_changes, before)


class Vertrag(unittest.TestCase):
    """Jede Art, die der Server verschickt, muss der Service Worker kennen (web/push.js: PUSH_KINDS)."""

    def test_push_kinds(self):
        import app
        # Im Repo liegt die Datei unter server/push/, im Docker-Build flach unter /app/.
        parents = Path(__file__).resolve().parents
        src = parents[2] / "web" / "push.js" if len(parents) > 2 else None
        m = re.search(r"^export const PUSH_KINDS = \[([^\]]*)\]", src.read_text(encoding="utf-8"), re.M) if src and src.exists() else None
        if not m:
            self.skipTest("web/push.js ohne `export const PUSH_KINDS = [...]` (im Docker-Build liegt web/ nicht bei)")
        kinds = set(re.findall(r"""["']([\w-]+)["']""", m.group(1)))
        sent = set(app.SLOTS) | {"test", "today-test", "alarm"}
        self.assertLessEqual(sent, kinds)


if __name__ == "__main__":
    unittest.main()
