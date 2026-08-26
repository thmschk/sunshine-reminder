"""Minimal client for the IBS5 ordering system (Sunshine Catering).

The web frontend is a jQuery SPA that talks to a small JSON/Bearer API.
Everything in here was derived from the public login page's inline JS.

Two non-obvious server quirks are handled once, here:

* Without an ``Accept-Language`` header IIS answers **HTTP 500**
  (``Request.UserLanguages`` is null in ``Views/Shared/_Layout.cshtml``).
* Authenticated endpoints want ``X-Requested-With: XMLHttpRequest`` in
  addition to the bearer token, otherwise they may return the SPA shell.
"""

from __future__ import annotations

import datetime as dt

import requests

DEFAULT_BASE_URL = "https://ibs.sunshine-catering.de/ibs5"

_USER_AGENT = (
    "ibs-order-watch/0.1 (+https://github.com/  ; python-requests)"
)


class IbsError(RuntimeError):
    """Any problem talking to IBS5 — network, HTTP or unexpected payload."""


class IbsAuthError(IbsError):
    """Login was rejected, or the session token is not (or no longer) valid."""


class IbsClient:
    def __init__(self, base_url: str = DEFAULT_BASE_URL, timeout: int = 30):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.token: str | None = None
        self.profile: dict = {}
        self.session = requests.Session()
        self.session.headers.update(
            {
                "User-Agent": _USER_AGENT,
                "Accept-Language": "de-DE,de;q=0.9",
            }
        )
        # requests liest von sich aus ~/.netrc und setzt fuer passende Hosts
        # HTTP-Basic-Auth — das ueberschreibt unseren Bearer-Token und der
        # Server antwortet mit 500. Da die IBS5-Zugangsdaten per Design unter
        # genau diesem Hostnamen im netrc stehen, trifft das jede Installation.
        # Ein No-op-auth unterdrueckt die Automatik, ohne wie trust_env=False
        # auch noch Proxy- und CA-Umgebungsvariablen abzuschalten.
        self.session.auth = lambda request: request

    # -- authentication ---------------------------------------------------

    def login(self, customer_no: str, password: str) -> dict:
        """Exchange Kundennummer + Passwort for a bearer token.

        Deliberately does **not** retry: the account lockout policy of the
        vendor is unknown, and a watchdog that hammers the login form would
        be the fastest way to lock Lorenz out of his lunch.
        """
        try:
            resp = self.session.post(
                f"{self.base_url}/Login/Login",
                data={
                    "identifierValue": customer_no,
                    "secretValue": password,
                    "identifierType": "0",
                    "secretType": "0",
                },
                headers={"X-Requested-With": "XMLHttpRequest"},
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise IbsError(f"Login-Request fehlgeschlagen: {exc}") from exc

        if resp.status_code != 200:
            raise IbsError(f"Login lieferte HTTP {resp.status_code}")

        try:
            result = resp.json()
        except ValueError as exc:
            raise IbsError("Login lieferte kein JSON") from exc

        if result.get("errorMessage"):
            raise IbsAuthError(result["errorMessage"])

        token = result.get("token")
        if not token:
            raise IbsError("Login-Antwort enthielt kein Token")

        self.token = token
        self.profile = result
        return result

    # -- authenticated requests -------------------------------------------

    def get(self, path: str, **params) -> requests.Response:
        if not self.token:
            raise IbsAuthError("Nicht eingeloggt — erst login() aufrufen")

        try:
            resp = self.session.get(
                f"{self.base_url}/{path.lstrip('/')}",
                params={k: v for k, v in params.items() if v is not None},
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "X-Requested-With": "XMLHttpRequest",
                },
                timeout=self.timeout,
            )
        except requests.RequestException as exc:
            raise IbsError(f"Request an {path} fehlgeschlagen: {exc}") from exc

        if resp.status_code in (401, 403):
            raise IbsAuthError(f"{path}: Token abgelehnt (HTTP {resp.status_code})")
        if resp.status_code != 200:
            raise IbsError(f"{path}: HTTP {resp.status_code}")
        return resp

    # -- the endpoints we actually care about ------------------------------

    def weekplan(self, year: int | None = None, week: int | None = None) -> str:
        """Wochenplan as an HTML fragment; no args = current week."""
        return self.get("/Mealplan/Weekplan", year=year, week=week).text

    def weekplan_mobile(self, date: dt.date | None = None) -> str:
        return self.get(
            "/Mealplan/WeekplanMobile",
            date=date.isoformat() if date else None,
        ).text

    def orderhistory(self, date_from: dt.date, date_to: dt.date, search: str = "") -> str:
        return self.get(
            "/Account/Orderhistory",
            **{"from": date_from.isoformat(), "to": date_to.isoformat(), "search": search},
        ).text

    def balance_and_cart(self) -> str:
        return self.get("/Mealplan/UpdateBalanceAndCart").text
