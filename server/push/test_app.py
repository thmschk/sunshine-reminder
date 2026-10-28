"""Fälligkeit der Weckrufe: python3 -m unittest test_app (im Container oder mit pywebpush installiert)."""
import base64
import datetime as dt
import json
import os
import unittest
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from app import (
    SDUI_OPENER, BadRequest, RateLimit, check_endpoint, check_keys, ferien_problem, is_due, parse_settings, sdui_login_body, sdui_route_ok,
)

TZ = ZoneInfo("Europe/Berlin")


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


if __name__ == "__main__":
    unittest.main()


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
            self.assertEqual(ctx.exception.code, 302)
            self.assertEqual(seen, [], "Umleitungsziel darf nicht aufgerufen werden")
        finally:
            ziel.shutdown()
            quelle.shutdown()


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


class VersandUndAenderung(unittest.TestCase):
    """Schnappschuss der Zeilen vs. Änderungen während des Durchlaufs (#4 S3)."""

    def setUp(self):
        import sqlite3
        import app
        self.app = app
        self.old = getattr(app, "CONN", None)
        app.CONN = sqlite3.connect(":memory:", check_same_thread=False)
        app.CONN.row_factory = sqlite3.Row
        app.CONN.execute("CREATE TABLE subs (id TEXT, endpoint TEXT, keys TEXT, time TEXT, last_sent TEXT, "
                         "morning_time TEXT, morning_last_sent TEXT, auth_failed_since TEXT)")
        app.CONN.execute("INSERT INTO subs VALUES ('a', 'https://fcm.googleapis.com/alt', '{}', '12:00', NULL, '07:00', NULL, NULL)")
        self.snap = app.CONN.execute("SELECT * FROM subs").fetchone()

    def tearDown(self):
        self.app.CONN.close()
        self.app.CONN = self.old

    def get(self):
        return self.app.CONN.execute("SELECT * FROM subs WHERE id = 'a'").fetchone()

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


class AbgelehntesAbo(unittest.TestCase):
    """401/403: anderer VAPID-Schlüssel oder eigener JWT-Fehler, gelöscht wird erst nach AUTH_FAIL_DAYS."""

    setUp, tearDown, get = VersandUndAenderung.setUp, VersandUndAenderung.tearDown, VersandUndAenderung.get

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


class HttpServer(unittest.TestCase):
    """Handler gegen einen echten lokalen Server: kaputte Content-Length, Timeout, Verbindungslimit."""

    def setUp(self):
        import sqlite3
        import threading
        from unittest import mock
        import app
        self.app = app
        self.old = getattr(app, "CONN", None)
        app.CONN = sqlite3.connect(":memory:", check_same_thread=False)
        app.CONN.row_factory = sqlite3.Row
        self.patch = mock.patch.object(app.Handler, "timeout", 1)
        self.patch.start()
        self.srv = app.LimitedServer(("127.0.0.1", 0), app.Handler)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.patch.stop()
        self.app.CONN.close()
        self.app.CONN = self.old

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
        out = self.raw(b"POST /api/sdui/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n")
        self.assertIn(b" 400 ", out.split(b"\r\n")[0])
        out = self.raw(b"POST /api/sdui/auth/login HTTP/1.1\r\nHost: x\r\nContent-Length: 99999\r\n\r\n")
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

    def tabelle(self):
        self.app.CONN.execute(
            "CREATE TABLE subs (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL, "
            "time TEXT NOT NULL, weekdays TEXT NOT NULL, tz TEXT NOT NULL, last_sent TEXT, created TEXT NOT NULL, offset_min INTEGER, "
            "is_admin INTEGER NOT NULL DEFAULT 0, morning_time TEXT, morning_last_sent TEXT, auth_failed_since TEXT)")

    def abo(self, endpoint, headers=None):
        return self.api("POST", "/api/subscriptions", {"subscription": {"endpoint": endpoint, "keys": GOOD_KEYS}}, headers)

    def test_post_uebernimmt_is_admin_nicht(self):
        self.tabelle()
        ep = "https://fcm.googleapis.com/fcm/send/abc"
        st, a = self.abo(ep)
        self.assertEqual(st, 201)
        self.app.CONN.execute("UPDATE subs SET is_admin = 1 WHERE id = ?", (a["id"],))
        st, b = self.abo(ep)
        self.assertEqual(st, 201)
        rows = self.app.CONN.execute("SELECT id, is_admin FROM subs").fetchall()
        self.assertEqual([(r["id"], r["is_admin"]) for r in rows], [(b["id"], 0)])  # altes Abo weg, kein Admin geerbt

    def test_put_endpoint_loescht_altes_abo_ohne_is_admin_erbe(self):
        self.tabelle()
        st, a = self.abo("https://fcm.googleapis.com/fcm/send/a")
        st, b = self.abo("https://fcm.googleapis.com/fcm/send/b")
        self.app.CONN.execute("UPDATE subs SET is_admin = 1 WHERE id = ?", (a["id"],))
        st, _ = self.api("PUT", f"/api/subscriptions/{b['id']}",
                         {"subscription": {"endpoint": "https://fcm.googleapis.com/fcm/send/a", "keys": GOOD_KEYS}},
                         {"Authorization": "Bearer " + b["secret"]})
        self.assertEqual(st, 200)
        rows = self.app.CONN.execute("SELECT id, is_admin FROM subs").fetchall()
        self.assertEqual([(r["id"], r["is_admin"]) for r in rows], [(b["id"], 0)])

    def test_rate_limit_je_echter_ip(self):
        from unittest import mock
        self.tabelle()
        with mock.patch.object(self.app, "sub_limit", RateLimit(2, 3600)):
            def von(ip, n):
                return self.abo(f"https://fcm.googleapis.com/fcm/send/{n}", {"X-Forwarded-For": ip})[0]
            # Vorangestellter, gefälschter Eintrag ändert den Schlüssel nicht.
            self.assertEqual([von("1.1.1.%d, 9.9.9.9" % i, i) for i in range(3)], [201, 201, 429])
            self.assertEqual(von("1.1.1.1, 8.8.8.8", 10), 201)  # andere echte IP: eigenes Kontingent

    def test_health_ohne_antwortinhalte(self):
        self.tabelle()
        old = dict(self.app.selfcheck_state)
        self.addCleanup(self.app.selfcheck_state.update, old)
        self.app.selfcheck_state.update(ok=False, problems=["IBS5-Login ohne Preflight: HTTP 200, Antwort: 'geheim'", "Sdui nicht erreichbar: URLError"])
        st, out = self.api("GET", "/api/health")
        self.assertEqual(st, 200)
        self.assertEqual(out["selfcheck"]["problems"], ["IBS5-Login ohne Preflight", "Sdui nicht erreichbar"])
        self.assertNotIn("geheim", json.dumps(out))
        self.assertEqual(out["auth_rejected"], 0)


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
            with mock.patch.object(app, "webpush", side_effect=exc), self.assertLogs("push", "WARNING") as logs:
                self.assertFalse(app.send(r, None))
            text = "\n".join(logs.output)
            self.assertNotIn("GEHEIMES-TOKEN", text)
            self.assertIn(type(exc).__name__, text)
            self.assertNotIn("Traceback", text)
