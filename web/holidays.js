// Berliner Schulferien aus ferien.json (erzeugt von tools/ferien.py, liegt
// neben der Seite; niemand fragt zur Laufzeit einen fremden Dienst). Ob ein
// Kind in den Ferien isst (Hort), legt man je Kind fest: Bei „nein“ ist ein
// offener Ferientag kein Alarm; ohne Antwort wird erinnert wie an jedem Tag.
// Hinter „until“ sind die Ferien unbekannt, dort gilt jeder Tag als Schultag.

import { accountKey } from "./accounts.js";
import { addDays } from "./ibs.js";
import { kvGet, kvSet } from "./idb.js";

const KEY = "ferien";
const PREF = "ferienEssen";
/** So lange vor Ferienbeginn fragt die Startseite, ob in den Ferien bestellt wird. */
export const ASK_DAYS = 21;

let loaded = null;

/** Ferientermine; ohne Netz der zuletzt gelesene Stand, sonst keine. */
export function loadHolidays() {
  loaded ??= (async () => {
    try {
      const res = await fetch(new URL("ferien.json", import.meta.url), { cache: "no-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      if (!Array.isArray(doc?.holidays) || !doc.until) throw new Error("ferien.json unvollständig");
      await kvSet(KEY, doc).catch(() => {});
      return doc;
    } catch {
      return (await kvGet(KEY).catch(() => null)) || { until: "", holidays: [] };
    }
  })();
  return loaded;
}

/** Name der Ferien an diesem Tag, sonst null. */
export function holidayOn(doc, date) {
  if (!doc || date > doc.until) return null;
  return doc.holidays.find((h) => h.start <= date && date <= h.end)?.name ?? null;
}

/** Laufende oder spätestens in ASK_DAYS beginnende Ferien, sonst null. */
export function nextHoliday(doc, today, within = ASK_DAYS) {
  const last = addDays(today, within);
  return doc?.holidays.find((h) => h.end >= today && h.start <= last && h.start <= doc.until) ?? null;
}

/** true: in den Ferien bestellen und erinnern, false: nicht, undefined: noch nicht gefragt. */
export const loadMealPref = (customerNo) => kvGet(accountKey(PREF, customerNo)).catch(() => undefined);
export const saveMealPref = (customerNo, on) => kvSet(accountKey(PREF, customerNo), !!on);

/** Tage, an denen ein offener Tag gewollt ist: Ferien bei Kindern ohne Ferienessen. */
export const skipDates = (doc, pref, dates) => new Set(pref === false ? dates.filter((d) => holidayOn(doc, d)) : []);

/** „19.10.–31.10.“ bzw. „15.05.“ für eintägige. */
export function rangeText(h) {
  const f = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
  return h.start === h.end ? f(h.start) : `${f(h.start)}–${f(h.end)}`;
}

