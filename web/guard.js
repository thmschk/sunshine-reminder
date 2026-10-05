// Schutz vor der IP-Sperre von IBS5. Gesperrt antwortet IBS5 auf alles mit 406
// ohne CORS-Freigabe, im Browser kommt davon nur „Failed to fetch“ an — nicht von
// einem Netzfehler zu unterscheiden. Scheitert deshalb selbst der Login so (oder
// kommt 403/429), ruht jede Abfrage einige Stunden, statt die Sperre durch
// Wiederholungen zu verlängern. Dazu eine Obergrenze je Stunde und Gerät.
// Seite und Service Worker teilen den Zustand über IndexedDB.

import { IbsError } from "./ibs.js";
import { kvDel, kvGet, kvSet } from "./idb.js";

const PAUSE_MS = 3 * 3600 * 1000;
const HOUR_CAP = 60;

export class IbsPausedError extends IbsError {
  constructor(until, reason) {
    const t = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })
      .format(new Date(until));
    super(`Das Bestellsystem ist nicht erreichbar oder sperrt gerade diese Internetverbindung (${reason}). `
      + `Damit eine Sperre nicht länger wird, fragt die App erst ab ${t} Uhr wieder an.`);
    this.until = until;
  }
}

/** Aktive Pause oder null. */
export async function paused() {
  const p = await kvGet("ibsPause");
  return p && p.until > Date.now() ? p : null;
}

export const resume = () => kvDel("ibsPause");

async function pause(reason) {
  await kvSet("ibsPause", { until: Date.now() + PAUSE_MS, reason, at: Date.now() });
}

/**
 * Hooks für IbsClient: vor jeder Anfrage Pause und Stundenbudget prüfen, nach
 * einem Fehlschlag entscheiden, ob pausiert wird.
 */
export const guardHooks = {
  async before() {
    const p = await paused();
    if (p) throw new IbsPausedError(p.until, p.reason);
    const now = Date.now();
    const recent = ((await kvGet("ibsBudget")) || []).filter((t) => now - t < 3600 * 1000);
    if (recent.length >= HOUR_CAP) {
      await pause(`mehr als ${HOUR_CAP} Anfragen in einer Stunde`);
      const q = await paused();
      throw new IbsPausedError(q.until, q.reason);
    }
    recent.push(now);
    await kvSet("ibsBudget", recent);
  },
  async failed({ path, status, network }) {
    // Ohne Netz ist es keine Sperre; dann nichts pausieren.
    if (network && typeof navigator !== "undefined" && navigator.onLine === false) return;
    // 403 bei angemeldeten Aufrufen heißt meist nur „Token abgelaufen“, deshalb nur beim Login.
    if (status === 429 || (status === 403 && path.startsWith("/Login/"))) return pause(`HTTP ${status}`);
    if (network && path.startsWith("/Login/")) return pause("keine Antwort beim Anmelden");
  },
};
