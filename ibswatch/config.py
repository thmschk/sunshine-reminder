"""Configuration: non-secret settings from TOML, secrets from ~/.netrc.

Rationale for the split: the TOML file is meant to be readable, diffable and
— apart from the recipient address — harmless. Kundennummer, Passwort and the
SMTP password never live in this repo's working tree at all; they stay in
``~/.netrc`` (mode 0600), which is the same place curl and other tools already
look. Nothing in this package ever logs or prints a secret.
"""

from __future__ import annotations

import netrc
import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .client import DEFAULT_BASE_URL

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.toml"


class ConfigError(RuntimeError):
    pass


@dataclass
class SmtpConfig:
    host: str = ""
    port: int = 587
    security: str = "starttls"  # starttls | ssl | none
    mail_from: str = ""
    mail_to: list[str] = field(default_factory=list)
    netrc_machine: str = ""  # defaults to host

    @property
    def configured(self) -> bool:
        return bool(self.host and self.mail_from and self.mail_to)


@dataclass
class Config:
    base_url: str = DEFAULT_BASE_URL
    netrc_machine: str = "ibs.sunshine-catering.de"
    timezone: str = "Europe/Berlin"
    #: how many calendar days ahead to inspect (1 = only the next delivery day)
    days_ahead: int = 2
    #: also look at today (useful if the order deadline is later the same day)
    include_today: bool = False
    #: weekdays that are relevant at all (1 = Monday … 7 = Sunday)
    weekdays: list[int] = field(default_factory=lambda: [1, 2, 3, 4, 5])
    #: also send a mail when the check itself could not be completed
    notify_on_error: bool = True
    smtp: SmtpConfig = field(default_factory=SmtpConfig)

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        path = Path(path or os.environ.get("IBSWATCH_CONFIG") or DEFAULT_CONFIG_PATH)
        if not path.exists():
            raise ConfigError(
                f"Keine Konfiguration unter {path} — config.example.toml kopieren."
            )
        with path.open("rb") as fh:
            raw = tomllib.load(fh)

        try:
            smtp = SmtpConfig(**raw.pop("smtp", {}))
            cfg = cls(smtp=smtp, **raw)
        except TypeError as exc:
            raise ConfigError(f"{path}: {exc}") from exc
        if not cfg.smtp.netrc_machine:
            cfg.smtp.netrc_machine = cfg.smtp.host
        return cfg


def netrc_credentials(machine: str) -> tuple[str, str]:
    """Return (login, password) for *machine* from ~/.netrc.

    Raises ConfigError with an actionable message — never echoes the values.
    """
    try:
        auth = netrc.netrc().authenticators(machine)
    except FileNotFoundError as exc:
        raise ConfigError("~/.netrc existiert nicht") from exc
    except netrc.NetrcParseError as exc:
        raise ConfigError(f"~/.netrc nicht lesbar: {exc}") from exc

    if not auth:
        raise ConfigError(
            f"Kein Eintrag für '{machine}' in ~/.netrc.\n"
            f"  machine {machine} login <Kundennummer> password <Passwort>"
        )

    login, _account, password = auth
    if not login or not password:
        raise ConfigError(f"Eintrag für '{machine}' in ~/.netrc ist unvollständig")
    return login, password
