// Service Worker (als Modul registriert): hält die App-Hülle vor und prüft beim
// Weckruf des Servers selbst bei IBS5, ob etwas offen ist. Der Server erfährt
// davon nichts; er schickt nur {"t":"check"} zur gewählten Uhrzeit.
import {
  AlarmText, DEFAULT_CHECK, De, IbsAuthError, IbsClient, addDays, collect, evaluate, nextWeekday, targetDates, todayBerlin,
} from "./ibs.js";
import { kvGet, kvSet } from "./idb.js";
import { accountLabel, dayStore, loadAccounts, upsertAccount } from "./accounts.js";
import * as Sdui from "./sdui.js";
import { IbsPausedError, guardHooks } from "./guard.js";
import { withSession } from "./session.js";
import { dueEvents, eventLine, eventsFor, loadEvents, needsCancel, noMealDates } from "./events.js";

const VERSION = "v47";
const PUSH_MAX_DAYS = 5;
const SHELL = ["./", "index.html", "app.js", "ibs.js", "idb.js", "style.css", "icon.svg?v=2", "icon-192.png?v=2", "badge-96.png?v=2", "manifest.webmanifest", "sdui.js", "guard.js", "session.js", "events.js", "accounts.js"];

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
      icon: "icon-192.png?v=2",
      badge: "badge-96.png?v=2",
      tag: "hs-sdui",
      data: { url: "./" },
    });
  } catch {
    // Der Stundenplan ist Zugabe: ein Fehler hier darf nichts weiter stören.
  }
}


/** Überschrift der Meldung, wenn die Prüfung eines Kontos scheitert. */
function failTitle(e, client) {
  return e instanceof IbsPausedError ? "Bestellsystem gesperrt oder nicht erreichbar"
    : e instanceof IbsAuthError && !client.token ? "Anmeldung abgelehnt" : "Bestellstand unbekannt";
}

/**
 * Ein Konto prüfen. Termine gelten je Kind (eigene und die für alle), deshalb
 * fragt jedes Konto seine eigenen Tage ohne Schulessen mit ab.
 */
async function checkAccount(account, checkDates, events, today) {
  const mine = eventsFor(events, account.customerNo);
  const due = dueEvents(mine, today);
  const noMeal = noMealDates(mine);
  const dates = [...new Set([...checkDates, ...due.filter((e) => e.noMeal).map((e) => e.date)])].sort();
  const client = new IbsClient(undefined, guardHooks);
  client.dayView = !!(await kvGet("ibsDayView"));
  client.dayStore = dayStore(client);
  const kid = { customerNo: account.customerNo, due, firstName: "" };
  try {
    kid.days = await withSession(client, account, () => collect(client, dates, { history: true }));
    kid.checked = kid.days.filter((d) => checkDates.includes(d.date) && !noMeal.has(d.date));
  } catch (e) {
    kid.error = e;
    kid.failTitle = failTitle(e, client);
  }
  kid.name = client.profile?.name || account.name || "";
  kid.firstName = client.profile?.firstName || "";
  return kid;
}

// Beim Test („Jetzt testen“) dieselbe Meldung wie beim echten Weckruf, nur immer laut.
// Mehrere Kinder nacheinander, nie parallel (IP-Sperre von IBS5), und eine gemeinsame
// Meldung: eine zweite kurz danach dämpft Android.
async function checkAndNotify(isTest) {
  const accounts = await loadAccounts();
  if (!accounts.length) {
    return notify("Nicht angemeldet", "Bitte die Seite öffnen und anmelden.", { url: "./" });
  }
  const daysAhead = (await kvGet("daysAhead")) || 7;
  const today = todayBerlin();
  // Höchstens die nächsten Schultage: auf dem Handy kostet jeder Tag eine
  // Anfrage, und zu viele quittiert IBS5 mit einer IP-Sperre.
  // Bis einschließlich zum nächsten Weckruf-Tag: dazwischen schaut keiner mehr nach.
  // Höchstens 5 Schultage reichen dafür auch bei nur einem Weckruf pro Woche.
  const pushDays = (await kvGet("pushWeekdays")) || DEFAULT_CHECK.weekdays;
  const coverUntil = nextWeekday(today, pushDays);
  const checkDates = targetDates(today, { ...DEFAULT_CHECK, daysAhead, coverUntil }).slice(0, PUSH_MAX_DAYS);
  const events = await loadEvents(today).catch(() => []);
  const kids = [];
  for (const account of accounts) kids.push(await checkAccount(account, checkDates, events, today));

  // Namen fürs Gerät merken (Reiter, Meldung), auch wenn die Seite seit dem Login nicht offen war.
  for (const [i, k] of kids.entries()) {
    if (k.name && k.name !== accounts[i].name) await upsertAccount({ ...accounts[i], name: k.name }).catch(() => {});
  }

  let msg;
  if (kids.length === 1) {
    const [k] = kids;
    if (k.error) return notify(k.failTitle, `${k.error.message}\nEin Fehler ist keine Aussage darüber, ob bestellt ist.`, { url: "./" });
    msg = compose({ checked: k.checked, due: k.due, days: k.days, today, firstName: k.firstName });
  } else {
    msg = composeAll(kids, today);
  }
  if (!kids.some((k) => k.error)) await kvSet("lastPushOk", { at: Date.now() });

  // Wie NotifiedDays der App: laut nur, wenn ein Tag oder Termin in diesem Zustand neu ist.
  const known = new Set(((await kvGet("notified")) || []).filter((k) => k.slice(0, 10) >= today));
  const fresh = isTest || msg.keys.some((k) => !known.has(k));
  await kvSet("notified", [...new Set([...known, ...msg.keys])]);
  return notify(msg.title, msg.body, { silent: msg.quiet || !fresh, url: msg.url });
}

/**
 * Meldung aus Bestellstand (checked: geprüfte Tage ohne „kein Schulessen“) und
 * fälligen eigenen Terminen. keys: Zustände für „laut nur bei Neuem“, je mit dem
 * Datum vorn, damit Vergangenes herausfällt; quiet: „alles bestellt“ kommt immer still.
 */
export function compose({ checked, due, days, today, firstName = "" }) {
  const alarm = evaluate(checked);
  const dayOf = (date) => days.find((d) => d.date === date);
  const cancel = due.find((e) => needsCancel(e, dayOf(e.date)));
  const keys = [
    ...[...alarm.actionable, ...alarm.tooLate, ...alarm.unclear].map((d) => `${d.date}:${d.state}`),
    ...due.map((e) => `${e.date}:ev:${e.id}${needsCancel(e, dayOf(e.date)) ? ":cancel" : ""}`),
  ];
  const evText = due.length ? `Termine:\n${due.map((e) => `  • ${eventLine(e, dayOf(e.date), today)}`).join("\n")}` : "";

  if (alarm.kind === "ok") {
    const until = checked.length ? `bis ${De.long(checked.at(-1).date)}` : "Keine Schultage im Prüfzeitraum";
    if (!due.length) return { title: "satt … theoretisch ✓", body: until, url: "./", keys, quiet: true };
    return {
      title: cancel ? `Essen abbestellen: ${cancel.title}` : due.length === 1 ? `Termin: ${due[0].title}` : `${due.length} Termine`,
      body: `${evText}\n\nSchulessen: alles bestellt ${until}`,
      url: cancel ? `./?order=${cancel.date}` : "./",
      keys,
      quiet: false,
    };
  }
  const first = alarm.actionable[0]?.date ?? cancel?.date;
  return {
    title: AlarmText.title(alarm, firstName),
    body: [AlarmText.body(alarm), evText].filter(Boolean).join("\n\n"),
    url: first ? `./?order=${first}` : "./",
    keys,
    quiet: false,
  };
}

const nameList = (names) => names.length > 1 ? `${names.slice(0, -1).join(", ")} und ${names.at(-1)}` : names[0] || "";

/**
 * Meldung für mehrere Kinder: je Kind ein Abschnitt, Termine einmal. keys wie
 * bei compose, aber mit der Kundennummer hinter dem Datum; url öffnet das Kind
 * mit dem ersten offenen Tag. kids: {customerNo, firstName, due, days, checked}
 * oder {customerNo, firstName, due, error, failTitle}.
 */
export function composeAll(kids, today) {
  const label = (k) => k.firstName || `Kd. ${k.customerNo}`;
  const keys = [];
  const sections = [];
  const alarmed = [];
  const failed = kids.filter((k) => k.error);
  let url = null;
  for (const k of kids) {
    if (k.error) {
      sections.push(`${label(k)}: ${k.failTitle}`);
      continue;
    }
    const alarm = evaluate(k.checked);
    keys.push(...[...alarm.actionable, ...alarm.tooLate, ...alarm.unclear].map((d) => `${d.date}:${k.customerNo}:${d.state}`));
    if (alarm.kind === "ok") {
      sections.push(`${label(k)}: alles bestellt ${k.checked.length ? `bis ${De.long(k.checked.at(-1).date)}` : "(keine Schultage im Prüfzeitraum)"}`);
      continue;
    }
    alarmed.push(k);
    sections.push(`${label(k)}: ${AlarmText.body(alarm)}`);
    if (!url && alarm.actionable.length) url = `./?order=${alarm.actionable[0].date}&k=${k.customerNo}`;
  }
  if (failed.length) sections.push(`${failed[0].error.message}\nEin Fehler ist keine Aussage darüber, ob bestellt ist.`);

  // Ein Termin für alle steht bei jedem Kind in due, gemeldet wird er einmal.
  const byId = new Map();
  for (const k of kids) {
    for (const e of k.due) {
      const day = k.days?.find((d) => d.date === e.date);
      const entry = byId.get(e.id) ?? { e, day, cancel: [] };
      if (needsCancel(e, day)) {
        entry.cancel.push(k);
        entry.day = day;
      }
      entry.day ??= day;
      byId.set(e.id, entry);
    }
  }
  const due = [...byId.values()].sort((a, b) => a.e.date.localeCompare(b.e.date));
  for (const { e, cancel } of due) keys.push(`${e.date}:ev:${e.id}${cancel.map((k) => `:cancel:${k.customerNo}`).join("")}`);
  const evLine = ({ e, day, cancel }) => {
    const who = e.who ? kids.filter((k) => k.customerNo === e.who) : cancel;
    return eventLine(e, day, today) + (who.length ? ` (${nameList(who.map(label))})` : "");
  };
  const firstCancel = due.find((x) => x.cancel.length);
  if (!url && firstCancel) url = `./?order=${firstCancel.e.date}&k=${firstCancel.cancel[0].customerNo}`;
  const evText = due.length ? `Termine:\n${due.map((x) => `  • ${evLine(x)}`).join("\n")}` : "";

  const title = alarmed.length === 1 ? AlarmText.title(evaluate(alarmed[0].checked), label(alarmed[0]))
    : alarmed.length ? `Schulessen prüfen für ${nameList(alarmed.map(label))}`
    : failed.length === kids.length ? failed[0].failTitle
    : failed.length ? `Bestellstand unbekannt für ${nameList(failed.map(label))}`
    : firstCancel ? `Essen abbestellen: ${firstCancel.e.title}`
    : due.length === 1 ? `Termin: ${due[0].e.title}`
    : due.length ? `${due.length} Termine`
    : "satt … theoretisch ✓";
  return {
    title,
    body: [...sections, evText].filter(Boolean).join("\n\n"),
    url: url || "./",
    keys,
    quiet: !alarmed.length && !failed.length && !due.length,
  };
}

function notify(title, body, { silent = false, url = "./" } = {}) {
  return self.registration.showNotification(title, {
    body,
    icon: "icon-192.png?v=2",
    // Kleines Symbol in Statusleiste und Kopf der Meldung; ohne zeigt Android das Chrome-Logo.
    badge: "badge-96.png?v=2",
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
