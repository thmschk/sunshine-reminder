// Schutz vor der IP-Sperre von IBS5. Gesperrt antwortet IBS5 auf alles mit 406
// ohne CORS-Freigabe, im Browser kommt davon nur „Failed to fetch“ an — nicht von
// einem Netzfehler zu unterscheiden. Bei 429 auf den Login ruht jede Abfrage
// drei Stunden (403 dort heißt seit 09.10.2026 nur „Passwort falsch“), statt die Sperre durch Wiederholungen zu verlängern. Bleibt der
// Login nur ohne Antwort, kann das auch ein Aussetzer sein: erst 15 Minuten, erst
// beim nächsten Schweigen binnen sechs Stunden drei. Die Sperre gilt der
// IP-Adresse, deshalb endet die Pause, sobald das Gerät das Netz wechselt (WLAN ↔
// Mobilfunk, nur wo der Browser das verrät). Dazu eine Obergrenze je Stunde und
// Gerät, die nur bremst, bis wieder Platz im Stundenfenster ist; gezählt wird, was
// bei IBS5 ankommt (Abfragen mit Token samt CORS-Vorabfrage doppelt).
// Seite und Service Worker teilen den Zustand über IndexedDB.

import { IbsError } from "./ibs.js";
import { kvDel, kvGet, kvSet } from "./idb.js";

const PAUSE_MS = 3 * 3600 * 1000;
const SILENT_PAUSE_MS = 15 * 60 * 1000;
const SILENT_REPEAT_MS = 6 * 3600 * 1000;
const HOUR_CAP = 150;

export class IbsPausedError extends IbsError {
  constructor(until, reason) {
    const t = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })
      .format(new Date(until));
    super(`Das Bestellsystem ist nicht erreichbar oder sperrt gerade diese Internetverbindung (${reason}). `
      + `Damit eine Sperre nicht länger wird, fragt die App erst ab ${t} Uhr wieder an.`);
    this.until = until;
  }
}

/** "wifi", "cellular" … oder null, wo der Browser es nicht sagt (iOS, Desktop). */
const netType = () => (typeof navigator !== "undefined" && navigator.connection?.type) || null;

/** Aktive Pause oder null; in einem anderen Netz als bei ihrem Beginn gilt sie nicht. */
export async function paused() {
  const p = await kvGet("ibsPause");
  if (!p || p.until <= Date.now()) return null;
  const net = netType();
  if (p.net && net && net !== p.net) {
    await kvDel("ibsPause");
    return null;
  }
  return p;
}

/** „Trotzdem jetzt versuchen“: Pause und Zähler zurücksetzen. */
export async function resume() {
  await kvDel("ibsPause");
  await kvDel("ibsBudget");
}

async function pause(reason, ms = PAUSE_MS) {
  await kvSet("ibsPause", { until: Date.now() + ms, reason, at: Date.now(), net: netType() });
}

/**
 * Hooks für IbsClient: vor jeder Anfrage Pause und Stundenbudget prüfen, nach
 * einem Fehlschlag entscheiden, ob pausiert wird.
 */
export const guardHooks = {
  async before({ weight = 1 } = {}) {
    const p = await paused();
    if (p) throw new IbsPausedError(p.until, p.reason);
    const now = Date.now();
    const recent = ((await kvGet("ibsBudget")) || []).filter((t) => now - t < 3600 * 1000);
    // Volles Kontingent ist keine Sperre: nur warten, bis genug aus der Stunde gefallen ist.
    if (recent.length + weight > HOUR_CAP) {
      const until = recent.sort((a, b) => a - b)[recent.length + weight - HOUR_CAP - 1] + 3600 * 1000;
      throw new IbsPausedError(until, `mehr als ${HOUR_CAP} Anfragen in einer Stunde`);
    }
    for (let i = 0; i < weight; i++) recent.push(now);
    await kvSet("ibsBudget", recent);
  },
  async failed({ path, status, network }) {
    // Ohne Netz ist es keine Sperre; dann nichts pausieren.
    if (network && typeof navigator !== "undefined" && navigator.onLine === false) return;
    // 403 heißt beim Login „Passwort falsch“, sonst meist „Token abgelaufen“: beides keine Sperre.
    if (status === 429) return pause(`HTTP ${status}`);
    if (network && path.startsWith("/Login/")) {
      const last = await kvGet("ibsSilentAt");
      await kvSet("ibsSilentAt", Date.now());
      return pause("keine Antwort beim Anmelden", last && Date.now() - last < SILENT_REPEAT_MS ? PAUSE_MS : SILENT_PAUSE_MS);
    }
  },
  /** Ein geglückter Login beendet die Zählung des Schweigens. */
  async ok({ path }) {
    if (path.startsWith("/Login/")) await kvDel("ibsSilentAt");
  },
};
