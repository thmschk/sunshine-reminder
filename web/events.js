// Eigene Termine (Ausflug, Wandertag …) mit Erinnerung einige Tage vorher.
// Liegen nur auf dem Gerät (IndexedDB), nie auf dem Server; Seite und Service
// Worker teilen sie. „kein Schulessen“ heißt: an dem Tag wird nichts gebraucht —
// ein offener Tag ist dann kein Alarm, ein bestellter soll abbestellt werden.
// who: Kundennummer, wenn der Termin nur ein Kind betrifft; sonst gilt er für alle.

import { addDays, De, OrderState } from "./ibs.js";
import { kvRead, kvUpdate } from "./idb.js";

const KEY = "events";
/** Wählbarer Vorlauf in Tagen. */
export const LEADS = [1, 2, 3, 7];

const byDate = (a, b) => a.date.localeCompare(b.date);
const upcomingOf = (all, today) => (Array.isArray(all) ? all : []).filter((e) => e.date >= today).sort(byDate);

/**
 * Kommende Termine nach Datum; vergangene werden dabei gelöscht. Ein Fehler des
 * Speichers wird geworfen, nicht als „keine Termine“ gemeldet.
 */
export async function loadEvents(today) {
  const all = await kvRead(KEY);
  const upcoming = upcomingOf(all, today);
  if (Array.isArray(all) && upcoming.length !== all.length) {
    await kvUpdate(KEY, (cur) => (Array.isArray(cur) ? { value: upcomingOf(cur, today) } : {})).catch(() => {});
  }
  return upcoming;
}

// Ändern in einer Transaktion (kvUpdate): Ist der Speicher nicht lesbar, wird
// nichts geschrieben, und ein gleichzeitiger Schreiber (Seite oder Service
// Worker) wird nicht mit altem Stand überschrieben.
export async function addEvent(today, { title, date, lead, noMeal, who = null }) {
  const event = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, date, lead, noMeal: !!noMeal, who: who || null };
  await kvUpdate(KEY, (cur) => ({ value: [...upcomingOf(cur, today), event].sort(byDate) }));
}

export async function removeEvent(today, id) {
  await kvUpdate(KEY, (cur) => ({ value: upcomingOf(cur, today).filter((e) => e.id !== id) }));
}

/** Termine, die ein Konto betreffen: seine eigenen und die für alle. */
export const eventsFor = (events, customerNo) => events.filter((e) => !e.who || e.who === customerNo);

/** Fällig: ab „Vorlauf Tage vorher“ bis zum Tag selbst. So erinnert auch ein Weckruf nach dem Wochenende. */
export const dueEvents = (events, today) => events.filter((e) => e.date >= today && addDays(e.date, -e.lead) <= today);

/** Tage ohne Schulessen: dort ist „nicht bestellt“ gewollt. */
export const noMealDates = (events) => new Set(events.filter((e) => e.noMeal).map((e) => e.date));

/** Bestellt an einem Tag ohne Schulessen → abbestellen. day kann fehlen (Stand unbekannt). */
export const needsCancel = (e, day) => e.noMeal && day?.state === OrderState.ORDERED;

const whenText = (date, today) => date === today ? "Heute" : date === addDays(today, 1) ? "Morgen" : De.chip(date);

/** Eine Zeile für Meldung und Karte. */
export function eventLine(e, day, today) {
  const head = `${whenText(e.date, today)}: ${e.title}`;
  if (!e.noMeal) return head;
  if (needsCancel(e, day)) return `${head} — Essen ist bestellt, bitte abbestellen`;
  return day ? `${head} — kein Schulessen, nichts bestellt ✓` : `${head} — kein Schulessen`;
}
