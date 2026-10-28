// Schutz vor der IP-Sperre von IBS5. Gesperrt antwortet IBS5 auf alles mit 406
// ohne CORS-Freigabe, im Browser kommt davon nur „Failed to fetch“ an — nicht von
// einem Netzfehler zu unterscheiden. Bei 429 (auf jedem Pfad) ruht jede Abfrage
// drei Stunden, statt die Sperre durch Wiederholungen zu verlängern; 403 beim Login
// heißt seit 09.10.2026 nur „Passwort falsch“. Bleibt der Login ohne Antwort, kann
// das auch ein Aussetzer sein: erst 15 Minuten, erst beim nächsten Schweigen binnen
// sechs Stunden drei. Die Sperre gilt der
// IP-Adresse, deshalb endet die Pause, sobald das Gerät das Netz wechselt (WLAN ↔
// Mobilfunk, nur wo der Browser das verrät). Dazu eine Obergrenze je Stunde und
// Gerät, die nur bremst, bis wieder Platz im Stundenfenster ist; gezählt wird, was
// bei IBS5 ankommt (Abfragen mit Token samt CORS-Vorabfrage doppelt).
// Seite und Service Worker teilen den Zustand über IndexedDB.

import { IbsError } from "./ibs.js";
import { kvDel, kvGet, kvSet, kvUpdate } from "./idb.js";

const PAUSE_MS = 3 * 3600 * 1000;
const SILENT_PAUSE_MS = 15 * 60 * 1000;
const SILENT_REPEAT_MS = 6 * 3600 * 1000;
const HOUR_CAP = 150;

const hhmm = (t) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })
  .format(new Date(t));

export class IbsPausedError extends IbsError {
  constructor(until, reason, message = null) {
    super(message ?? `Das Bestellsystem ist nicht erreichbar oder sperrt gerade diese Internetverbindung (${reason}). `
      + `Damit eine Sperre nicht länger wird, fragt die App erst ab ${hhmm(until)} Uhr wieder an.`);
    this.until = until;
  }
}

/** Das eigene Stundenkontingent ist voll: keine Sperre von IBS5, die App bremst sich nur selbst. */
export class IbsBudgetError extends IbsPausedError {
  constructor(until) {
    super(until, null, `Die App hat in der letzten Stunde schon viele Anfragen an das Bestellsystem gestellt `
      + `(höchstens ${HOUR_CAP}) und wartet bis ${hhmm(until)} Uhr, damit es diese Internetverbindung nicht sperrt.`);
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

/** Zeitpunkt, ab dem weight weitere Plätze im Stundenfenster frei sind, oder null, wenn sie es jetzt sind. */
function fullUntil(list, weight, now) {
  const recent = list.filter((t) => now - t < 3600 * 1000).sort((a, b) => a - b);
  return recent.length + weight > HOUR_CAP ? recent[recent.length + weight - HOUR_CAP - 1] + 3600 * 1000 : null;
}

/**
 * Vor einem Vorgang, der mittendrin nicht abbrechen darf (Bestellen): wirft, wenn
 * Pause ist oder units Plätze nicht mehr in die Stunde passen. Zählt selbst nichts.
 */
export async function budgetFor(units) {
  if (units > HOUR_CAP) {
    throw new IbsError(`Dafür bräuchte die App mehr als ${HOUR_CAP} Anfragen auf einmal. Bitte in kleineren Portionen abschicken.`);
  }
  const p = await paused();
  if (p) throw new IbsPausedError(p.until, p.reason);
  const list = await kvGet("ibsBudget").catch(() => null);
  const until = Array.isArray(list) ? fullUntil(list, units, Date.now()) : null;
  if (until) throw new IbsBudgetError(until);
}

/** fn ohne Stundenbremse für client (nach budgetFor); gezählt wird weiter, eine Pause gilt weiter. */
export async function unmetered(client, fn) {
  client.unmetered = true;
  try {
    return await fn();
  } finally {
    client.unmetered = false;
  }
}

/**
 * Hooks für IbsClient: vor jeder Anfrage Pause und Stundenbudget prüfen, nach
 * einem Fehlschlag entscheiden, ob pausiert wird.
 */
export const guardHooks = {
  async before({ weight = 1, unmetered: free = false } = {}) {
    const p = await paused();
    if (p) throw new IbsPausedError(p.until, p.reason);
    const now = Date.now();
    // In einer Transaktion: Seite und Service Worker zählen gleichzeitig, keiner darf den anderen überschreiben.
    const full = await kvUpdate("ibsBudget", (list) => {
      // Volles Kontingent ist keine Sperre: nur warten, bis genug aus der Stunde gefallen ist.
      const until = free ? null : fullUntil(list || [], weight, now);
      if (until) return { result: until };
      const recent = (list || []).filter((t) => now - t < 3600 * 1000);
      for (let i = 0; i < weight; i++) recent.push(now);
      return { value: recent };
    }).catch(() => null); // ohne IndexedDB (privater Modus) nicht zählen statt gar nicht fragen
    if (full) throw new IbsBudgetError(full);
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
