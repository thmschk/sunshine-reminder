// Service Worker (als Modul registriert): hält die App-Hülle vor und prüft beim
// Weckruf des Servers selbst bei IBS5, ob etwas offen ist. Der Server erfährt
// davon nichts; er schickt nur {"t":"check"} zur gewählten Uhrzeit.
import {
  AlarmText, DEFAULT_CHECK, De, IbsAuthError, IbsClient, collect, evaluate, targetDates, todayBerlin,
} from "./ibs.js";
import { kvGet, kvSet, secretGet } from "./idb.js";

const VERSION = "v17";
const PUSH_MAX_DAYS = 5;
const SHELL = ["./", "index.html", "app.js", "ibs.js", "idb.js", "style.css", "icon.svg", "icon-192.png", "badge-96.png", "manifest.webmanifest"];

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
  try { kind = ev.data?.json()?.t || "check"; } catch { /* leerer Push */ }
  ev.waitUntil(checkAndNotify(kind === "test"));
});

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
  const client = new IbsClient();
  let days;
  let firstName = "";
  try {
    firstName = (await client.login(creds.customerNo, creds.password)).firstName;
    days = await collect(client, dates);
  } catch (e) {
    const title = e instanceof IbsAuthError && !client.token ? "Anmeldung abgelehnt" : "Bestellstand unbekannt";
    return notify(prefix + title, `${e.message}\nEin Fehler ist keine Aussage darüber, ob bestellt ist.`, { url: "./" });
  }

  const alarm = evaluate(days);
  if (alarm.kind === "ok") {
    const until = days.length ? `bis ${De.long(days.at(-1).date)}` : "Keine Schultage im Prüfzeitraum";
    return notify(`${prefix}Alles bestellt ✓`, until, { silent: true, url: "./" });
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
