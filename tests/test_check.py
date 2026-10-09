"""Tests für Prüffenster, Exitcodes beim Mailversand und netrc-Auflösung."""

import datetime as dt
import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ibswatch import check  # noqa: E402
from ibswatch.config import Config, ConfigError, SmtpConfig, netrc_credentials  # noqa: E402
from ibswatch.parser import parse_weekplan  # noqa: E402

FIXTURE = (Path(__file__).parent / "fixtures" / "weekplan_kw35.html").read_text(encoding="utf-8")


class TargetDatesTest(unittest.TestCase):
    def test_friday_checks_monday_and_tuesday(self):
        dates = check.target_dates(Config(), dt.date(2026, 8, 28))  # Freitag
        self.assertEqual(dates, [dt.date(2026, 8, 31), dt.date(2026, 9, 1)])

    def test_weekday_window(self):
        dates = check.target_dates(Config(), dt.date(2026, 8, 24))  # Montag
        self.assertEqual(dates, [dt.date(2026, 8, 25), dt.date(2026, 8, 26)])

    def test_include_today_and_empty_weekdays(self):
        cfg = Config(include_today=True, days_ahead=1)
        self.assertEqual(check.target_dates(cfg, dt.date(2026, 8, 24)), [dt.date(2026, 8, 24)])
        self.assertEqual(check.target_dates(Config(weekdays=[]), dt.date(2026, 8, 24)), [])


class _Client:
    def __init__(self, html):
        self.html = html

    def login(self, *_):
        return {}

    def weekplan(self, year, week):
        return self.html


NOTHING_ORDERED = FIXTURE.replace('data-order-status="2"', 'data-order-status="0"').replace(
    'data-quantity-ordered="1"', 'data-quantity-ordered=""')


class MailExitCodeTest(unittest.TestCase):
    def _run(self, cfg, html):
        err = io.StringIO()
        with mock.patch.object(check, "netrc_credentials", return_value=("u", "p")), \
                mock.patch.object(check, "IbsClient", lambda base_url: _Client(html)), \
                redirect_stdout(io.StringIO()), redirect_stderr(err):
            code = check.run(cfg, dt.date(2026, 8, 26))  # prüft Do 27. und Fr 28.
        return code, err.getvalue()

    def test_missing_smtp_config_exits_nonzero_on_stderr(self):
        html = NOTHING_ORDERED
        code, err = self._run(Config(), html)
        self.assertEqual(code, check.EXIT_MAIL_FAILED)
        self.assertIn("SMTP nicht konfiguriert", err)

    def test_smtp_error_exits_nonzero(self):
        cfg = Config(smtp=SmtpConfig(host="h", mail_from="a@b", mail_to=["c@d"]))
        html = NOTHING_ORDERED
        with mock.patch("ibswatch.notify.netrc_credentials", return_value=("u", "p")), \
                mock.patch("ibswatch.notify.smtplib.SMTP", side_effect=OSError("down")):
            code, err = self._run(cfg, html)
        self.assertEqual(code, check.EXIT_MAIL_FAILED)
        self.assertIn("Mailversand fehlgeschlagen", err)

    def test_nothing_to_report_needs_no_smtp(self):
        code, _ = self._run(Config(), FIXTURE)
        self.assertEqual(code, 0)

    def test_dry_run_succeeds_without_smtp(self):
        html = NOTHING_ORDERED
        with mock.patch.object(check, "netrc_credentials", return_value=("u", "p")), \
                mock.patch.object(check, "IbsClient", lambda base_url: _Client(html)), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(check.run(Config(), dt.date(2026, 8, 26), dry_run=True), 0)


class NetrcTest(unittest.TestCase):
    def _creds(self, content, machine):
        with tempfile.TemporaryDirectory() as home:
            path = Path(home) / ".netrc"
            path.write_text(content, encoding="utf-8")
            path.chmod(0o600)
            with mock.patch.dict(os.environ, {"HOME": home}):
                return netrc_credentials(machine)

    def test_exact_host_entry(self):
        self.assertEqual(
            self._creds("machine a.example login u password p\n", "a.example"), ("u", "p"))

    def test_default_entry_is_not_used(self):
        with self.assertRaises(ConfigError):
            self._creds("default login x password y\n", "a.example")


if __name__ == "__main__":
    unittest.main()
