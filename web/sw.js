// Service Worker (als Modul registriert): hält die App-Hülle vor und prüft beim
// Weckruf des Servers selbst bei IBS5, ob etwas offen ist. Der Server erfährt
// davon nichts; er schickt nur {"t":"check"} zur gewählten Uhrzeit und, falls
// eingeschaltet, morgens {"t":"today"} für „heute gibt's …“ (alle Arten: PUSH_KINDS).
import {
  AlarmText, DEFAULT_CHECK, De, clampDaysAhead, IbsAuthError, IbsClient, OrderState, addDays, collect, evaluate, lastCall, nextWeekday,
  targetDates, todayBerlin,
} from "./ibs.js";
import { KeyUnreadableError, kvGet, kvSet, kvUpdate, secretGet, secretSet } from "./idb.js";
import { b64ToBytes } from "./base64.js";
import { dayStore, loadAccounts, renameAccount } from "./accounts.js";
import * as Sdui from "./sdui.js";
import { guardHooks } from "./guard.js";
import { pushFailure } from "./errors.js";
import { withSession } from "./session.js";
import { dueEvents, eventLine, eventsFor, loadEvents, needsCancel, noMealDates } from "./events.js";
import { holidayOn, loadHolidays, loadMealPref, schoolDayIn, skipDates } from "./holidays.js";
import { PUSH_KINDS, renewPush } from "./push.js";

export { renewPush };

const VERSION = "v87";
/** Eine Pause (guard.js), die schon so lange läuft, hält einen Weckruf nicht mehr auf: sonst fiele die Erinnerung aus. */
const PUSH_PAUSE_MAX_AGE_MS = 20 * 60 * 1000;
const PUSH_MAX_DAYS = 5;
// Gesamtfrist eines Weckrufs: danach kommt die Ersatzmeldung, bevor der Browser den Service Worker beendet.
const PUSH_DEADLINE_MS = 60000;
// Jedes Modul, das app.js oder sw.js per import erreicht, muss hier stehen (Test in tests/test.html).
export const SHELL = ["./", "index.html", "app.js", "ibs.js", "idb.js", "style.css", "icon.svg?v=3", "icon-192.png?v=3", "badge-96.png?v=3", "manifest.webmanifest", "sdui.js", "guard.js", "session.js", "events.js", "accounts.js", "holidays.js", "errors.js", "push.js", "push-client.js", "order-flow.js", "base64.js", "ferien.json"];

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

/**
 * Unter welchem Schlüssel eine Anfrage im Cache liegt. Aufrufe der App-Seite
 * (auch ./?order=… aus einer Meldung) teilen sich die Hülle „./“: so öffnet der
 * Link auch offline, und nicht jede Adresse legt einen eigenen Eintrag an.
 */
export function cacheKey(request, scope) {
  if (request.mode !== "navigate") return request;
  const { pathname } = new URL(request.url);
  const base = new URL(scope).pathname;
  return pathname === base || pathname === `${base}index.html` ? "./" : request;
}

// Netz zuerst, damit ein Deploy sofort ankommt; Cache nur, wenn offline.
self.addEventListener("fetch", (ev) => {
  const url = new URL(ev.request.url);
  if (url.origin !== self.location.origin || ev.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  const key = cacheKey(ev.request, self.registration.scope);
  ev.respondWith(
    fetch(ev.request)
      .then((resp) => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(key, copy));
        }
        return resp;
      })
      .catch(() => caches.match(key)),
  );
});

// ---------------------------------------------------------------- Push

/**
 * Jeder Push MUSS eine Meldung zeigen (Chrome und Safari verlangen das, iOS
 * kündigt sonst das Abo). Geklingelt wird je Weckruf höchstens einmal (siehe
 * Bell): Platzhalter oder Ergebnis, alles danach kommt still.
 */
self.addEventListener("push", (ev) => {
  let data = null;
  try {
    data = ev.data?.json() ?? null;
  } catch { /* leerer Push: wie „check“ */ }
  ev.waitUntil(handlePush(data));
});

const CHECK_TAG = "hs-check";
const TODAY_TAG = "hs-today";
const INFO_TAG = "hs-info";

/**
 * Sofort gezeigt, bevor IBS5 gefragt wird. Im Android-Doze bleiben dem Service Worker nach
 * dem Weckruf nur Sekunden, danach steht er womöglich bis zum nächsten Aufwachen des Geräts
 * (auch die Frist läuft dann nicht): der Platzhalter muss allein schon taugen. Die Erinnerung
 * klingelt deshalb schon hier und fordert zum Nachsehen auf (ihr Ergebnis ersetzt ihn still,
 * siehe newBell); die Morgenmeldung ist nur Auskunft (der Bestellschluss ist vorbei) und
 * kommt still, ihr Ergebnis klingelt wie gewohnt.
 */
export function placeholderOf(morning) {
  return morning
    ? { title: "Schulessen heute", body: "Die App sieht gerade nach, was es heute gibt. Bleibt diese Meldung so, bitte selbst in der App nachsehen.", silent: true }
    : { title: "Essen bestellt?", body: "Die App prüft gerade den Bestellstand. Bleibt diese Meldung so, bitte selbst in der App nachsehen.", silent: false };
}

/** Ein Weckruf schreibt 4–6 Einträge; die App zeigt die letzten 10 Weckrufe. */
const PUSH_LOG_MAX = 60;
const clip = (x, n = 120) => String(x ?? "").slice(0, n);
const online = () => (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? navigator.onLine : undefined);

/**
 * Schritte eines Weckrufs in den Ringpuffer pushLog (die App zeigt ihn unter „Meldungen“):
 * {t, k: Art, s: rx|ph|ibs|shown|fail, d?, on?, sent?}. Die Einträge gehen der Reihe nach
 * hinaus, ohne den Weckruf aufzuhalten; flush() wartet auf alle. Ohne IndexedDB fehlt nur das Protokoll.
 */
export function pushLogger(kind) {
  let chain = Promise.resolve();
  const log = (s, d, extra = {}) => {
    const entry = { t: Date.now(), k: kind, s };
    if (d != null && d !== "") entry.d = clip(d);
    for (const [key, v] of Object.entries(extra)) if (v !== undefined) entry[key] = v;
    chain = chain
      .then(() => kvUpdate("pushLog", (list) => ({ value: [...(Array.isArray(list) ? list : []), entry].slice(-PUSH_LOG_MAX) })))
      .catch(() => {});
  };
  log.fail = (e) => log("fail", e?.name && e.name !== "Error" ? `${e.name}: ${e?.message || ""}` : e?.message || e, { on: online() });
  log.flush = () => chain;
  return log;
}

/**
 * Ein Ton je Weckruf: notify und die Fach-Erinnerung klingeln nur, solange bell.rang
 * nicht gesetzt ist, und setzen es, sobald eine laute Meldung erschienen ist. Hat der
 * Platzhalter geklingelt, ersetzt ihn das Ergebnis also still (der Ton kam schon).
 */
export const newBell = () => ({ rang: false });

/**
 * Ein Weckruf, data wie vom Server ({t, m?, sent?}). deps ersetzen in Tests die Prüfungen:
 * check(isTest, signal, log, bell), today(signal, log, bell), subjects(isTest, bell), ms (Frist),
 * Reihenfolge: Platzhalter mit dem Tag des Ergebnisses, dann die Prüfung, deren Meldung
 * den Platzhalter ersetzt — laut, wenn sie etwas zu tun gibt und noch nichts geklingelt hat.
 */
export async function handlePush(data, deps = {}) {
  const { check = checkAndNotify, today = todayAndNotify, subjects = subjectReminder, ms = PUSH_DEADLINE_MS } = deps;
  const kind = data && typeof data.t === "string" ? data.t : "check";
  const log = pushLogger(kind);
  log("rx", null, { on: online(), sent: Number.isFinite(data?.sent) ? data.sent : undefined });
  try {
    if (kind === "alarm") return await alarmNotice(data?.m, log);
    if (!PUSH_KINDS.includes(kind)) {
      // Neuere Art vom Server, die dieser Service Worker nicht kennt: keine Anfrage an IBS5.
      return await shownOrFail(log, () => notify("sunshine: Hinweis", "Bitte die App öffnen, sie lädt dann die neue Version.", { silent: true, tag: INFO_TAG }));
    }
    const morning = kind === "today" || kind === "today-test";
    const isTest = kind === "test" || kind === "today-test";
    const tag = morning ? TODAY_TAG : CHECK_TAG;
    const ph = placeholderOf(morning);
    const bell = newBell();
    try {
      await notify(ph.title, ph.body, { silent: ph.silent, tag, bell });
      log("ph", ph.title + (ph.silent ? " (still)" : ""));
    } catch (e) {
      log.fail(e);
    }
    // Angekommen ist der Weckruf damit; ob alle Kinder geprüft wurden, schreibt die Prüfung selbst.
    // Nicht abwarten: hängt IndexedDB (WebKit), liefe sonst auch die Frist nie an.
    if (!morning && !isTest) delivered(false);
    log("ibs");
    const shown = await withDeadline(
      (signal) => (morning ? today(signal, log, bell) : check(isTest, signal, log, bell)),
      tag,
      // Die Erinnerung konnte nichts prüfen: das ist zu tun (selbst nachsehen), also laut.
      { ms, loud: !morning || isTest, log, bell },
    );
    const n = shown?.title ? shown : shown?.fallback ? null : await currentNotice(tag);
    if (n) log("shown", n.title + (n.silent ? " (still)" : ""));
    if (shown?.fallback && !morning && !isTest) await delivered(false);
    if (isTest) await confirmTest(tag);
    else if (morning) await todayShown();
    // Essen zuerst: Android dämpft eine zweite Meldung kurz danach, die wichtigere kommt also vorn.
    if (!morning) await subjects(isTest, bell);
  } finally {
    await log.flush();
  }
}

/** Gezeigte Meldung mit diesem Tag, {title, silent} oder null. */
async function currentNotice(tag) {
  const [n] = await self.registration.getNotifications({ tag }).catch(() => []);
  return n ? { title: n.title, silent: !!n.silent } : null;
}

/** Meldung zeigen und protokollieren; scheitert sie, steht das im Protokoll. */
async function shownOrFail(log, show) {
  try {
    const n = await show();
    log("shown", n.title + (n.silent ? " (still)" : ""));
  } catch (e) {
    log.fail(e);
  }
}

/** So lange wartet alarmNotice auf kv "operator", danach gilt das Gerät nicht als Betreiber. */
const OPERATOR_WAIT_MS = 3000;

/**
 * Selbstprüfung des Servers mit Abweichung. Der Server schickt sie nur an Betreiber-Abos;
 * den fremden Text zeigt nur ein Gerät, das die App als Betreiber kennt (kv "operator"),
 * sonst (Server verändert? IndexedDB hängt?) eine neutrale Meldung ohne ihn.
 */
async function alarmNotice(message, log) {
  const operator = await Promise.race([kvGet("operator"), new Promise((r) => setTimeout(r, OPERATOR_WAIT_MS))]);
  if (operator === true) {
    const text = clip(typeof message === "string" && message ? message : "Details unter /api/health", 200);
    return shownOrFail(log, () => notify("Selbstprüfung: Abweichung", text, { url: "/api/health", tag: INFO_TAG }));
  }
  return shownOrFail(log, () => notify("sunshine: Hinweis", "Bitte die App öffnen.", { silent: true, tag: INFO_TAG }));
}

/**
 * lastTodayOk: die Morgenmeldung (oder ihre Ersatzmeldung) steht in der Leiste; silent wie
 * tatsächlich gezeigt. Fehlt der Eintrag eines Tages, an dem der Server gesendet hat, wurde
 * das Gerät nicht geweckt. Die App zeigt ihn in der Fußzeile unter „Meldungen“.
 */
async function todayShown() {
  const [n] = await self.registration.getNotifications({ tag: TODAY_TAG }).catch(() => []);
  if (n) await kvSet("lastTodayOk", { at: Date.now(), silent: !!n.silent }).catch(() => {});
}

/**
 * Was auch immer schiefgeht, eine Meldung muss erscheinen — sonst kündigt iOS das Abo.
 * fn(signal) bekommt den Abbruch: nach der Frist (oder einem Fehler) geht keine Anfrage
 * mehr hinaus, nichts wird mehr gespeichert, und keine spätere Meldung ersetzt die Ersatzmeldung.
 * Liefert, was fn liefert, nach einem Fehler {title, silent, fallback: true} (ohne title, wenn
 * auch die Ersatzmeldung nicht erschien).
 * loud: die Ersatzmeldung klingelt, sofern im Weckruf noch nichts klang (bell, siehe newBell);
 * log: Protokoll des Weckrufs (pushLogger).
 */
export async function withDeadline(fn, tag, { ms = PUSH_DEADLINE_MS, loud = false, log = null, bell = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("Die Prüfung dauerte zu lange.")), ms);
  const deadline = new Promise((_, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true }));
  // Bricht fn selbst ab, lehnt deadline danach ohne Abnehmer ab.
  deadline.catch(() => {});
  try {
    return await Promise.race([fn(ctl.signal), deadline]);
  } catch (e) {
    ctl.abort(e);
    log?.fail(e);
    const n = failNotice(e);
    try {
      const shown = await notify(n.title, n.body, { silent: n.silent && !loud, url: "./", tag, bell });
      return { ...shown, fallback: true };
    } catch (err) {
      log?.fail(err);
      return { fallback: true };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Ersatzmeldung, wenn ein Weckruf scheitert; still, wenn iOS nur gerade den Schlüssel nicht herausgibt. */
export function failNotice(e) {
  if (e instanceof KeyUnreadableError) {
    return {
      title: "Bestellstand gerade nicht prüfbar",
      body: "Das Gerät gab die gespeicherte Anmeldung gerade nicht heraus. Die nächste Prüfung läuft wie gewohnt; im Zweifel die App öffnen.",
      silent: true,
    };
  }
  return { title: "Prüfung fehlgeschlagen", body: `${e?.message || e}\nBitte die App öffnen.`, silent: false };
}

/** Lesefehler der Konten: kein „nicht angemeldet“, sondern ein Fehler für die Ersatzmeldung. */
function storageError(e) {
  return e instanceof KeyUnreadableError ? e : new Error(`Gerätespeicher nicht lesbar (${e?.message || e}).`);
}

/** „Jetzt testen“ in den Einstellungen wartet auf diese Bestätigung. */
async function confirmTest(tag) {
  const [n] = await self.registration.getNotifications({ tag });
  for (const w of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
    w.postMessage({ testShown: n?.title || "Meldung" });
  }
}

/**
 * Gewählte Fächer am nächsten Schultag, wie in der Übersicht; ohne Meldung, wenn nichts
 * ansteht, still, wenn der Weckruf schon geklingelt hat (bell).
 */
async function subjectReminder(isTest, bell = null) {
  try {
    const cfg = await Sdui.sduiConfig();
    if (!cfg?.subjects.length) return;
    const plan = await Sdui.cachedPlan();
    if (!plan?.lessons.length) return;
    const today = todayBerlin();
    const day = Sdui.nextSchoolDay(today);
    // In den Ferien gilt der Stundenplan nicht.
    if (holidayOn(await loadHolidays(), day)) return;
    const found = Sdui.matches(plan.lessons, day, cfg.subjects);
    if (!found.length) return;
    const key = `${day}:${found.map((m) => m.subject).join(",")}`;
    if (!isTest && key === (await kvGet("sduiNotified"))) return;
    await kvSet("sduiNotified", key);
    const when = day === addDays(today, 1) ? "Morgen" : De.weekday(day);
    const lines = found.map((m) => m.subject + (m.label ? ` — ${m.label}` : "") + (m.notes.length ? ` (${m.notes.join("; ")})` : ""));
    await notify(`${when} ${found.map((m) => m.subject).join(" und ")}`, lines.join("\n") + (cfg.childName ? `\nfür ${cfg.childName}` : ""),
      { tag: "hs-sdui", bell });
  } catch {
    // Der Stundenplan ist Zugabe: ein Fehler hier darf nichts weiter stören.
  }
}


/** Meldung, wenn die Prüfung eines Kontos scheitert; ohne Token hat IBS5 den Login selbst abgelehnt. */
const failNoticeOf = (e, client) => pushFailure(e, { rejected: e instanceof IbsAuthError && !client.token });

/** k.notice, oder aus k.error abgeleitet (Tests geben nur den Fehler). */
const noticeOf = (k) => k.notice ?? pushFailure(k.error);

/**
 * Morgenmeldung: laut nur, was kein Aussetzer ist, oder wenn auch der vorige Weckruf dieses
 * Kindes scheiterte (markFailures). Die Erinnerung klingelt bei jedem Fehler (ringsLoud).
 */
const failLoud = (k) => !noticeOf(k).transient || !!k.repeated;

/**
 * Merkt je Kind, ob dieser Weckruf (Erinnerung wie Morgenmeldung) scheiterte, und
 * setzt k.repeated, wenn schon der vorige scheiterte. Geprüfte Kinder fallen heraus.
 */
export async function markFailures(kids) {
  const prev = (await kvGet("pushFailed").catch(() => null)) || {};
  const now = {};
  for (const k of kids.filter((x) => x.error)) {
    k.repeated = !!prev[k.customerNo];
    now[k.customerNo] = Date.now();
  }
  await kvSet("pushFailed", now).catch(() => {});
}

/** Meldung für ein einzelnes Kind, dessen Prüfung scheiterte; quiet nach der Regel der Morgenmeldung (failLoud). */
export function composeFailure(k) {
  const n = noticeOf(k);
  return { title: n.title, body: n.body, quiet: !failLoud(k) };
}

/**
 * Ein Konto prüfen. Termine gelten je Kind (eigene und die für alle), deshalb
 * fragt jedes Konto seine eigenen Tage ohne Schulessen mit ab. Ferientage in
 * Wochen ohne Ferienessen des Kindes fragt es gar nicht erst ab.
 */
async function checkAccount(account, checkDates, events, today, ferien, signal) {
  const mine = eventsFor(events, account.customerNo);
  const due = dueEvents(mine, today);
  const noMeal = noMealDates(mine);
  const skip = skipDates(ferien, await loadMealPref(account.customerNo), checkDates);
  const dates = [...new Set([...checkDates.filter((d) => !skip.has(d)), ...due.filter((e) => e.noMeal).map((e) => e.date)])].sort();
  const client = new IbsClient(undefined, guardHooks);
  client.signal = signal;
  client.pauseMaxAgeMs = PUSH_PAUSE_MAX_AGE_MS;
  client.dayView = !!(await kvGet("ibsDayView"));
  client.dayStore = dayStore(client);
  const kid = { customerNo: account.customerNo, due, firstName: "" };
  try {
    // Nur Ferientage ohne Ferienessen: nichts zu prüfen, auch keine Anmeldung.
    kid.days = dates.length ? await withSession(client, account, () => collect(client, dates, { history: true, signal, schoolDay: schoolDayIn(ferien) })) : [];
    kid.checked = kid.days.filter((d) => checkDates.includes(d.date) && !noMeal.has(d.date) && !skip.has(d.date));
  } catch (e) {
    // Frist abgelaufen: kein Fehler dieses Kindes, sondern das Ende des Weckrufs.
    if (signal?.aborted) throw e;
    kid.error = e;
    kid.notice = failNoticeOf(e, client);
  }
  kid.name = client.profile?.name || account.name || "";
  kid.firstName = client.profile?.firstName || "";
  return kid;
}

/**
 * Tage, die ein Weckruf prüft. Höchstens die nächsten Schultage: auf dem Handy
 * kostet jeder Tag eine Anfrage, und zu viele quittiert IBS5 mit einer IP-Sperre.
 * Bis einschließlich zum nächsten Weckruf-Tag: dazwischen schaut keiner mehr nach.
 * Höchstens 5 Schultage reichen dafür auch bei nur einem Weckruf pro Woche.
 * Ferientage fallen erst danach heraus (checkAccount), der erste Schultag nach
 * den Ferien bleibt so im Fenster.
 */
export function pushCheckDates(today, daysAhead, pushDays) {
  const coverUntil = nextWeekday(today, pushDays);
  return targetDates(today, { ...DEFAULT_CHECK, daysAhead, coverUntil }).slice(0, PUSH_MAX_DAYS);
}

// Beim Test („Jetzt testen“) dieselbe Meldung wie beim echten Weckruf, nur immer laut.
// Mehrere Kinder nacheinander, nie parallel (IP-Sperre von IBS5), und eine gemeinsame
// Meldung: eine zweite kurz danach dämpft Android.
async function checkAndNotify(isTest, signal, log = () => {}, bell = null) {
  // Ein Lesefehler ist nicht „nicht angemeldet“: er landet in der Fehlermeldung des Weckrufs.
  const accounts = await loadAccounts().catch((e) => { throw storageError(e); });
  if (!accounts.length) {
    return notify("Nicht angemeldet", "Bitte die Seite öffnen und anmelden.", { url: "./", bell });
  }
  const daysAhead = clampDaysAhead(await kvGet("daysAhead"));
  const today = todayBerlin();
  const pushDays = (await kvGet("pushWeekdays")) || DEFAULT_CHECK.weekdays;
  const checkDates = pushCheckDates(today, daysAhead, pushDays);
  const events = await loadEvents(today).catch(() => []);
  const ferien = await loadHolidays();
  const kids = [];
  for (const account of accounts) kids.push(await checkAccount(account, checkDates, events, today, ferien, signal));
  signal?.throwIfAborted();
  for (const k of kids) if (k.error) log.fail?.(k.error);

  // Namen fürs Gerät merken (Reiter, Meldung), auch wenn die Seite seit dem Login nicht offen war.
  for (const [i, k] of kids.entries()) {
    if (k.name && k.name !== accounts[i].name) await renameAccount(accounts[i].customerNo, k.name).catch(() => {});
  }

  await markFailures(kids);
  let msg;
  if (kids.length === 1) {
    const [k] = kids;
    if (k.error) {
      // Nicht prüfbar heißt bei der Erinnerung: selbst nachsehen. Das klingelt immer (composeFailure.quiet gilt morgens).
      const m = composeFailure(k);
      const shown = await notify(m.title, m.body, { url: "./", signal, bell });
      if (!isTest) await delivered(false);
      return shown;
    }
    msg = compose({ checked: k.checked, due: k.due, days: k.days, today, firstName: k.firstName });
  } else {
    msg = composeAll(kids, today);
  }
  signal?.throwIfAborted();
  // Lesen und Ergänzen in einer Transaktion: ein Abmelden eines Kindes (accounts.js) dazwischen bliebe sonst überschrieben.
  // Scheitert das, gilt alles als neu (laut) und der nächste Weckruf klingelt eben noch einmal; die Meldung kommt trotzdem.
  const known = await kvUpdate("notified", (old) => {
    const kept = new Set((Array.isArray(old) ? old : []).filter((k) => k.slice(0, 10) >= today));
    return { value: [...new Set([...kept, ...msg.keys])], result: kept };
  }).catch(() => new Set());
  const shown = await notify(msg.title, msg.body, { silent: msg.quiet || !(isTest || ringsLoud(msg, kids, known, today, pushDays)), url: msg.url, signal, bell });
  if (!isTest) await delivered(!kids.some((k) => k.error));
  return shown;
}

/**
 * lastPushOk: Weckruf kam an, eine Meldung ist gezeigt — auch wenn ein Kind nicht geprüft
 * werden konnte (das merkt pushFailed) oder nur Platzhalter bzw. Ersatzmeldung kamen. ok: alle
 * Kinder geprüft (Fehlerkarte „Letzte erfolgreiche Prüfung“). „Jetzt testen“ schreibt es nicht,
 * sonst überdeckte ein Test ausgebliebene echte Weckrufe („Erinnerung schweigt“).
 */
const delivered = (ok) => kvSet("lastPushOk", { at: Date.now(), ok }).catch(() => {});

/**
 * Laut, wenn ein Kind nicht prüfbar war, ein Tag oder Termin in diesem Zustand neu
 * ist (known: bisher gemeldete keys) oder ein offener Tag womöglich zum letzten Mal
 * vor seinem Bestellschluss gemeldet wird (lastCall); msg.quiet bleibt immer still.
 * Ob tatsächlich geklingelt wird, entscheidet danach bell (ein Ton je Weckruf).
 */
export function ringsLoud(msg, kids, known, today, pushDays) {
  if (msg.quiet) return false;
  if (kids.some((k) => k.error)) return true;
  if (msg.keys.some((k) => !known.has(k))) return true;
  return kids.some((k) => (k.checked || []).some((d) => d.isActionable && lastCall(today, d.date, pushDays)));
}

/**
 * Morgenmeldung „heute gibt's …“: je Kind die Bestellhistorie, ohne Treffer dort
 * zusätzlich die Tagesansicht von heute, nacheinander wie bei der Erinnerung. Zählt nicht als Erinnerung (lastPushOk),
 * damit eine kaputte Abendprüfung weiter als „Erinnerung schweigt“ auffällt.
 */
async function todayAndNotify(signal, log = () => {}, bell = null) {
  const accounts = await loadAccounts().catch((e) => { throw storageError(e); });
  if (!accounts.length) return notify("Nicht angemeldet", "Bitte die Seite öffnen und anmelden.", { url: "./", tag: TODAY_TAG, bell });
  const today = todayBerlin();
  const events = await loadEvents(today).catch(() => []);
  const ferien = await loadHolidays();
  const kids = [];
  for (const account of accounts) {
    const mine = eventsFor(events, account.customerNo);
    const kid = {
      customerNo: account.customerNo,
      noMeal: mine.find((e) => e.noMeal && e.date === today)?.title || "",
      holiday: holidayOn(ferien, today) || "",
      skip: skipDates(ferien, await loadMealPref(account.customerNo), [today]).has(today),
    };
    const client = new IbsClient(undefined, guardHooks);
    client.signal = signal;
    client.pauseMaxAgeMs = PUSH_PAUSE_MAX_AGE_MS;
    client.dayView = !!(await kvGet("ibsDayView"));
    try {
      [kid.day] = await withSession(client, account, () => collect(client, [], { history: true, peek: [today], signal, schoolDay: schoolDayIn(ferien) }));
    } catch (e) {
      if (signal?.aborted) throw e;
      kid.error = e;
      kid.notice = failNoticeOf(e, client);
      log.fail?.(e);
    }
    kid.firstName = client.profile?.firstName || "";
    kids.push(kid);
  }
  signal?.throwIfAborted();
  await markFailures(kids);
  const msg = composeToday(kids);
  return notify(msg.title, msg.body, { silent: msg.quiet, url: "./", tag: TODAY_TAG, signal, bell });
}

/**
 * Text der Morgenmeldung. kids: {customerNo, firstName, day?, noMeal, holiday, skip}
 * oder mit error/notice/repeated. Laut, wenn etwas bestellt ist oder an einem Schultag
 * nichts (Brot einpacken); still, wenn heute ohnehin kein Essen vorgesehen ist oder
 * die Prüfung nur ein einzelnes Mal am Netz scheiterte (failLoud).
 */
export function composeToday(kids) {
  const label = (k) => k.firstName || `Kd. ${k.customerNo}`;
  const status = (k) => {
    if (k.error) return { text: noticeOf(k).title, loud: failLoud(k) };
    if (!k.day) return { text: "Bestellstand unbekannt", loud: true };
    if (k.day.state === OrderState.ORDERED) return { text: k.day.orderedItems.join(" + "), ordered: true, loud: true };
    if (k.noMeal) return { text: `kein Schulessen (${k.noMeal})`, reason: k.noMeal };
    if (k.holiday && (k.skip || k.day.state === OrderState.NO_OFFER)) return { text: `kein Essen (${k.holiday})`, reason: k.holiday };
    if (k.day.state === OrderState.NO_OFFER) return { text: "kein Angebot", reason: "kein Angebot" };
    if (k.day.state === OrderState.UNKNOWN) return { text: "Bestellstand unklar", unclear: true, loud: true };
    return { text: "nichts bestellt", missing: true, loud: true };
  };
  const all = kids.map((k) => ({ k, ...status(k) }));
  const quiet = !all.some((s) => s.loud);
  if (all.length === 1) {
    const [s] = all;
    const forName = s.k.firstName ? ` für ${s.k.firstName}` : "";
    if (s.ordered) return { title: `Heute gibt's${forName}`, body: s.text, quiet };
    if (s.missing) return { title: `Heute kein Essen bestellt${forName}`, body: "Brot einpacken.", quiet };
    if (s.unclear) return { title: `Essen heute unklar${forName}`, body: "Bitte selbst auf der Bestellseite nachsehen.", quiet };
    if (s.k.error) return composeFailure(s.k);
    if (!s.k.day) return { title: "Essen heute unbekannt", body: "Der Bestellstand von heute war nicht lesbar. Bitte die App öffnen.", quiet };
    return { title: "Heute kein Schulessen", body: s.reason, quiet };
  }
  const missing = all.filter((s) => s.missing).map((s) => label(s.k));
  const unclear = all.filter((s) => s.unclear).map((s) => label(s.k));
  return {
    title: missing.length ? `Heute kein Essen bestellt für ${nameList(missing)}`
      : unclear.length ? `Essen heute unklar für ${nameList(unclear)}`
      : all.some((s) => s.ordered) ? "Heute gibt's" : "Heute kein Schulessen",
    body: all.map((s) => `${label(s.k)}: ${s.text}`).join("\n"),
    quiet,
  };
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
    if (!due.length) return { title: "Alles erledigt", body: until, url: "./", keys, quiet: true };
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
 * oder {customerNo, firstName, due, error, notice, repeated}.
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
      sections.push(`${label(k)}: ${noticeOf(k).title}`);
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
  if (failed.length) sections.push(noticeOf(failed[0]).body);

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
    : failed.length === kids.length ? noticeOf(failed[0]).title
    : failed.length ? `Bestellstand unbekannt für ${nameList(failed.map(label))}`
    : firstCancel ? `Essen abbestellen: ${firstCancel.e.title}`
    : due.length === 1 ? `Termin: ${due[0].e.title}`
    : due.length ? `${due.length} Termine`
    : "Alles erledigt";
  return {
    title,
    body: [...sections, evText].filter(Boolean).join("\n\n"),
    url: url || "./",
    keys,
    quiet: !alarmed.length && !failed.length && !due.length,
  };
}

/**
 * signal: nach Ablauf der Frist erscheint diese Meldung nicht mehr (sie ersetzte sonst die Ersatzmeldung).
 * Gleicher Tag ersetzt die Meldung davor; still ohne Ton, sonst klingelt auch der Ersatz (renotify).
 * bell (newBell): hat der Weckruf schon geklingelt, kommt sie still; eine laute setzt bell.rang.
 * Liefert {title, silent} fürs Protokoll.
 */
export async function notify(title, body, { silent = false, url = "./", tag = CHECK_TAG, signal, bell = null } = {}) {
  signal?.throwIfAborted();
  silent ||= !!bell?.rang;
  await self.registration.showNotification(title, {
    body,
    icon: "icon-192.png?v=3",
    // Kleines Symbol in Statusleiste und Kopf der Meldung; ohne zeigt Android das Chrome-Logo.
    badge: "badge-96.png?v=3",
    tag,
    renotify: !silent,
    silent,
    data: { url },
  });
  if (!silent && bell) bell.rang = true;
  return { title, silent };
}

self.addEventListener("notificationclick", (ev) => {
  ev.notification.close();
  ev.waitUntil(openTarget(ev.notification.data?.url || "./", self.clients, self.registration.scope));
});

/**
 * Ziel einer angetippten Meldung öffnen. Eine offene App-Seite wird nicht neu
 * geladen (vielleicht ist gerade ein Warenkorb halb gefüllt): sie kommt nach vorn
 * und bekommt {open: "?order=…"}, ob sie wechselt, entscheidet sie selbst.
 */
export async function openTarget(url, clients, scope) {
  const target = new URL(url, scope);
  const base = new URL(scope).pathname;
  const appPage = target.origin === new URL(scope).origin && (target.pathname === base || target.pathname === `${base}index.html`);
  const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = appPage && wins.find((w) => w.url.startsWith(scope));
  if (!win) return clients.openWindow(target.href);
  win.postMessage({ open: target.search });
  return win.focus().catch(() => {});
}

// Der Browser hat das Abo erneuert: dem Server die neue Adresse melden. Scheitert
// das, kämen keine Weckrufe mehr, ohne dass es jemand merkt: deshalb eine Meldung.
self.addEventListener("pushsubscriptionchange", (ev) => {
  ev.waitUntil((async () => {
    if (!(await kvGet("push"))) return;
    try {
      const push = await secretGet("push");
      if (!push) throw new Error("Abo-Daten nicht lesbar");
      let sub = ev.newSubscription;
      if (!sub) {
        const res = await fetch("/api/vapid");
        if (!res.ok) throw new Error(`Server: HTTP ${res.status}`);
        sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToBytes((await res.json()).publicKey),
        });
      }
      const weekdays = (await kvGet("pushWeekdays")) || DEFAULT_CHECK.weekdays;
      // Setzt nebenbei kv "operator" aus der Antwort des Servers (is_admin).
      const renewed = await renewPush(push, sub.toJSON(), { weekdays });
      // Inzwischen ausgeschaltet: das neue Abo nicht wieder als eingeschaltet ablegen.
      if (renewed !== push && (await kvGet("push"))) await secretSet("push", renewed);
    } catch (e) {
      await self.registration.showNotification("Erinnerung bitte neu einschalten", {
        body: `Das Abo für die Erinnerung ließ sich nicht erneuern (${e?.message || e}). `
          + "Bitte die App öffnen und unter ⚙ die Erinnerung aus- und wieder einschalten.",
        icon: "icon-192.png?v=3",
        badge: "badge-96.png?v=3",
        tag: "hs-push",
        data: { url: "./" },
      }).catch(() => {});
    }
  })());
});
