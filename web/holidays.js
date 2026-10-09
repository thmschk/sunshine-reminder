// Berliner Schulferien aus ferien.json (erzeugt von tools/ferien.py, liegt
// neben der Seite; niemand fragt zur Laufzeit einen fremden Dienst). Ob ein
// Kind in den Ferien isst (Hort), legt man je Kind und Ferienwoche fest: In
// einer Woche mit „nein“ ist ein offener Ferientag kein Alarm; ohne Antwort
// wird erinnert wie an jedem Tag. Vor allen Ferien wird neu gefragt.
// Hinter „until“ sind die Ferien unbekannt, dort gilt jeder Tag als Schultag.

import { accountKey } from "./accounts.js";
import { addDays, weekdayNo } from "./ibs.js";
import { kvGet, kvSet } from "./idb.js";

const KEY = "ferien";
const PREF = "ferienEssen";
const LATER = "ferienSpaeter";
/**
 * Die Startseite fragt ab Vorwarnzeit + ASK_LEAD Tage vor Ferienbeginn: kurz bevor
 * der erste Ferientag in die Erinnerung rutscht, auch über ein Wochenende ohne App.
 */
const ASK_LEAD = 2;
export const askWithin = (daysAhead) => daysAhead + ASK_LEAD;

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

/** Montag der Woche. */
export const weekOf = (date) => addDays(date, 1 - weekdayNo(date));

/** Werktage der Ferien je Woche: [{ monday, dates }]; Wochen nur mit Wochenende fallen weg. */
export function holidayWeeks(doc, h) {
  const weeks = [];
  const end = h.end < doc.until ? h.end : doc.until;
  for (let d = h.start; d <= end; d = addDays(d, 1)) {
    if (weekdayNo(d) > 5) continue;
    const monday = weekOf(d);
    if (weeks.at(-1)?.monday !== monday) weeks.push({ monday, dates: [] });
    weeks.at(-1).dates.push(d);
  }
  return weeks;
}

/** Ferienwochen, die heute noch Werktage haben. */
export const openWeeks = (doc, h, today) => holidayWeeks(doc, h).filter((w) => w.dates.at(-1) >= today);

/** Laufende oder spätestens in `within` Tagen beginnende Ferien mit noch offenen Werktagen, sonst null. */
export function nextHoliday(doc, today, within) {
  const last = addDays(today, within);
  return doc?.holidays.find((h) => h.end >= today && h.start <= last && h.start <= doc.until
    && openWeeks(doc, h, today).length) ?? null;
}

/** Offene Ferienwochen ohne Antwort. */
export const unanswered = (doc, h, prefs, today) => openWeeks(doc, h, today).filter((w) => typeof prefs[w.monday] !== "boolean");

/** { Montag: true (Essen, erinnern) | false (kein Essen) }; fehlt eine Woche, ist sie nicht gefragt. */
export async function loadMealPref(customerNo) {
  const v = await kvGet(accountKey(PREF, customerNo)).catch(() => undefined);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

/** Antworten für einzelne Wochen übernehmen; vergangene Wochen fallen dabei heraus. */
export async function saveMealPref(customerNo, answers, today) {
  const keep = Object.entries(await loadMealPref(customerNo)).filter(([monday]) => addDays(monday, 6) >= today);
  await kvSet(accountKey(PREF, customerNo), { ...Object.fromEntries(keep), ...answers });
}

/** Tage, an denen ein offener Tag gewollt ist: Ferientage in Wochen ohne Ferienessen. */
export const skipDates = (doc, prefs, dates) =>
  new Set(dates.filter((d) => holidayOn(doc, d) && prefs?.[weekOf(d)] === false));

/** „Später“: heute nicht mehr von selbst fragen. */
export const askedLater = async (customerNo, today) => (await kvGet(accountKey(LATER, customerNo)).catch(() => null)) === today;
export const askLater = (customerNo, today) => kvSet(accountKey(LATER, customerNo), today);

const dm = (d) => `${d.slice(8, 10)}.${d.slice(5, 7)}.`;
const span = (a, b) => (a === b ? dm(a) : `${dm(a)}–${dm(b)}`);
/** „19.10.–31.10.“ bzw. „15.05.“ für eintägige. */
export const rangeText = (h) => span(h.start, h.end);
/** Werktage einer Ferienwoche, „19.10.–23.10.“. */
export const weekText = (w) => span(w.dates[0], w.dates.at(-1));

