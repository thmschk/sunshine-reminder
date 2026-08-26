"""Turn the IBS5 Wochenplan HTML fragment into a per-day order status.

Calibrated against real responses (2026-08-26). The relevant markup is one
button per offered menu line per day:

    <button id="menu_quantity_2026-08-27_16_828" class="menuplan-checkbox"
            data-order-status="0"            0 = nicht bestellt, 2 = bestellt
            data-quantity-ordered=""         "1" wenn bestellt
            data-quantity-in-shopping-cart=""  liegt im Warenkorb
            data-date="27.08.2026" data-name="Geflügelfrikassee …"
            readonly="readonly">             fehlt, solange noch bestellbar

``readonly`` ist der Bestellschluss: der Server sagt uns direkt, welche Tage
noch änderbar sind. Damit braucht dieses Projekt keine geratene Deadline —
erinnert wird nur an Tage, an denen Handeln überhaupt noch möglich ist.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field
from enum import Enum

from bs4 import BeautifulSoup


class ParserNotCalibrated(RuntimeError):
    """Response did not look like a Wochenplan at all.

    Raised instead of guessing: a wrong guess either cries wolf or — worse —
    stays quiet on a day that really was forgotten.
    """


class OrderState(str, Enum):
    ORDERED = "ordered"
    #: im Warenkorb liegengeblieben, nie abgeschickt — der teuerste Irrtum
    IN_CART = "in_cart"
    #: nichts bestellt, aber noch bestellbar → hier lohnt die Erinnerung
    NOT_ORDERED = "not_ordered"
    #: nichts bestellt, Bestellschluss vorbei → Brot einpacken
    DEADLINE_PASSED = "deadline_passed"
    #: an dem Tag wird nichts angeboten (Wochenende, Ferien, Feiertag)
    NO_OFFER = "no_offer"
    UNKNOWN = "unknown"


#: Werte von data-order-status, die wir sicher deuten können.
_STATUS_ORDERED = "2"
_STATUS_NOT_ORDERED = "0"

_ID_DATE = re.compile(r"_(\d{4}-\d{2}-\d{2})_")
_DE_DATE = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})$")
_KW = re.compile(r"\bKW\s*(\d{1,2})\b")

#: Wochentagsnamen fest verdrahtet — eine de_DE-Locale ist auf Servern und in
#: Containern haeufig nicht installiert, %A liefert dann englische Namen.
WEEKDAYS_LONG = ("Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag")
WEEKDAYS_SHORT = ("Mo", "Di", "Mi", "Do", "Fr", "Sa", "So")


def de_long(date: dt.date) -> str:
    return f"{WEEKDAYS_LONG[date.weekday()]}, {date:%d.%m.%Y}"


def de_short(date: dt.date) -> str:
    return f"{WEEKDAYS_SHORT[date.weekday()]} {date:%d.%m.%Y}"



@dataclass
class MenuEntry:
    date: dt.date
    name: str
    status: str
    quantity_ordered: str
    quantity_in_cart: str
    orderable: bool

    @property
    def is_ordered(self) -> bool:
        return self.status == _STATUS_ORDERED or bool(self.quantity_ordered)

    @property
    def is_understood(self) -> bool:
        return self.status in (_STATUS_ORDERED, _STATUS_NOT_ORDERED)


@dataclass
class DayStatus:
    date: dt.date
    state: OrderState
    ordered_items: list[str] = field(default_factory=list)
    offered_items: list[str] = field(default_factory=list)
    orderable: bool = False

    LABELS = {
        OrderState.ORDERED: "bestellt",
        OrderState.IN_CART: "NUR IM WARENKORB — nicht abgeschickt",
        OrderState.NOT_ORDERED: "NICHT bestellt (noch bestellbar)",
        OrderState.DEADLINE_PASSED: "nicht bestellt, Bestellschluss vorbei",
        OrderState.NO_OFFER: "kein Angebot",
        OrderState.UNKNOWN: "unklar",
    }

    #: Zustände, bei denen Handeln möglich und sinnvoll ist.
    ACTIONABLE = (OrderState.NOT_ORDERED, OrderState.IN_CART)

    def __str__(self) -> str:
        extra = f" — {', '.join(self.ordered_items)}" if self.ordered_items else ""
        return f"{de_short(self.date)}: {self.LABELS[self.state]}{extra}"


@dataclass
class WeekPlan:
    days: dict[dt.date, DayStatus]
    #: Kalenderwoche laut Seitenkopf ("KW 35") — zum Abgleich mit der Anfrage
    displayed_week: int | None = None

    def status_for(self, date: dt.date) -> DayStatus:
        """Ein Tag, der in einer geladenen Woche fehlt, hat kein Angebot."""
        return self.days.get(date, DayStatus(date, OrderState.NO_OFFER))


def _entry_date(tag) -> dt.date | None:
    if m := _ID_DATE.search(tag.get("id", "")):
        return dt.date.fromisoformat(m[1])
    if m := _DE_DATE.match((tag.get("data-date") or "").strip()):
        return dt.date(int(m[3]), int(m[2]), int(m[1]))
    return None


def _day_state(entries: list[MenuEntry]) -> OrderState:
    if any(e.is_ordered for e in entries):
        return OrderState.ORDERED
    if any(e.quantity_in_cart for e in entries):
        return OrderState.IN_CART
    if not all(e.is_understood for e in entries):
        return OrderState.UNKNOWN
    return OrderState.NOT_ORDERED if any(e.orderable for e in entries) else OrderState.DEADLINE_PASSED


def parse_weekplan(html: str) -> WeekPlan:
    soup = BeautifulSoup(html, "html.parser")

    if soup.find(id="weekplan") is None:
        raise ParserNotCalibrated(
            "Antwort enthält keinen Container mit id='weekplan' — vermutlich "
            "eine Fehler- oder Login-Seite statt eines Wochenplans."
        )

    week = None
    if m := _KW.search(soup.get_text(" ", strip=True)):
        week = int(m[1])

    by_date: dict[dt.date, list[MenuEntry]] = {}
    for tag in soup.find_all(attrs={"data-order-status": True}):
        date = _entry_date(tag)
        if date is None:
            continue
        by_date.setdefault(date, []).append(
            MenuEntry(
                date=date,
                name=(tag.get("data-name") or "").strip(),
                status=(tag.get("data-order-status") or "").strip(),
                quantity_ordered=(tag.get("data-quantity-ordered") or "").strip(),
                quantity_in_cart=(tag.get("data-quantity-in-shopping-cart") or "").strip(),
                orderable=not tag.has_attr("readonly"),
            )
        )

    days = {}
    for date, entries in by_date.items():
        days[date] = DayStatus(
            date=date,
            state=_day_state(entries),
            ordered_items=[e.name for e in entries if e.is_ordered],
            offered_items=[e.name for e in entries],
            orderable=any(e.orderable for e in entries),
        )

    # Ein leerer Wochenplan ist legitim (Ferienwoche) — deshalb hängt die
    # Kalibrierungs-Ausnahme oben am Container, nicht an der Trefferzahl.
    return WeekPlan(days=days, displayed_week=week)
