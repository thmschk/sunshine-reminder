// Erinnerungs-Abo der Seite beim eigenen Server (/api): einschalten, ändern, testen,
// reparieren, ausschalten. Ohne Ansicht: Fehler kommen als Error mit fertigem Text,
// die Einstellungen (app.js) zeigen sie an. Den Zustand teilt die Seite über ihren
// store (push, pushWeekdays, operator, wasOperator), siehe initPushClient.
import { b64ToBytes } from "./base64.js";
import { kvDel, kvGet, kvSet, secretGet, secretSet } from "./idb.js";
import { renewPush } from "./push.js";

/** Frist eines Testweckrufs: länger als die des Weckrufs im Service Worker (60 s), sonst kommt die Meldung „unbestätigt“ an. */
const TEST_WAIT_MS = 75000;

/**
 * store: gemeinsamer Zustand der Seite. swReady: Promise<boolean>, ob der Service Worker
 * registriert ist. blockedText(): wo man Benachrichtigungen wieder erlaubt (je Gerät).
 */
let env = null;
export function initPushClient({ store, swReady, blockedText }) {
  env = { store, swReady, blockedText };
}

export async function api(method, path, body, secret, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  // Mit Frist: solange eine Änderung läuft, sind z. B. die Wochentage gesperrt.
  const r = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000) })
    .catch((e) => { throw new Error(e?.name === "TimeoutError" ? "Server antwortet nicht" : `Server nicht erreichbar: ${e.message}`); });
  if (!r.ok) throw new Error(`Server: HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

/** Gleiche Bytes? a: ArrayBuffer oder null (dann ungleich). */
function sameBytes(a, b) {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** Laufende Änderungen am Abo beim Server: ein Neuladen dazwischen ließe Server und Gerät uneins (inProgress in app.js). */
let serverWrites = 0;
export const pendingWrites = () => serverWrites > 0;
const writing = (fn) => async (...args) => {
  serverWrites++;
  try {
    return await fn(...args);
  } finally {
    serverWrites--;
  }
};

/**
 * Betreiber-Kennzeichen aus einer Antwort des Servers (is_admin) merken: der Service Worker zeigt
 * Alarme der Selbstprüfung nur bei operator === true. wasOperator bleibt danach stehen; ein neu
 * angelegtes Abo übernimmt das Kennzeichen beim Server nicht (siehe operatorLost).
 */
export async function noteOperator(res) {
  const { store } = env;
  const admin = res?.is_admin ?? res?.isAdmin;
  if (typeof admin !== "boolean") return;
  store.operator = admin;
  await kvSet("operator", admin).catch(() => {});
  if (admin && !store.wasOperator) {
    store.wasOperator = true;
    await kvSet("wasOperator", true).catch(() => {});
  }
}
/** War dieses Gerät Betreiber-Gerät und ist es laut Server nicht mehr (etwa nach einem neu angelegten Abo)? */
export const operatorLost = () => !!env.store.push && env.store.wasOperator && env.store.operator === false;
export const OPERATOR_LOST = "Dieses Gerät ist nicht mehr als Betreiber markiert – Alarme der Selbstprüfung kommen nicht an.";

/** Erinnerung einschalten; fragt als Erstes die Erlaubnis (iOS verlangt das noch im Klick). */
export const pushEnable = writing(async (time) => {
  const { store } = env;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error(`${env.blockedText()} Dann hier nochmal einschalten.`);
  // serviceWorker.ready käme ohne erfolgreiche Registrierung nie zurück.
  if (!(await env.swReady)) throw new Error("Dieser Browser kann den Hintergrunddienst für Erinnerungen nicht starten.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api("GET", "/vapid");
  const key = b64ToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // Ein Abo zu einem anderen Server-Schlüssel (nach Schlüsselwechsel) kommt nie an: neu abonnieren.
  if (sub && !sameBytes(sub.options?.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const res = await api("POST", "/subscriptions", {
    subscription: sub.toJSON(), time, weekdays: store.pushWeekdays, tz: "Europe/Berlin",
  });
  const { id, secret } = res;
  store.push = { id, secret, time, created: Date.now() };
  await secretSet("push", store.push);
  await noteOperator(res);
});

/** Abo frisch aus dem Speicher: der Service Worker legt es bei pushsubscriptionchange womöglich neu an. */
export async function currentPush() {
  const { store } = env;
  store.push = (await secretGet("push").catch(() => undefined)) ?? store.push;
  return store.push;
}

/** Tage merken (auch für den Service Worker) und, wenn die Erinnerung läuft, dem Server melden. */
export const pushSetWeekdays = writing(async (weekdays) => {
  const p = await currentPush();
  if (p) await noteOperator(await api("PUT", `/subscriptions/${p.id}`, { weekdays }, p.secret));
  env.store.pushWeekdays = weekdays;
  await kvSet("pushWeekdays", weekdays);
});

/** Morgenmeldung ein (Uhrzeit) oder aus (null). */
export const pushSetMorning = writing(async (morning) => {
  if (morning !== null && !/^\d{2}:\d{2}$/.test(morning)) return;
  const p = await currentPush();
  const res = await api("PUT", `/subscriptions/${p.id}`, { morning_time: morning }, p.secret);
  env.store.push = { ...p, morning };
  await secretSet("push", env.store.push);
  await noteOperator(res);
});

export const pushSetTime = writing(async (time) => {
  if (!/^\d{2}:\d{2}$/.test(time)) return;
  const p = await currentPush();
  const res = await api("PUT", `/subscriptions/${p.id}`, { time }, p.secret);
  env.store.push = { ...p, time };
  await secretSet("push", env.store.push);
  await noteOperator(res);
});

/** Dieses Gerät mit dem Betreiber-Schlüssel zum Betreiber-Gerät machen. */
export async function pushMakeOperator(adminKey) {
  const p = await currentPush();
  const res = await api("POST", `/subscriptions/${p.id}/admin`, null, p.secret, { "X-Admin-Key": adminKey });
  // Erfolg heißt Betreiber, auch wenn die Antwort is_admin nicht nennt.
  await noteOperator({ is_admin: res?.is_admin ?? true });
}

/** Testweckruf senden (kind: "" Erinnerung, "today" Morgenmeldung); kennt der Server das Abo nicht mehr, wird es repariert. */
export async function pushTest(kind = "") {
  let tried = null;
  const send = async () => {
    const p = await currentPush();
    tried = p.id;
    await api("POST", `/subscriptions/${p.id}/test`, kind ? { kind } : null, p.secret);
  };
  try {
    await send();
  } catch (e) {
    // Der Server kennt das Abo nicht mehr: neu anlegen (oder die gerade laufende Reparatur
    // abwarten) und mit der neuen Kennung noch einmal senden.
    if (!/HTTP 404/.test(e.message)) throw e;
    await healPush(true);
    if ((await currentPush())?.id === tried) throw e;
    await send();
  }
}

/**
 * „Jetzt testen“: Weckruf senden und warten, bis der Service Worker meldet, dass die Meldung
 * angezeigt ist. onSent: gesendet, das Gerät prüft jetzt.
 * @returns {Promise<{sent:false, error:Error}|{sent:true, title:string|null}>} title null: keine Meldung bestätigt
 */
export async function runPushTest(kind = "", { onSent = () => {} } = {}) {
  // Vor dem Senden lauschen: die Bestätigung kann schneller kommen als die Antwort des Servers.
  const shown = new Promise((resolve) => {
    let timer = 0;
    const end = (v) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("message", onMsg);
      resolve(v);
    };
    const onMsg = (ev) => { if (ev.data?.testShown) end(ev.data.testShown); };
    navigator.serviceWorker.addEventListener("message", onMsg);
    timer = setTimeout(() => end(null), TEST_WAIT_MS);
  });
  try {
    await pushTest(kind);
    onSent();
  } catch (error) {
    return { sent: false, error };
  }
  return { sent: true, title: await shown };
}

/**
 * Abo beim Server auffrischen: meldet die aktuelle Abo-Adresse und legt das Abo neu an, wenn
 * der Server es nicht mehr kennt (er löscht es, sobald der Push-Dienst die Adresse ablehnt,
 * und nicht jeder Browser meldet dann pushsubscriptionchange). Beim Öffnen höchstens einmal
 * am Tag; force für „Jetzt testen“ und „Erinnerung reparieren“. true, wenn neu angelegt.
 */
// Reparaturen nacheinander: zwei gleichzeitige (Öffnen und „Jetzt testen“) legten zwei Abos an,
// und das Gerät bekäme jeden Weckruf doppelt. Die zweite sieht die neue Kennung und frischt nur auf.
let healChain = Promise.resolve();
export function healPush(force = false) {
  const run = healChain.then(writing(() => healPushNow(force)));
  healChain = run.catch(() => {});
  return run;
}

async function healPushNow(force) {
  const { store } = env;
  const p = await currentPush();
  if (!p || !(await env.swReady)) return false;
  if (!force && Date.now() - ((await kvGet("pushHealAt")) || 0) < 86400000) return false;
  const reg = await navigator.serviceWorker.ready;
  // Ohne Erlaubnis gibt es kein Abo (Chrome beendet es beim Entzug). Fragen nur auf Knopfdruck (force).
  if (force && Notification.permission === "default") await Notification.requestPermission().catch(() => {});
  if (Notification.permission !== "granted") {
    if (!force) return false;
    throw new Error(env.blockedText());
  }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api("GET", "/vapid");
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  }
  const renewed = await renewPush(p, sub.toJSON(), { weekdays: store.pushWeekdays });
  await kvSet("pushHealAt", Date.now());
  // Inzwischen ausgeschaltet: das neue Abo nicht wieder als eingeschaltet ablegen.
  if (renewed === p) {
    await noteOperator(renewed);
    return false;
  }
  if (!(await currentPush())) return false;
  store.push = renewed;
  await secretSet("push", renewed);
  await noteOperator(renewed);
  return true;
}

export const pushDisable = writing(async () => {
  const { store } = env;
  const p = await currentPush();
  store.push = null;
  await kvDel("push");
  // Ohne Abo gibt es kein Kennzeichen; „war Betreiber“ bleibt für den Hinweis nach erneutem Einschalten.
  store.operator = undefined;
  await kvDel("operator");
  if (p) await api("DELETE", `/subscriptions/${p.id}`, null, p.secret).catch(() => {});
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
});
