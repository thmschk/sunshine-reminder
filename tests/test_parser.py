"""Parser-Tests auf synthetischem Markup.

Die Fixtures hier sind erfunden — sobald echte Wochenplaene vorliegen
(tools/explore.py), gehoert hier ein anonymisierter echter Ausschnitt hin.
"""

import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from ibswatch.parser import OrderState, ParserNotCalibrated, parse_weekplan  # noqa: E402

WEEK = """
<div class="weekplan">
  <div class="day" data-date="2026-08-27">
    <div class="menu-line ordered">Menue 1 - Spaghetti</div>
    <div class="menu-line">Menue 2 - Salat</div>
  </div>
  <div class="day" data-date="2026-08-28">
    <div class="menu-line">Menue 1 - Eintopf</div>
    <div class="menu-line">Menue 2 - Auflauf</div>
  </div>
  <div class="day noplan" data-date="2026-08-29">Feiertag</div>
</div>
"""


def test_three_states():
    plan = parse_weekplan(WEEK)
    assert plan[dt.date(2026, 8, 27)].state is OrderState.ORDERED
    assert plan[dt.date(2026, 8, 28)].state is OrderState.NOT_ORDERED
    assert plan[dt.date(2026, 8, 29)].state is OrderState.NO_OFFER


def test_ordered_items_are_reported():
    plan = parse_weekplan(WEEK)
    assert "Spaghetti" in " ".join(plan[dt.date(2026, 8, 27)].items)


def test_unrecognised_markup_raises_instead_of_alarming():
    """Der teuerste Bug waere ein Fehlalarm aus unverstandenem HTML."""
    try:
        parse_weekplan("<html><body><p>Sitzung abgelaufen</p></body></html>")
    except ParserNotCalibrated:
        return
    raise AssertionError("haette ParserNotCalibrated werfen muessen")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"ok  {name}")
