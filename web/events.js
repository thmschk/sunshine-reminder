// Eigene Termine (Ausflug, Wandertag …) mit Erinnerung einige Tage vorher.
// Liegen nur auf dem Gerät (IndexedDB), nie auf dem Server; Seite und Service
// Worker teilen sie. „kein Schulessen“ heißt: an dem Tag wird nichts gebraucht —
// ein offener Tag ist dann kein Alarm, ein bestellter soll abbestellt werden.
// who: Kundennummer, wenn der Termin nur ein Kind betrifft; sonst gilt er für alle.

import { addDays, De, OrderState } from "./ibs.js";
import { kvGet, kvSet } from "./idb.js";

const KEY = "events";
/** Wählbarer Vorlauf in Tagen. */
export const LEADS = [1, 2, 3, 7];

/** Kommende Termine nach Datum; vergangene werden dabei gelöscht. */
export async function loadEvents(today) {
  const all = (await kvGet(KEY)) || [];
  const upcoming = all.filter((e) => e.date >= today).sort((a, b) => a.date.localeCompare(b.date));
  if (upcoming.length !== all.length) await kvSet(KEY, upcoming).catch(() => {});
  return upcoming;
}

export async function addEvent(today, { title, date, lead, noMeal, who = null }) {
  const list = await loadEvents(today);
  list.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title, date, lead, noMeal: !!noMeal, who: who || null });
  await kvSet(KEY, list.sort((a, b) => a.date.localeCompare(b.date)));
}

export async function removeEvent(today, id) {
  await kvSet(KEY, (await loadEvents(today)).filter((e) => e.id !== id));
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
