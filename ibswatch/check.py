"""Entry point: log in, look at the coming days, complain if nothing is ordered.

Three outcomes, deliberately kept apart:

    OK       — every relevant day is either ordered or has no offer
    ALARM    — at least one day is offered but not ordered  → reminder mail
    FAILED   — login/network/parser problem                 → error mail (optional)

A FAILED run must never look like an ALARM: "kein Essen bestellt" is only ever
said about a day the checker actually managed to look at.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from zoneinfo import ZoneInfo

from .client import IbsClient, IbsError
from .config import Config, ConfigError, netrc_credentials
from .notify import send_mail
from .parser import DayStatus, OrderState, ParserNotCalibrated, parse_weekplan


def notify(cfg: Config, subject: str, body: str, dry_run: bool) -> None:
    """Mail senden, aber ein SMTP-Problem nie das Ergebnis verschlucken lassen."""
    try:
        send_mail(cfg, subject, body, dry_run=dry_run)
    except Exception as exc:  # smtplib, DNS, netrc — alles gleich behandelt
        print(f"Mailversand fehlgeschlagen ({type(exc).__name__}: {exc})", file=sys.stderr)
        print(f"Nicht zugestellte Nachricht: {subject}\n{body}", file=sys.stderr)


def target_dates(cfg: Config, today: dt.date) -> list[dt.date]:
    """The days this run cares about: the next `days_ahead` days, weekdays only."""
    start = 0 if cfg.include_today else 1
    days = (today + dt.timedelta(days=offset) for offset in range(start, cfg.days_ahead + 1))
    return [d for d in days if d.isoweekday() in cfg.weekdays]


def collect_status(client: IbsClient, dates: list[dt.date]) -> dict[dt.date, DayStatus]:
    """Fetch every ISO week the target dates fall into and parse it."""
    status: dict[dt.date, DayStatus] = {}
    for year, week in sorted({(d.isocalendar().year, d.isocalendar().week) for d in dates}):
        status.update(parse_weekplan(client.weekplan(year=year, week=week)))
    return status


def run(cfg: Config, today: dt.date, dry_run: bool = False) -> int:
    dates = target_dates(cfg, today)
    if not dates:
        print("Keine relevanten Tage im Prüffenster — nichts zu tun.")
        return 0

    print("Prüfe: " + ", ".join(f"{d:%a %d.%m.}" for d in dates))

    try:
        customer_no, password = netrc_credentials(cfg.netrc_machine)
        client = IbsClient(base_url=cfg.base_url)
        profile = client.login(customer_no, password)
        print(f"Angemeldet als {profile.get('name1', '?')} ({profile.get('institutionName1', '?')})")
        status = collect_status(client, dates)
    except (IbsError, ConfigError, ParserNotCalibrated) as exc:
        detail = f"{type(exc).__name__}: {exc}"
        print(f"PRÜFUNG FEHLGESCHLAGEN — {detail}", file=sys.stderr)
        if cfg.notify_on_error:
            notify(
                cfg,
                "[IBS] Bestellprüfung fehlgeschlagen",
                "Die Bestellprüfung konnte nicht durchgeführt werden.\n"
                "Es ist damit UNBEKANNT, ob Essen bestellt ist.\n\n"
                f"{detail}\n",
                dry_run=dry_run,
            )
        return 2

    missing: list[DayStatus] = []
    unknown: list[dt.date] = []
    for date in dates:
        day = status.get(date)
        if day is None:
            unknown.append(date)
            print(f"{date:%a %d.%m.%Y}: nicht im Wochenplan gefunden")
            continue
        print(str(day))
        if day.state is OrderState.NOT_ORDERED:
            missing.append(day)
        elif day.state is OrderState.UNKNOWN:
            unknown.append(date)

    if missing:
        lines = "\n".join(f"  - {d.date:%A, %d.%m.%Y}" for d in missing)
        notify(
            cfg,
            "[IBS] Kein Essen bestellt",
            "Für folgende Tage ist im Bestellsystem kein Essen bestellt:\n\n"
            f"{lines}\n\nBestellen: {cfg.base_url}\n",
            dry_run=dry_run,
        )

    if unknown:
        # Not an alarm — but not silence either. A watchdog whose failure mode
        # is "says nothing" is worse than no watchdog: cron swallows exit codes.
        days = ", ".join(f"{d:%a %d.%m.%Y}" for d in unknown)
        print(f"Status unklar für: {days}", file=sys.stderr)
        if cfg.notify_on_error:
            notify(
                cfg,
                "[IBS] Bestellstatus unbekannt",
                "Für folgende Tage konnte der Bestellstatus nicht ermittelt werden:\n\n"
                f"  {days}\n\n"
                "Der Tag stand nicht im Wochenplan oder wurde nicht erkannt.\n"
                "Ob bestellt ist, ist damit offen — bitte selbst nachsehen:\n"
                f"{cfg.base_url}\n",
                dry_run=dry_run,
            )
        return 2

    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Prüft, ob im IBS5 Essen bestellt wurde.")
    ap.add_argument("--config", help="Pfad zur config.toml")
    ap.add_argument("--dry-run", action="store_true", help="Mail nur ausgeben, nicht senden")
    ap.add_argument("--today", help="Datum als 'heute' annehmen (YYYY-MM-DD), zum Testen")
    args = ap.parse_args(argv)

    try:
        cfg = Config.load(args.config)
    except ConfigError as exc:
        print(f"Konfigurationsfehler: {exc}", file=sys.stderr)
        return 2

    today = (
        dt.date.fromisoformat(args.today)
        if args.today
        else dt.datetime.now(ZoneInfo(cfg.timezone)).date()
    )
    return run(cfg, today, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
