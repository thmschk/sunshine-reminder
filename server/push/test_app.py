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
