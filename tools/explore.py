#!/usr/bin/env python3
"""One-off: dump the authenticated IBS5 responses so the parser can be calibrated.

Writes into ./dumps/ (git-ignored). The session token, mail addresses and
IBAN-like strings are masked before anything hits the disk; Name, Einrichtung
and Kontostand are *not* masked — the dumps stay local, do not commit them.

    python3 tools/explore.py
"""

from __future__ import annotations

import datetime as dt
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ibswatch.client import IbsClient, IbsError  # noqa: E402
from ibswatch.config import Config, ConfigError, netrc_credentials  # noqa: E402

DUMP_DIR = Path(__file__).resolve().parent.parent / "dumps"

_MAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_IBAN = re.compile(r"\b[A-Z]{2}\d{2}[ ]?[\dA-Z]{4}(?:[ ]?[\dA-Z]{4}){2,5}\b")


def redact(text: str, token: str | None) -> str:
    if token:
        text = text.replace(token, "<TOKEN>")
    text = _MAIL.sub("<MAIL>", text)
    return _IBAN.sub("<IBAN>", text)


def dump(name: str, text: str, token: str | None) -> None:
    DUMP_DIR.mkdir(exist_ok=True)
    path = DUMP_DIR / name
    path.write_text(redact(text, token), encoding="utf-8")
    print(f"  {path.relative_to(Path.cwd()) if path.is_relative_to(Path.cwd()) else path}"
          f"  ({len(text):,} bytes)")


def main() -> int:
    try:
        cfg = Config.load()
    except ConfigError:
        cfg = Config()  # exploration works without a config.toml

    try:
        customer_no, password = netrc_credentials(cfg.netrc_machine)
        client = IbsClient(base_url=cfg.base_url)
        profile = client.login(customer_no, password)
    except (ConfigError, IbsError) as exc:
        print(f"Login fehlgeschlagen: {exc}", file=sys.stderr)
        return 1

    print(f"Angemeldet als {profile.get('name1')} / {profile.get('institutionName1')}")
    print("Profil-Felder:", ", ".join(sorted(profile)))

    today = dt.date.today()
    monday = today - dt.timedelta(days=today.weekday())
    iso = today.isocalendar()

    targets = [
        ("weekplan_current.html", lambda: client.weekplan()),
        ("weekplan_by_week.html", lambda: client.weekplan(year=iso.year, week=iso.week)),
        ("weekplan_next_week.html", lambda: client.weekplan(year=iso.year, week=iso.week + 1)),
        ("weekplan_mobile.html", lambda: client.weekplan_mobile(today)),
        ("orderhistory.html", lambda: client.orderhistory(monday - dt.timedelta(days=14),
                                                          monday + dt.timedelta(days=14))),
        ("balance_and_cart.json", lambda: client.balance_and_cart()),
    ]

    for name, fetch in targets:
        try:
            dump(name, fetch(), client.token)
        except IbsError as exc:
            print(f"  {name}: FEHLER — {exc}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
