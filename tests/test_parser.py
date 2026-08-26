"""Parser-Tests.

``weekplan_kw35.html`` stammt aus einer echten IBS5-Antwort (Attributstruktur
unveraendert, IDs neutralisiert). Die uebrigen Faelle werden daraus abgeleitet,
indem gezielt einzelne Attribute veraendert werden — echte Beispiele fuer
"vergessen zu bestellen" gab es beim Kalibrieren schlicht nicht.
"""

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ibswatch.parser import OrderState, ParserNotCalibrated, parse_weekplan  # noqa: E402

FIXTURE = (Path(__file__).parent / "fixtures" / "weekplan_kw35.html").read_text(encoding="utf-8")

MON, TUE, WED, THU, FRI = (dt.date(2026, 8, d) for d in (24, 25, 26, 27, 28))


def _patch_day(html: str, iso_date: str, *replacements: tuple[str, str]) -> str:
    """Attribute nur in den Buttons eines bestimmten Tages ersetzen.

    Wichtig: ein globales str.replace wuerde den Nachbartag treffen — genau
    dieser Fehler hat den ersten Anlauf dieser Tests falsch gruen gemacht.
    """
    out = []
    for block in html.split("<button"):
        if f"_{iso_date}_" in block:
            for old, new in replacements:
                block = block.replace(old, new)
        out.append(block)
    return "<button".join(out)


def _without_orders(html: str, iso_date: str) -> str:
    """Alle Bestellungen eines Tages entfernen — simuliert 'vergessen'."""
    return _patch_day(
        html, iso_date,
        ('data-order-status="2"', 'data-order-status="0"'),
        ('data-quantity-ordered="1"', 'data-quantity-ordered=""'),
    )


def test_real_fixture_all_days_ordered():
    plan = parse_weekplan(FIXTURE)
    assert plan.displayed_week == 35
    assert sorted(plan.days) == [MON, TUE, WED, THU, FRI]
    assert all(d.state is OrderState.ORDERED for d in plan.days.values())


def test_forgotten_but_still_orderable_is_actionable():
    """Do 27.08. ist im Fixture noch aenderbar (kein readonly) -> Alarm."""
    plan = parse_weekplan(_without_orders(FIXTURE, "2026-08-27"))
    assert plan.days[THU].state is OrderState.NOT_ORDERED
    assert plan.days[THU].orderable is True


def test_forgotten_after_deadline_is_not_an_alarm():
    """Mo 24.08. ist komplett readonly -> nichts mehr zu machen."""
    plan = parse_weekplan(_without_orders(FIXTURE, "2026-08-24"))
    assert plan.days[MON].state is OrderState.DEADLINE_PASSED


def test_left_in_shopping_cart_is_caught():
    html = _patch_day(
        _without_orders(FIXTURE, "2026-08-27"), "2026-08-27",
        ('data-quantity-in-shopping-cart=""', 'data-quantity-in-shopping-cart="1"'),
    )
    assert parse_weekplan(html).days[THU].state is OrderState.IN_CART


def test_unknown_status_never_silently_passes():
    html = _patch_day(
        _without_orders(FIXTURE, "2026-08-27"), "2026-08-27",
        ('data-order-status="0"', 'data-order-status="7"'),
    )
    assert parse_weekplan(html).days[THU].state is OrderState.UNKNOWN


def test_day_without_offer_is_not_a_missed_order():
    plan = parse_weekplan(FIXTURE)
    assert plan.status_for(dt.date(2026, 8, 29)).state is OrderState.NO_OFFER  # Samstag


def test_empty_holiday_week_parses_without_error():
    plan = parse_weekplan('<div id="weekplan"><div>KW 30</div></div>')
    assert plan.days == {}
    assert plan.status_for(MON).state is OrderState.NO_OFFER


def test_error_page_raises_instead_of_alarming():
    for html in ('<html><body><p>Sitzung abgelaufen</p></body></html>',
                 '<div class="login-container">Anmelden</div>'):
        try:
            parse_weekplan(html)
        except ParserNotCalibrated:
            continue
        raise AssertionError("haette ParserNotCalibrated werfen muessen")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
