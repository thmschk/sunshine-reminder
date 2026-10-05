// Stundenplan aus Sdui, nur lesend. Portiert aus android/core SduiClient und
// SubjectReminder. Sdui sperrt Browserzugriffe fremder Seiten, deshalb laufen die
// Aufrufe über /api/sdui/ auf unserem Server, der sie nur durchreicht.
//
// Das Passwort wird nur beim Einrichten gebraucht: Sdui gibt einen Token aus, der
// ein Jahr gilt; nur der bleibt (verschlüsselt) auf dem Gerät.

import { addDays, todayBerlin, weekdayNo } from "./ibs.js";
import { kvGet, kvSet, secretGet } from "./idb.js";

export class SduiError extends Error {}
export class SduiAuthError extends SduiError {}

async function call(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  let r;
  try {
    r = await fetch(`/api/sdui/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new SduiError(`Sdui nicht erreichbar: ${e.message}`);
  }
  const obj = await r.json().catch(() => null);
  const errors = obj?.meta?.errors?.filter((x) => typeof x === "string").join("; ");
  if (r.status === 401 || r.status === 403) throw new SduiAuthError(`Sdui: ${errors || `HTTP ${r.status}`}`);
  if (r.status === 429) throw new SduiError("Zu viele Sdui-Anfragen, bitte in ein paar Minuten nochmal.");
  if (!r.ok) throw new SduiError(`Sdui: ${errors || `HTTP ${r.status}`}`);
  if (!obj) throw new SduiError("Sdui: kein JSON");
  return obj;
}

/** Nimmt die ganze Login-Adresse `sdui.app/<schule>/login` oder nur das Kürzel. */
export function parseSlink(input) {
  let t = input.trim().replace(/\/+$/, "");
  if (t.includes("sdui.app/")) t = t.slice(t.indexOf("sdui.app/") + 9);
  return t.split("/")[0].trim();
}

/** @returns {Promise<{token: string, expires: number}>} expires in ms seit 1970 */
export async function login(identifier, password, slink) {
  const obj = await call("auth/login", { method: "POST", body: { identifier, password, slink } });
  const token = obj?.data?.access_token;
  if (!token) throw new SduiAuthError(obj?.meta?.errors?.join("; ") || "Sdui-Anmeldung abgelehnt");
  const secs = Number(obj.data.expires_in) || 365 * 86400;
  return { token, expires: Date.now() + secs * 1000 };
}

const displayName = (u) =>
  u?.meta?.displayname || [u?.firstname, u?.lastname].filter(Boolean).join(" ");

/** Die Kinder am eigenen Konto; ein Schülerkonto liefert sich selbst. */
export async function children(token) {
  const self = (await call("users/self", { token })).data;
  const ids = (self?.child_pivot || []).map((p) => p?.user_id).filter((x) => Number.isInteger(x));
  if (!ids.length) return self?.id ? [{ id: self.id, name: displayName(self) }] : [];
  const out = [];
  for (const id of ids) {
    const user = await call(`users/${id}`, { token }).then((o) => o.data).catch(() => null);
    out.push({ id, name: displayName(user) || `Kind ${id}` });
  }
  return out;
}

const berlin = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function local(epochSecs) {
  const p = Object.fromEntries(berlin.formatToParts(new Date(epochSecs * 1000)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** „SoL“ → „SOL“, „D/SL“ → „DSL“, „Sport“ → „SPO“ — wie SubjectReminder.shortLabel. */
export function shortLabel(raw) {
  const s = [...(raw || "")].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("").toUpperCase().slice(0, 3);
  return s || (raw || "").trim().toUpperCase().slice(0, 3);
}

/**
 * Stunden von `from` bis `to` (beide einschließlich), nach Beginn sortiert.
 * @returns {Promise<{date: string, time: string, hour: string, subject: string, short: string, note: string}[]>}
 */
export async function timetable(token, userId, from, to) {
  const obj = await call(`timetables/users/${userId}/timetable?begins_at=${from}&ends_at=${to}`, { token });
  const lessons = obj?.data?.lessons || [];
  return lessons.flatMap((o) => {
    if (!Number.isFinite(Number(o?.begins_at))) return [];
    const m = o.meta || {};
    const { date, time } = local(Number(o.begins_at));
    return [{
      date,
      time,
      hour: String(m.displayname_hour ?? ""),
      subject: m.displayname || m.shortname || "",
      short: shortLabel(m.shortname || m.displayname),
      note: [o.kind, o.comment].filter((x) => x && x !== "null").join("; "),
    }];
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** Nächster Werktag nach `today` — am Freitag also der Montag. */
export function nextSchoolDay(today) {
  let d = addDays(today, 1);
  while (weekdayNo(d) > 5) d = addDays(d, 1);
  return d;
}

export const knownSubjects = (lessons) =>
  [...new Set(lessons.map((l) => l.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));

/** Die gewählten Fächer an `date`, je Fach zusammengefasst, mit Stunden und Hinweisen. */
export function matches(lessons, date, subjects) {
  const by = new Map();
  for (const l of lessons) {
    if (l.date !== date || !subjects.includes(l.subject)) continue;
    if (!by.has(l.subject)) by.set(l.subject, { subject: l.subject, hours: [], notes: [] });
    const m = by.get(l.subject);
    m.hours.push(l.hour);
    if (l.note) m.notes.push(l.note);
  }
  return [...by.values()].map((m) => ({ ...m, notes: [...new Set(m.notes)], label: hoursLabel(m.hours) }));
}

/** „1.–2. Stunde“, „3. Stunde“ oder leer. */
export function hoursLabel(hours) {
  const n = [...new Set(hours.map((h) => parseInt(h, 10)).filter(Number.isInteger))].sort((a, b) => a - b);
  if (!n.length) return "";
  if (n.length === 1) return `${n[0]}. Stunde`;
  if (n.every((x, i) => i === 0 || x === n[i - 1] + 1)) return `${n[0]}.–${n.at(-1)}. Stunde`;
  return `${n.map((x) => `${x}.`).join(", ")} Stunde`;
}

/** Plan je Tag und Stundennummer für die Zeitleiste; Stunden ohne Nummer fehlen dort. */
export function planByDay(lessons) {
  const out = new Map();
  for (const l of lessons) {
    const h = parseInt(l.hour, 10);
    if (!Number.isInteger(h)) continue;
    if (!out.has(l.date)) out.set(l.date, new Map());
    const day = out.get(l.date);
    if (!day.has(h)) day.set(h, []);
    day.get(h).push(l);
  }
  return out;
}

// ---------------------------------------------------------------- Zwischenspeicher

/** Wie oft der Plan höchstens neu geladen wird; er ändert sich selten. */
const PLAN_MAX_AGE_MS = 6 * 3600 * 1000;
const PLAN_DAYS = 14; // zwei Wochen, wegen A/B-Wochen für die Fächerauswahl

/** Zugang und Auswahl; null, wenn Sdui nicht eingerichtet ist. */
export async function sduiConfig() {
  const acc = await secretGet("sdui").catch(() => undefined);
  if (!acc?.token || !acc?.childId) return null;
  const subjects = (await kvGet("sduiSubjects")) || [];
  return { ...acc, subjects };
}

/**
 * Plan der nächsten zwei Wochen, höchstens alle paar Stunden frisch geladen.
 * @returns {Promise<{lessons: object[], error: string|null}|null>} null = nicht eingerichtet
 */
export async function cachedPlan({ force = false } = {}) {
  const cfg = await sduiConfig();
  if (!cfg) return null;
  const today = todayBerlin();
  const cache = await kvGet("sduiPlan");
  const fresh = cache && cache.from === today && Date.now() - cache.at < PLAN_MAX_AGE_MS;
  if (fresh && !force) return { lessons: cache.lessons, error: null };
  if (cfg.expires && cfg.expires < Date.now()) {
    return { lessons: cache?.lessons || [], error: "Sdui-Zugang abgelaufen, bitte in den Einstellungen neu verbinden." };
  }
  try {
    const lessons = await timetable(cfg.token, cfg.childId, today, addDays(today, PLAN_DAYS));
    await kvSet("sduiPlan", { at: Date.now(), from: today, lessons });
    const known = new Set([...((await kvGet("sduiKnown")) || []), ...knownSubjects(lessons)]);
    await kvSet("sduiKnown", [...known].sort((a, b) => a.localeCompare(b, "de")));
    return { lessons, error: null };
  } catch (e) {
    return { lessons: cache?.lessons || [], error: e.message };
  }
}
