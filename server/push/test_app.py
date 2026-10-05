"""Fälligkeit der Weckrufe: python3 -m unittest test_app (im Container oder mit pywebpush installiert)."""
import datetime as dt
import unittest
from zoneinfo import ZoneInfo

from app import is_due

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
        app.sdui_hits.clear()
        results = [app.sdui_allowed("1.2.3.4") for _ in range(25)]
        self.assertEqual(results.count(True), 20)
        self.assertTrue(app.sdui_allowed("5.6.7.8"))
