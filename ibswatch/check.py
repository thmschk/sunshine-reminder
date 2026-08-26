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
from .parser import (DayStatus, OrderState, ParserNotCalibrated, de_long,
                     de_short, parse_weekplan)


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
    """Fetch every ISO week the target dates fall into and parse it.

    Ein Tag, der in einer geladenen Woche fehlt, ist kein Rätsel, sondern ein
    Tag ohne Angebot — deshalb geht die Auflösung über WeekPlan.status_for.
    """
    status: dict[dt.date, DayStatus] = {}
    weeks = {(d.isocalendar().year, d.isocalendar().week) for d in dates}

    for year, week in sorted(weeks):
        plan = parse_weekplan(client.weekplan(year=year, week=week))
        if plan.displayed_week is not None and plan.displayed_week != week:
            raise IbsError(
                f"Angefragt war KW {week}, geliefert wurde KW {plan.displayed_week}"
            )
        for date in dates:
            if (date.isocalendar().year, date.isocalendar().week) == (year, week):
                status[date] = plan.status_for(date)

    return status


def run(cfg: Config, today: dt.date, dry_run: bool = False) -> int:
    dates = target_dates(cfg, today)
    if not dates:
        print("Keine relevanten Tage im Prüffenster — nichts zu tun.")
        return 0

    print("Prüfe: " + ", ".join(de_short(d) for d in dates))

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

    actionable: list[DayStatus] = []
    too_late: list[DayStatus] = []
    unclear: list[dt.date] = []

    for date in dates:
        day = status.get(date)
        if day is None or day.state is OrderState.UNKNOWN:
            unclear.append(date)
            print(f"{de_short(date)}: Status unklar")
            continue
        print(str(day))
        if day.state in DayStatus.ACTIONABLE:
            actionable.append(day)
        elif day.state is OrderState.DEADLINE_PASSED:
            too_late.append(day)

    if actionable or too_late:
        parts = []
        if actionable:
            parts.append(
                "Für diese Tage ist noch nichts bestellt — Bestellen ist noch möglich:\n"
                + "\n".join(
                    f"  - {de_long(d.date)}"
                    + (" (liegt im Warenkorb, aber nicht abgeschickt!)"
                       if d.state is OrderState.IN_CART else "")
                    for d in actionable
                )
            )
        if too_late:
            parts.append(
                "Für diese Tage ist nichts bestellt und der Bestellschluss ist vorbei:\n"
                + "\n".join(f"  - {de_long(d.date)}" for d in too_late)
            )
        subject = (
            "[IBS] Kein Essen bestellt" if actionable
            else "[IBS] Kein Essen — Bestellschluss vorbei"
        )
        notify(cfg, subject, "\n\n".join(parts) + f"\n\n{cfg.web_url}\n", dry_run=dry_run)

    if unclear:
        days = ", ".join(de_short(d) for d in unclear)
        print(f"Status unklar für: {days}", file=sys.stderr)
        if cfg.notify_on_error:
            notify(
                cfg,
                "[IBS] Bestellstatus unbekannt",
                f"Für folgende Tage konnte der Bestellstatus nicht ermittelt werden:\n\n"
                f"  {days}\n\nBitte selbst nachsehen: {cfg.web_url}\n",
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
