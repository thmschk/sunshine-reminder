#!/usr/bin/env python3
"""Berliner Schulferien von der OpenHolidaysAPI nach web/ferien.json schreiben.

Die Web-App liest nur diese Datei; zur Laufzeit fragt niemand OpenHolidaysAPI.
Berlin legt die Ferien Jahre im Voraus fest, die Datei reicht deshalb lange.
Läuft sie bald aus, meldet das die tägliche Selbstprüfung des Servers an die
Betreiber-Geräte; dann dieses Skript laufen lassen, den Diff ansehen, committen,
pushen und erst dann deployen (deploy.sh lädt den gepushten Stand von GitHub):

    python3 tools/ferien.py
    git diff web/ferien.json
    git commit -m "Ferientermine aktualisiert" web/ferien.json && git push
    server/deploy.sh
"""

from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

STATE = "DE-BE"
URL = "https://openholidaysapi.org/SchoolHolidays"
OUT = Path(__file__).resolve().parent.parent / "web" / "ferien.json"
YEARS_AHEAD = 6


def fetch_year(year: int) -> list[dict]:
    # Die API erlaubt höchstens 1095 Tage je Abfrage, also Jahr für Jahr.
    url = (f"{URL}?countryIsoCode=DE&subdivisionCode={STATE}&languageIsoCode=DE"
           f"&validFrom={year}-01-01&validTo={year}-12-31")
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "sunshine tools/ferien.py"})
    with urllib.request.urlopen(req, timeout=20) as res:
        data = json.load(res)
    return [{"start": h["startDate"], "end": h["endDate"],
             "name": next((n["text"] for n in h["name"] if n.get("language") == "DE"), h["name"][0]["text"])}
            for h in data]


def implausible(holidays: list[dict], until: str) -> str | None:
    """Grund, die neue Liste nicht zu schreiben, oder None.

    Die API liefert gelegentlich unvollständige Jahre; die bisherige Datei reicht
    dann weiter und darf nicht durch eine kürzere ersetzt werden.
    """
    try:
        old = json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if until < old.get("until", ""):
        return f"Neue Daten reichen nur bis {until}, die bisherigen bis {old['until']}"
    still_relevant = [h for h in old.get("holidays", []) if h["end"] >= dt.date.today().isoformat()]
    covered = {(h["start"], h["end"]) for h in holidays}
    lost = [h for h in still_relevant if (h["start"], h["end"]) not in covered]
    if len(lost) > 1:
        return f"{len(lost)} kommende Ferien fehlen in den neuen Daten (z. B. {lost[0]['name']} ab {lost[0]['start']})"
    return None


def main() -> int:
    today = dt.date.today()
    found: dict[tuple, dict] = {}
    for year in range(today.year - 1, today.year + YEARS_AHEAD):
        for h in fetch_year(year):
            found[(h["start"], h["end"], h["name"])] = h
    holidays = sorted(found.values(), key=lambda h: h["start"])
    # Berlin legt die Ferien je Schuljahr fest, das mit den Sommerferien endet:
    # bis zu deren Ende ist alles bekannt, danach womöglich nur ein Teil.
    summers = [h["end"] for h in holidays if "sommer" in h["name"].lower()]
    if not summers:
        print("Keine Sommerferien gefunden, ferien.json bleibt unverändert", file=sys.stderr)
        return 1
    until = max(summers)
    holidays = [h for h in holidays if h["start"] <= until and h["end"] >= f"{today.year - 1}-08-01"]
    problem = implausible(holidays, until)
    if problem and "--force" not in sys.argv:
        print(f"{problem}; ferien.json bleibt unverändert (mit --force trotzdem schreiben)", file=sys.stderr)
        return 1
    doc = {"state": STATE, "source": "OpenHolidaysAPI", "generated": today.isoformat(), "until": until, "holidays": holidays}
    # Ein Eintrag je Zeile, damit ein Diff zeigt, welche Ferien sich geändert haben.
    head = json.dumps({k: v for k, v in doc.items() if k != "holidays"}, ensure_ascii=False)[:-1]
    rows = ",\n".join("  " + json.dumps(h, ensure_ascii=False) for h in holidays)
    # Erst eine Nachbardatei schreiben, dann umbenennen: ein Abbruch hinterlässt nie eine halbe ferien.json.
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(f'{head}, "holidays": [\n{rows}\n]}}\n', encoding="utf-8")
    tmp.replace(OUT)
    print(f"{OUT.name}: {len(holidays)} Einträge bis {until}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
