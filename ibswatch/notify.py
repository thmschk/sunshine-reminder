"""Sending the actual reminder mail (and the 'check failed' mail)."""

from __future__ import annotations

import smtplib
import ssl
from email.message import EmailMessage

from .config import Config, ConfigError, netrc_credentials


def send_mail(cfg: Config, subject: str, body: str, dry_run: bool = False) -> None:
    smtp = cfg.smtp

    if dry_run or not smtp.configured:
        reason = "--dry-run" if dry_run else "SMTP nicht konfiguriert"
        print(f"--- Mail nicht versendet ({reason}) ---")
        print(f"An:      {', '.join(smtp.mail_to) or '<niemand>'}")
        print(f"Betreff: {subject}\n")
        print(body)
        return

    msg = EmailMessage()
    msg["From"] = smtp.mail_from
    msg["To"] = ", ".join(smtp.mail_to)
    msg["Subject"] = subject
    msg.set_content(body)

    user, password = netrc_credentials(smtp.netrc_machine)

    if smtp.security == "ssl":
        server = smtplib.SMTP_SSL(smtp.host, smtp.port, context=ssl.create_default_context(), timeout=30)
    else:
        server = smtplib.SMTP(smtp.host, smtp.port, timeout=30)

    with server:
        if smtp.security == "starttls":
            server.starttls(context=ssl.create_default_context())
        if smtp.security != "none":
            server.login(user, password)
        server.send_message(msg)

    print(f"Mail an {', '.join(smtp.mail_to)} versendet: {subject}")
