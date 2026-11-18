// Abo der Erinnerung beim Server. Seite (Selbstheilung beim Öffnen, „Jetzt testen“,
// „Erinnerung reparieren“) und Service Worker (pushsubscriptionchange) nutzen es gemeinsam.

import { kvSet } from "./idb.js";

/**
 * Betreiber-Abo laut Server (is_admin): kv "operator" (zeigt Selbstprüfungs-Alarme mit Text,
 * sw.js), "wasOperator" bleibt nach einmal true stehen. Fehlt das Feld, bleibt alles, wie es ist.
 */
async function noteOperator(body) {
  if (typeof body?.is_admin !== "boolean") return;
  await kvSet("operator", body.is_admin).catch(() => {});
  if (body.is_admin) await kvSet("wasOperator", true).catch(() => {});
}

/**
 * Neue Abo-Adresse dem Server melden. Kennt der Server das Abo nicht mehr (404),
 * wird es mit den gespeicherten Einstellungen neu angelegt und Kennung samt
 * Geheimnis ersetzt. Wirft, wenn das nicht gelingt. Bleibt das Abo, kommt dasselbe push-Objekt
 * zurück (die Seite erkennt daran, dass nichts neu ist); is_admin steht dann nur in kv "operator".
 */
export async function renewPush(push, subscription, { fetch: f = fetch, weekdays } = {}) {
  const put = await f(`/api/subscriptions/${push.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${push.secret}` },
    body: JSON.stringify({ subscription }),
  });
  if (put.ok) {
    await noteOperator(typeof put.json === "function" ? await put.json().catch(() => null) : null);
    return push;
  }
  if (put.status !== 404) throw new Error(`Server: HTTP ${put.status}`);
  const post = await f("/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, time: push.time, morning_time: push.morning || null, weekdays, tz: "Europe/Berlin" }),
  });
  if (!post.ok) throw new Error(`Server: HTTP ${post.status}`);
  const body = await post.json();
  const { id, secret } = body;
  if (!id || !secret) throw new Error("Server: Antwort ohne Kennung");
  await noteOperator(body);
  return typeof body.is_admin === "boolean" ? { ...push, id, secret, is_admin: body.is_admin } : { ...push, id, secret };
}

/** Arten der Weckrufe ({"t": …} im Payload), die sw.js kennt; der Server prüft seinen Vertrag dagegen. */
export const PUSH_KINDS = ["check", "today", "test", "today-test", "alarm"];

const BERLIN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const berlinParts = (t) => {
  const p = Object.fromEntries(BERLIN.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
};
/** Zeitpunkt der Berliner Uhrzeit h:mi am Kalendertag y-mo-d, gleich welche Zeitzone das Gerät hat. */
function berlinAt(y, mo, d, h, mi) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let t = wall;
  for (let i = 0; i < 2; i++) {
    const p = berlinParts(t);
    t = wall - (Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - t);
  }
  return t;
}

/** So weit verschiebt der Server einen Weckruf höchstens nach hinten. */
const SLOT_LATE_MS = 30 * 60 * 1000;
/** Ein Erfolg kurz vor der Uhrzeit (Uhren gehen nicht gleich) gehört schon zu diesem Weckruf. */
const SLOT_EARLY_MS = 5 * 60 * 1000;

/**
 * Wie viele fällige Erinnerungen seit since (letzter angekommener Weckruf) ausblieben: je
 * gewähltem Wochentag die Uhrzeit in Berlin. Ein Weckruf zählt, wenn er nach since fällig
 * wurde (der Weckruf von since selbst also nicht) und auch mit 30 min Spielraum vor now
 * hätte da sein müssen. weekdays: 1 = Montag … 5 = Freitag.
 */
export function missedSlots(since, time, weekdays, now = Date.now()) {
  if (!since || !/^\d{2}:\d{2}$/.test(time || "")) return 0;
  const [h, mi] = time.split(":").map(Number);
  const s = berlinParts(since);
  let n = 0;
  for (let day = Date.UTC(s.y, s.mo - 1, s.d); ; day += 24 * 3600 * 1000) {
    const d = new Date(day);
    const slot = berlinAt(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi);
    if (slot >= now) break;
    const wd = ((d.getUTCDay() + 6) % 7) + 1;
    if (weekdays.includes(wd) && slot - SLOT_EARLY_MS > since && slot + SLOT_LATE_MS < now) n++;
  }
  return n;
}
