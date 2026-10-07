// Service Worker (als Modul registriert): hält die App-Hülle vor und prüft beim
// Weckruf des Servers selbst bei IBS5, ob etwas offen ist. Der Server erfährt
// davon nichts; er schickt nur {"t":"check"} zur gewählten Uhrzeit.
import {
  AlarmText, DEFAULT_CHECK, De, IbsAuthError, IbsClient, addDays, collect, evaluate, targetDates, todayBerlin,
} from "./ibs.js";
import { kvGet, kvSet, secretGet } from "./idb.js";
import * as Sdui from "./sdui.js";
import { IbsPausedError, guardHooks } from "./guard.js";
import { withSession } from "./session.js";

const VERSION = "v43";
const PUSH_MAX_DAYS = 5;
const SHELL = ["./", "index.html", "app.js", "ibs.js", "idb.js", "style.css", "icon.svg", "icon-192.png", "badge-96.png", "manifest.webmanifest", "sdui.js", "guard.js", "session.js"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Netz zuerst, damit ein Deploy sofort ankommt; Cache nur, wenn offline.
self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin !== self.location.origin || ev.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  ev.respondWith(
    fetch(ev.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(ev.request, copy));
        }
        return resp;
      })
      .catch(() => caches.match(ev.request)),
  );
});

// ---------------------------------------------------------------- Push

/**
 * Jeder Push MUSS eine Meldung zeigen (Chrome und Safari verlangen das, iOS
 * kündigt sonst das Abo). Ist nichts Neues offen, kommt die Meldung deshalb
 * still: gleiche Aussage, aber ohne Ton und Vibration.
 */
self.addEventListener("push", (ev) => {
  let kind = "check";
  let message = "";
  try {
    const d = ev.data?.json();
    kind = d?.t || "check";
    message = d?.m || "";
  } catch { /* leerer Push */ }
  if (kind === "alarm") {
    // Nur an Betreiber-Abos: die tägliche Selbstprüfung des Servers hat etwas gefunden.
    ev.waitUntil(notify("Selbstprüfung: Abweichung", message || "Details unter /api/health", { url: "/api/health" }));
    return;
  }
  // Essen zuerst: Android dämpft eine zweite Meldung kurz danach, die wichtigere kommt also vorn.
  // Was auch immer schiefgeht, eine Meldung muss erscheinen — sonst kündigt iOS das Abo.
  ev.waitUntil((async () => {
    try {
      await checkAndNotify(kind === "test");
    } catch (e) {
      await notify("Prüfung fehlgeschlagen", `${e?.message || e}\nBitte die App öffnen.`, { url: "./" }).catch(() => {});
    }
    // „Jetzt testen“ in den Einstellungen wartet auf diese Bestätigung.
    if (kind === "test") {
      const [n] = await self.registration.getNotifications({ tag: "hs-check" });
      for (const w of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        w.postMessage({ testShown: n?.title || "Meldung" });
      }
    }
    await subjectReminder(kind === "test");
  })());
});

/** Gewählte Fächer am nächsten Schultag, wie SduiCheck der App; still, wenn nichts ansteht. */
async function subjectReminder(isTest) {
  try {
    const cfg = await Sdui.sduiConfig();
    if (!cfg?.subjects.length) return;
    const plan = await Sdui.cachedPlan();
    if (!plan?.lessons.length) return;
    const today = todayBerlin();
    const day = Sdui.nextSchoolDay(today);
    const found = Sdui.matches(plan.lessons, day, cfg.subjects);
    if (!found.length) return;
    const key = `${day}:${found.map((m) => m.subject).join(",")}`;
    if (!isTest && key === (await kvGet("sduiNotified"))) return;
    await kvSet("sduiNotified", key);
    const when = day === addDays(today, 1) ? "Morgen" : De.weekday(day);
    const lines = found.map((m) => m.subject + (m.label ? ` — ${m.label}` : "") + (m.notes.length ? ` (${m.notes.join("; ")})` : ""));
    await self.registration.showNotification(`${when} ${found.map((m) => m.subject).join(" und ")}`, {
      body: lines.join("\n") + (cfg.childName ? `\nfür ${cfg.childName}` : ""),
      icon: "icon-192.png",
      badge: "badge-96.png",
      tag: "hs-sdui",
      data: { url: "./" },
    });
  } catch {
    // Der Stundenplan ist Zugabe: ein Fehler hier darf nichts weiter stören.
  }
}


// Beim Test („Jetzt testen“) dieselbe Meldung wie beim echten Weckruf, nur immer laut.
async function checkAndNotify(isTest) {
  const prefix = "";
  const creds = await secretGet("creds");
  if (!creds) {
    return notify(`${prefix}Nicht angemeldet`, "Bitte die Seite öffnen und anmelden.", { url: "./" });
  }
  const daysAhead = (await kvGet("daysAhead")) || 7;
  // Höchstens die nächsten Schultage: auf dem Handy kostet jeder Tag eine
  // Anfrage, und zu viele quittiert IBS5 mit einer IP-Sperre.
  const dates = targetDates(todayBerlin(), { ...DEFAULT_CHECK, daysAhead }).slice(0, PUSH_MAX_DAYS);
  const client = new IbsClient(undefined, guardHooks);
  client.dayView = !!(await kvGet("ibsDayView"));
  client.dayStore = { load: () => kvGet("dayCache"), save: (rows) => kvSet("dayCache", rows) };
  let days;
  let firstName = "";
  try {
    days = await withSession(client, creds, () => collect(client, dates, { history: true }));
    firstName = client.profile?.firstName || "";
  } catch (e) {
    const title = e instanceof IbsPausedError ? "Bestellsystem gesperrt oder nicht erreichbar"
      : e instanceof IbsAuthError && !client.token ? "Anmeldung abgelehnt" : "Bestellstand unbekannt";
    return notify(prefix + title, `${e.message}\nEin Fehler ist keine Aussage darüber, ob bestellt ist.`, { url: "./" });
  }

  await kvSet("lastPushOk", { at: Date.now() });
  const alarm = evaluate(days);
  if (alarm.kind === "ok") {
    const until = days.length ? `bis ${De.long(days.at(-1).date)}` : "Keine Schultage im Prüfzeitraum";
    return notify(`${prefix}satt … theoretisch ✓`, until, { silent: true, url: "./" });
  }

  // Wie NotifiedDays der App: laut nur, wenn ein Tag in diesem Zustand neu ist.
  const today = todayBerlin();
  const known = new Set(((await kvGet("notified")) || []).filter((k) => k.slice(0, 10) >= today));
  const keys = [...alarm.actionable, ...alarm.tooLate, ...alarm.unclear].map((d) => `${d.date}:${d.state}`);
  const fresh = isTest || keys.some((k) => !known.has(k));
  await kvSet("notified", [...new Set([...known, ...keys])]);

  const first = alarm.actionable[0]?.date;
  return notify(prefix + AlarmText.title(alarm, firstName), AlarmText.body(alarm), {
    silent: !fresh,
    url: first ? `./?order=${first}` : "./",
  });
}

function notify(title, body, { silent = false, url = "./" } = {}) {
  return self.registration.showNotification(title, {
    body,
    icon: "icon-192.png",
    // Kleines Symbol in Statusleiste und Kopf der Meldung; ohne zeigt Android das Chrome-Logo.
    badge: "badge-96.png",
    tag: "hs-check",
    renotify: !silent,
    silent,
    data: { url },
  });
}

self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  const target = new URL(ev.notification.data?.url || "./", self.registration.scope).href;
  ev.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) {
      await win.navigate(target).catch(() => {});
      return win.focus();
    }
    return self.clients.openWindow(target);
  })());
});

// Der Browser hat das Abo erneuert: dem Server die neue Adresse melden.
self.addEventListener("pushsubscriptionchange", (ev) => {
  ev.waitUntil((async () => {
    const push = await kvGet("push");
    if (!push) return;
    const key = (await (await fetch("/api/vapid")).json()).publicKey;
    const sub = ev.newSubscription ?? await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(key),
    });
    await fetch(`/api/subscriptions/${push.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${push.secret}` },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });
  })());
});

function b64ToBytes(b64) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
