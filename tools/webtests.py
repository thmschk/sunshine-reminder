"""Web-Tests von sunshine headless per Playwright.

Aufruf:  python -I tools/webtests.py [--channel KANAL] [--timeout S] [seite.html[?query] ...]

Startet einen HTTP-Server auf dem Repo (freier Port, nur 127.0.0.1), öffnet jede Testseite in
einem eigenen Browser-Kontext und wartet auf die Summenzeile in #out bzw. im Seitentext:
„ALLE OK“ (grün) oder „FEHLGESCHLAGEN“/„FEHLER“ (rot). Zeilen, die mit „FAIL“ beginnen,
machen eine Seite immer rot. Exit-Code 0 nur, wenn alle Seiten grün sind.

Ohne Seitenangabe laufen alle Testseiten unter web/tests/: jede *.html, die eine der
Summenzeilen ausgibt (Quelltext enthält „ALLE OK“). Seiten mit mehreren Varianten stehen
in VARIANTS.

Kanal: --channel oder Umgebungsvariable WEBTESTS_CHANNEL, Standard „chrome“ (installiertes
Google Chrome). „chromium“ nimmt das von `playwright install chromium` geladene Chromium,
ein leerer Wert die Headless-Shell von Playwright.
"""
import argparse
import functools
import http.server
import os
import re
import sys
import threading
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parent.parent
TESTS = REPO / "web" / "tests"
VARIANTS = {"anmelden.html": ["anmelden.html?mode=granted", "anmelden.html?mode=denied", "anmelden.html?mode=off"]}
DONE = re.compile(r"ALLE OK|FEHLGESCHLAGEN|\bFEHLER\b")
FAILED = re.compile(r"FEHLGESCHLAGEN|\bFEHLER\b|^\s*FAIL", re.M)


def test_pages():
    pages = []
    for f in sorted(TESTS.glob("*.html")):
        if "ALLE OK" in f.read_text(encoding="utf-8", errors="replace"):
            pages += VARIANTS.get(f.name, [f.name])
    return pages


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(QuietHandler, directory=str(REPO)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run_page(browser, base, name, timeout):
    """→ (grün?, Text in #out bzw. der Seite, Seitenfehler, Sekunden)"""
    ctx = browser.new_context()
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    t0 = time.time()
    text = ""
    try:
        page.goto(f"{base}/web/tests/{name}")
        while time.time() - t0 < timeout:
            text = page.evaluate("(document.getElementById('out') || document.body)?.innerText || ''")
            if DONE.search(text):
                break
            time.sleep(0.25)
        else:
            text += f"\nFAIL keine Summenzeile nach {timeout} s"
    except Exception as e:  # Seite nicht ladbar oder Browser abgestürzt
        text += f"\nFAIL {type(e).__name__}: {e}"
    finally:
        ctx.close()
    ok = "ALLE OK" in text and not FAILED.search(text)
    return ok, text, errs, time.time() - t0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("pages", nargs="*", help="Testseiten unter web/tests/, Standard: alle")
    ap.add_argument("--channel", default=os.environ.get("WEBTESTS_CHANNEL", "chrome"),
                    help="Browser-Kanal für Playwright (Standard: chrome; leer = Headless-Shell)")
    ap.add_argument("--timeout", type=float, default=120, help="Sekunden je Seite (Standard 120)")
    ap.add_argument("-v", "--verbose", action="store_true", help="auch bei grünen Seiten alle Zeilen zeigen")
    args = ap.parse_args()
    pages = args.pages or test_pages()
    if not pages:
        print("keine Testseiten gefunden", file=sys.stderr)
        return 2

    srv = serve()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    bad = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel=args.channel or None)
            for name in pages:
                ok, text, errs, secs = run_page(browser, base, name, args.timeout)
                if not ok:
                    bad.append(name)
                shown = text.splitlines() if args.verbose else [l for l in text.splitlines() if FAILED.search(l)]
                print(f"{'OK  ' if ok else 'FAIL'} {name} ({secs:.0f} s)", flush=True)
                for line in shown if args.verbose else shown[:40]:
                    print(f"     {line}")
                if not ok and not shown:
                    print(f"     … {text[-300:].strip()}")
                for e in errs[:3]:
                    print(f"     pageerror: {e[:200]}")
            browser.close()
    finally:
        srv.shutdown()
    print("GESAMT:", "ALLE GRÜN" if not bad else f"{len(bad)} von {len(pages)} Seite(n) rot: {', '.join(bad)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
