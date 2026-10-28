// Fehler in Klartext, für die Seite (app.js) und die Meldungen der Weckrufe (sw.js).
// Die technischen Meldungen selbst entstehen in ibs.js und guard.js.

import { IbsAuthError, IbsError } from "./ibs.js";
import { IbsBudgetError, IbsPausedError, hhmm } from "./guard.js";

/**
 * Fehler für die Anzeige: text in Klartext, detail die technische Meldung (nur zum Aufklappen),
 * net: Netz- oder Sperrfehler, bei dem eine andere Verbindung helfen kann.
 */
export function friendly(e) {
  const raw = String(e?.message ?? e ?? "");
  if (e instanceof IbsBudgetError) return { text: raw, detail: "" };
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { text: "Sobald das Handy wieder Netz hat, nochmal versuchen.", detail: raw, offline: true };
  }
  // Grund der Pause in Klammern („HTTP 429“) nur in den Details.
  if (e instanceof IbsPausedError) return { text: raw.replace(/ \([^)]*\)(?=\.)/, ""), detail: raw, net: true };
  if (/^Keine Verbindung zum Bestellsystem/.test(raw)) return { text: "Das Bestellsystem ist gerade nicht erreichbar.", detail: raw, net: true };
  if (/^Bestellsystem antwortet nicht/.test(raw)) return { text: "Das Bestellsystem antwortet gerade nicht.", detail: raw, net: true };
  if (e instanceof IbsError && !(e instanceof IbsAuthError) && /HTTP \d|JSON|Token|unerwartete Antwort|geliefert wurde/.test(raw)) {
    return { text: "Das Bestellsystem hat unerwartet geantwortet.", detail: raw };
  }
  return { text: raw, detail: "" };
}

const LATER = "Ob bestellt ist, prüft die App beim nächsten Mal. Zum sofortigen Versuch die App öffnen.";

/**
 * Meldung, wenn ein Weckruf ein Konto nicht prüfen konnte: {title, body, transient}.
 * transient: Netz- oder Pausenfehler, der von selbst vorbeigehen kann (sw.js meldet
 * ihn erst laut, wenn schon der vorige Weckruf scheiterte). rejected: der Login
 * selbst wurde abgelehnt (falsche Zugangsdaten).
 */
export function pushFailure(e, { rejected = false } = {}) {
  if (e instanceof IbsBudgetError) {
    return {
      title: "Die App macht eine Pause",
      body: `Damit das Bestellsystem diese Internetverbindung nicht sperrt, fragt die App erst ab ${hhmm(e.until)} Uhr wieder an. ${LATER}`,
      transient: true,
    };
  }
  if (e instanceof IbsPausedError) {
    return {
      title: "Bestellsystem gerade nicht erreichbar",
      body: `Damit eine mögliche Sperre nicht länger wird, fragt die App erst ab ${hhmm(e.until)} Uhr wieder an. Zum sofortigen Versuch die App öffnen.`,
      transient: true,
    };
  }
  if (e instanceof IbsAuthError && rejected) {
    return { title: "Anmeldung abgelehnt", body: `${e.message}\nBitte die Zugangsdaten in der App prüfen.`, transient: false };
  }
  const f = friendly(e);
  if (e?.network || f.net) {
    return { title: f.offline ? "Handy gerade ohne Netz" : "Bestellsystem gerade nicht erreichbar", body: LATER, transient: true };
  }
  return { title: "Bestellstand unbekannt", body: `${f.text}\nOb bestellt ist, bitte in der App nachsehen.`, transient: false };
}
