// Schutz vor der IP-Sperre von IBS5. Gesperrt antwortet IBS5 auf alles mit 406
// ohne CORS-Freigabe, im Browser kommt davon nur „Failed to fetch“ an — nicht von
// einem Netzfehler, einem abgelaufenen Token oder einem Login-Aussetzer zu
// unterscheiden. Bei 429 (auf jedem Pfad) ruht jede Abfrage eine Stunde. Bleibt der
// Login ohne Antwort, lädt die Seite erst das Logo von IBS5 als Bild (probe): kommt
// es, ist die Verbindung nicht gesperrt und es gibt keine Pause. Sonst ruht sie
// gestuft 10, 30, 60 Minuten; ein weiteres Schweigen binnen fünf Minuten gilt als
// dieselbe Störung, jede geglückte Antwort setzt die Stufe zurück. 403 beim Login
// heißt seit 09.10.2026 nur „Passwort falsch“. Die Sperre gilt der IP-Adresse,
// deshalb endet die Pause, sobald das Gerät das Netz wechselt (WLAN ↔ Mobilfunk,
// nur wo der Browser das verrät), oder wenn die Probe während der Pause glückt
// (probeResume). Dazu eine Obergrenze je Stunde und Gerät, die nur bremst, bis
// wieder Platz im Stundenfenster ist; gezählt wird, was bei IBS5 ankommt (jede
// Abfrage samt CORS-Vorabfrage doppelt). Seite und Service Worker teilen den
// Zustand über IndexedDB.

import { BASE_URL, IbsError } from "./ibs.js";
import { kvDel, kvGet, kvSet, kvUpdate } from "./idb.js";

const PAUSE_MS = 60 * 60 * 1000;
/** Stufen der Pause nach Schweigen beim Login; die Stufe gilt sechs Stunden, bis eine Antwort glückt. */
const SILENT_PAUSES_MS = [10, 30, 60].map((m) => m * 60 * 1000);
const SILENT_REPEAT_MS = 6 * 3600 * 1000;
/** Schweigen binnen dieser Zeit nach dem vorigen ist dieselbe Störung (etwa Abschicken, dann Nachladen). */
const SILENT_SAME_MS = 5 * 60 * 1000;
const HOUR_CAP = 150;

/**
 * Lädt eine Datei von IBS5 als Bild: true, wenn sie kommt (Verbindung nicht
 * gesperrt), false, wenn nicht, null, wo es keine Bilder gibt (Service Worker)
 * oder die Seite nicht über HTTPS läuft (Tests, lokal: dort nie echte Anfragen an
 * IBS5). Tests ersetzen reachability.probe.
 */
function imgProbe(timeoutMs = 8000) {
  if (typeof Image === "undefined" || globalThis.location?.protocol !== "https:") return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => { clearTimeout(t); img.onload = img.onerror = null; resolve(ok); };
    const t = setTimeout(() => { img.src = ""; done(false); }, timeoutMs);
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = `${BASE_URL}/img/Logos/sunshine-logo.png?t=${Date.now()}`;
  });
}
export const reachability = { probe: imgProbe };

/** Uhrzeit in Berlin, „07:21“. */
export const hhmm = (t) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })
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

/**
 * Aktive Pause oder null; in einem anderen Netz als bei ihrem Beginn gilt sie nicht.
 * maxAgeMs: eine Pause, die länger läuft, gilt hier nicht mehr (Weckruf, sw.js).
 */
export async function paused(maxAgeMs = null) {
  const p = await kvGet("ibsPause");
  if (!p || p.until <= Date.now()) return null;
  if (maxAgeMs != null && Date.now() - p.at > maxAgeMs) return null;
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

/** Während einer Pause: glückt die Probe, endet sie. true, wenn keine Pause mehr gilt. */
export async function probeResume() {
  if (!(await paused())) return true;
  if (!(await reachability.probe())) return false;
  await kvDel("ibsPause");
  return true;
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
  async before({ weight = 1, unmetered: free = false, pauseMaxAgeMs = null } = {}) {
    const p = await paused(pauseMaxAgeMs);
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
      // Lädt das Logo, ist die Verbindung nicht gesperrt: ein Aussetzer, keine Pause.
      if (await reachability.probe()) return;
      const now = Date.now();
      const prev = await kvGet("ibsSilent");
      let step = 0;
      if (prev && now - prev.at < SILENT_REPEAT_MS) step = now - prev.at < SILENT_SAME_MS ? prev.step : prev.step + 1;
      step = Math.min(step, SILENT_PAUSES_MS.length - 1);
      await kvSet("ibsSilent", { at: now, step });
      return pause("keine Antwort beim Anmelden", SILENT_PAUSES_MS[step]);
    }
  },
  /** Eine geglückte Antwort beendet die Zählung des Schweigens. */
  async ok() {
    if (await kvGet("ibsSilent").catch(() => null)) await kvDel("ibsSilent");
  },
};
