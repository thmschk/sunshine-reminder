"""Turn the IBS5 Wochenplan HTML fragment into a per-day order status.

PROVISIONAL — calibrated against the *unauthenticated* markup only. The
authenticated Wochenplan has not been seen yet (no credentials at the time of
writing), so the selectors below are heuristics over the markup conventions
the SPA uses. ``tools/explore.py`` dumps the real fragment; re-check
``_ORDER_MARKERS`` and ``_find_day_blocks`` against it and delete this notice.

The one invariant that must survive any rewrite: three distinguishable states
per day. A day on which nothing is offered at all (Feiertag, Einrichtung zu)
must never be reported as "vergessen zu bestellen", and anything the parser
does not genuinely recognise must come out as UNKNOWN, not as NOT_ORDERED.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from enum import Enum

from bs4 import BeautifulSoup


class ParserNotCalibrated(RuntimeError):
    """The HTML did not look like anything this parser knows.

    Raised instead of guessing — a wrong guess here sends a false alarm or,
    worse, stays silent on a day that really was forgotten.
    """


class OrderState(str, Enum):
    ORDERED = "ordered"
    NOT_ORDERED = "not_ordered"
    NO_OFFER = "no_offer"
    UNKNOWN = "unknown"


@dataclass
class DayStatus:
    date: dt.date
    state: OrderState
    items: list[str] = field(default_factory=list)
    note: str = ""

    def __str__(self) -> str:
        label = {
            OrderState.ORDERED: "bestellt",
            OrderState.NOT_ORDERED: "NICHT bestellt",
            OrderState.NO_OFFER: "kein Angebot",
            OrderState.UNKNOWN: "unklar",
        }[self.state]
        extra = f" ({', '.join(self.items)})" if self.items else ""
        return f"{self.date:%a %d.%m.%Y}: {label}{extra}"


# Substrings in class names / data attributes that mark a menu line as ordered.
_ORDER_MARKERS = ("ordered", "bestellt", "is-ordered", "menu-selected", "selected")
# ... and ones that mark a day as having no offer at all.
_CLOSED_MARKERS = ("noplan", "no-plan", "closed", "holiday", "feiertag", "geschlossen")

_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_DE_DATE = re.compile(r"\b(\d{2})\.(\d{2})\.(\d{4})\b")


def _extract_date(text: str) -> dt.date | None:
    if m := _ISO_DATE.search(text):
        return dt.date(int(m[1]), int(m[2]), int(m[3]))
    if m := _DE_DATE.search(text):
        return dt.date(int(m[3]), int(m[2]), int(m[1]))
    return None


def _attr_blob(tag) -> str:
    """All attribute values of a tag, lowercased, as one searchable string."""
    parts = []
    for value in tag.attrs.values():
        parts.extend(value if isinstance(value, list) else [str(value)])
    return " ".join(parts).lower()


def _find_day_blocks(soup: BeautifulSoup) -> list[tuple[dt.date, object]]:
    """Locate the per-day containers and the date each one belongs to."""
    blocks: list[tuple[dt.date, object]] = []
    seen: set[int] = set()

    for tag in soup.find_all(attrs={"data-date": True}):
        if date := _extract_date(str(tag.get("data-date"))):
            blocks.append((date, tag))
            seen.add(id(tag))

    if not blocks:
        # Fallback: containers whose id/class carries the date, e.g. id="day_2026-08-27"
        for tag in soup.find_all(["div", "td", "section", "li"]):
            if id(tag) in seen:
                continue
            if date := _extract_date(_attr_blob(tag)):
                blocks.append((date, tag))
                seen.add(id(tag))

    # Keep only the outermost container per date.
    best: dict[dt.date, object] = {}
    for date, tag in blocks:
        if date not in best or len(str(tag)) > len(str(best[date])):
            best[date] = tag
    return sorted(best.items())


def parse_weekplan(html: str) -> dict[dt.date, DayStatus]:
    soup = BeautifulSoup(html, "html.parser")
    blocks = _find_day_blocks(soup)

    if not blocks:
        raise ParserNotCalibrated(
            "Im Wochenplan wurden keine Tages-Container mit Datum gefunden. "
            "Antwort mit tools/explore.py dumpen und die Selektoren in "
            "ibswatch/parser.py anpassen."
        )

    result: dict[dt.date, DayStatus] = {}
    for date, block in blocks:
        blob = _attr_blob(block)
        text = block.get_text(" ", strip=True)

        if any(marker in blob for marker in _CLOSED_MARKERS):
            result[date] = DayStatus(date, OrderState.NO_OFFER, note="als geschlossen markiert")
            continue

        ordered_items: list[str] = []
        for tag in block.find_all(True):
            tag_blob = _attr_blob(tag)
            if any(marker in tag_blob for marker in _ORDER_MARKERS):
                label = tag.get_text(" ", strip=True)[:80]
                if label:
                    ordered_items.append(label)
            elif tag.name == "input" and tag.get("type") == "checkbox" and tag.has_attr("checked"):
                label = tag.get("data-menu-description") or tag.get("value") or ""
                ordered_items.append(str(label)[:80] or "Menü")

        if ordered_items:
            # de-duplicate while keeping order (markers often nest)
            uniq = list(dict.fromkeys(ordered_items))
            result[date] = DayStatus(date, OrderState.ORDERED, items=uniq)
        elif not text:
            result[date] = DayStatus(date, OrderState.NO_OFFER, note="leerer Tag")
        else:
            # Menus are offered but none carries an order marker. Only trust
            # this once the parser has been verified against real markup.
            result[date] = DayStatus(date, OrderState.NOT_ORDERED)

    return result
