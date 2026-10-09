import {
  DAYS_AHEAD, DEFAULT_CHECK, De, IbsAuthError, IbsClient, OrderState, clampDaysAhead,
  addDays, changeKind, collect, daysFromJson, daysToJson, isoWeek, longestGap, placeOrders, targetDates, todayBerlin, weekdayNo,
} from "./ibs.js";
import { freezeWrites, kvClear, kvDel, kvGet, kvSet, secretSet } from "./idb.js";
import {
  accountKey, accountLabel, dayStore, loadAccounts, loadActive, removeAccount, renameAccount, saveActive, upsertAccount,
} from "./accounts.js";
import * as Sdui from "./sdui.js";
import { IbsPausedError, guardHooks, resume } from "./guard.js";
import { login, withSession } from "./session.js";
import { LEADS, addEvent, dueEvents, eventLine, eventsFor, loadEvents, needsCancel, noMealDates, removeEvent } from "./events.js";
import {
  askLater, askWithin, askedLater, holidayOn, loadHolidays, loadMealPref, nextHoliday, openWeeks, rangeText, saveMealPref, skipDates,
  unanswered, weekText,
} from "./holidays.js";

// Zugangsdaten (verschlüsselt, siehe idb.js) und Einstellungen liegen nur in
// diesem Browser, in IndexedDB, damit auch der Service Worker sie bei der
// Push-Prüfung lesen kann. Beim Start
// einmal in den Speicher geladen; vorher genutztes localStorage wird übernommen.
const ORDER_WEEKS = 8;
/** So viele Tage zeigt die Liste auf der Startseite (wie DAY_LIST_LENGTH der App). */
const DAY_LIST_LENGTH = 5;

// 17:00 statt Mittag: verteilt die Abfragen weg von der Zeit, zu der die meisten ohnehin nachsehen.
const DEFAULT_PUSH_TIME = "17:00";
// accounts: je Kind ein IBS5-Konto (siehe accounts.js), active: Kundennummer des gewählten Reiters.
// pushWeekdays: Tage des Weckrufs (1 = Mo); gemerkt auch bei ausgeschalteter Erinnerung, der Service Worker liest sie mit.
const store = { accounts: [], active: null, daysAhead: DAYS_AHEAD.def, push: null, pushWeekdays: [1, 2, 3, 4, 5] };

async function loadStore() {
  try {
    const old = localStorage.getItem("hs.creds");
    if (old) {
      await secretSet("creds", JSON.parse(old));
      const n = parseInt(localStorage.getItem("hs.daysAhead"), 10);
      if (n) await kvSet("daysAhead", n);
      localStorage.removeItem("hs.creds");
      localStorage.removeItem("hs.daysAhead");
    }
  } catch { /* kein localStorage */ }
  store.accounts = await loadAccounts().catch(() => []);
  store.active = (await loadActive()) || null;
  const n = await kvGet("daysAhead");
  store.daysAhead = clampDaysAhead(n);
  store.push = (await kvGet("push")) || null;
  const wd = await kvGet("pushWeekdays");
  if (Array.isArray(wd) && wd.length) store.pushWeekdays = wd;
  store.lastOk = (await kvGet("lastOk")) || null;
  store.lastPushOk = (await kvGet("lastPushOk")) || null;
}
/** Gespeichertes Konto des gewählten Reiters, sonst das erste. */
const loadCreds = () => store.accounts.find((a) => a.customerNo === store.active) ?? store.accounts[0] ?? null;
const multi = () => store.accounts.length > 1;
const loadDaysAhead = () => store.daysAhead;
function saveDaysAhead(n) {
  store.daysAhead = n;
  kvSet("daysAhead", n).catch(() => {});
}

const $app = document.getElementById("app");
const $reload = document.getElementById("btn-reload");
const $settings = document.getElementById("btn-settings");
const $web = document.getElementById("btn-web");
const $add = document.getElementById("btn-add");
const $footer = document.getElementById("footer");

const $header = document.querySelector("header");

function chrome(visible) {
  $header.hidden = false;
  $reload.hidden = $settings.hidden = $web.hidden = $add.hidden = !visible;
  if (!visible) $footer.hidden = true;
}

/**
 * Ein Client je Kundennummer: lädt beim Reiterwechsel das vorige Kind noch,
 * laufen dessen Abfragen mit dessen Token weiter und landen in dessen Speicher.
 */
const clients = new Map();
function clientFor(customerNo) {
  let c = clients.get(customerNo);
  if (!c) {
    c = new IbsClient(undefined, guardHooks);
    // Geladene Tage teilt die Seite über IndexedDB mit dem Service Worker (siehe dayCache in ibs.js).
    c.dayStore = dayStore(c);
    kvGet("ibsDayView").then((v) => { if (v) c.dayView = true; }, () => {});
    clients.set(customerNo, c);
  }
  return c;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Konto speichern (neu oder mit aktuellem Namen) und als Reiter wählen; wirft, wenn das Gerät nicht speichern kann. */
async function saveCreds(c, name = "") {
  store.accounts = await upsertAccount({ customerNo: c.customerNo, password: c.password, ...(name ? { name } : {}) });
  selectAccount(c.customerNo);
}
function selectAccount(customerNo) {
  store.active = customerNo;
  saveActive(customerNo);
}
/**
 * Abmelden: alles, was diese Seite auf dem Gerät abgelegt hat, samt Schlüssel.
 * Noch laufende Abfragen dürfen danach nichts mehr ablegen; der Aufrufer lädt die Seite neu.
 */
async function clearCreds() {
  nextView();
  freezeWrites();
  store.accounts = [];
  store.active = null;
  store.pushWeekdays = [1, 2, 3, 4, 5];
  clients.clear();
  store.lastOk = store.lastPushOk = null;
  await kvClear();
}

/** Vorname des Kindes: gespeichert beim Konto, sonst aus der laufenden Anmeldung. */
function kidName(creds) {
  const acc = store.accounts.find((a) => a.customerNo === creds?.customerNo);
  return (acc?.name && accountLabel(acc)) || clients.get(creds?.customerNo)?.profile?.firstName || "";
}

/** Den Namen aus IBS5 beim Konto ablegen, sobald er bekannt ist (Reiter, Meldungen). */
async function rememberName(creds) {
  const name = clients.get(creds.customerNo)?.profile?.name;
  const acc = store.accounts.find((a) => a.customerNo === creds.customerNo);
  if (!name || !acc || acc.name === name) return;
  store.accounts = await renameAccount(creds.customerNo, name).catch(() => store.accounts);
}

/**
 * fn(client) mit angemeldetem Client des Kontos. Token nur speichern, wenn auch
 * die Zugangsdaten gespeichert sind („Auf diesem Gerät merken“).
 */
const withLogin = (creds, fn) => {
  const c = clientFor(creds.customerNo);
  return withSession(c, creds, () => fn(c), { persist: store.accounts.some((a) => a.customerNo === creds.customerNo) });
};

/** Reiter je Kind; nur bei mehr als einem Konto. */
function kidTabs() {
  if (!multi()) return "";
  const active = currentCreds()?.customerNo;
  return `<div class="kids" role="tablist">${store.accounts.map((a) => `
    <button type="button" role="tab" class="kid-tab${a.customerNo === active ? " on" : ""}" aria-selected="${a.customerNo === active}"
      data-kid="${esc(a.customerNo)}">${esc(accountLabel(a))}</button>`).join("")}</div>`;
}
document.addEventListener("click", (ev) => {
  const tab = ev.target.closest?.("[data-kid]");
  if (!tab || tab.dataset.kid === currentCreds()?.customerNo) return;
  selectAccount(tab.dataset.kid);
  showHome();
});

function busy(text) {
  $app.innerHTML = `<p class="muted">${esc(text)}</p>`;
}

// ---------------------------------------------------------------- Einrichten

/**
 * Zähler der zuletzt geöffneten Ansicht. Lädt die Übersicht noch, während schon
 * eine andere Ansicht offen ist, darf sie danach nicht mehr zeichnen.
 */
let viewSeq = 0;
/** Bricht die IBS5-Abfragen der bisherigen Ansicht ab (⟳, Reiterwechsel, andere Ansicht) — vor der nächsten Anfrage. */
let viewAbort = new AbortController();
function nextView() {
  viewAbort.abort();
  viewAbort = new AbortController();
  return ++viewSeq;
}
/** Zuletzt gezeichnete Startseite; der Ferien-Dialog überlebt das zweite Zeichnen und zeichnet danach damit neu. */
let homeState = null;

/**
 * retry: Zugangsdaten für „Trotzdem jetzt versuchen“, wenn die Anmeldung an einer Pause hing.
 * adding: weiteres Kind zu gespeicherten Konten; dann ohne Einleitung und immer gemerkt
 * (die Erinnerung prüft nur gespeicherte Konten).
 */
function showSetup(message = "", prefill = {}, retry = null, { adding = false } = {}) {
  nextView();
  chrome(false);
  if (adding) $header.hidden = true;
  $app.innerHTML = adding ? `
    <div class="card">
      <h2 class="u-mt0">Weiteres Kind</h2>
      <p class="small muted">Jedes Kind hat im Bestellsystem (IBS5) eine eigene Kundennummer und ein eigenes Passwort.</p>
      ${message ? `<p class="error">${esc(message)}</p>` : ""}
      ${retry ? `<div class="row"><button id="b-resume" type="button" class="block">Trotzdem jetzt versuchen</button></div>` : ""}
      <form id="f-login" autocomplete="on">
        <label for="cn">Kundennummer</label>
        <input id="cn" name="username" type="text" inputmode="numeric" autocomplete="username" required value="${esc(prefill.customerNo)}">
        <label for="pw">Passwort</label>
        ${passwordField("pw", 'name="password"')}
        <div class="row"><button type="submit" class="block">Hinzufügen und prüfen</button></div>
        <div class="row u-mt4"><button type="button" id="b-add-cancel" class="text">Abbrechen</button></div>
      </form>
    </div>` : `
    ${wantInstall ? installTip() : ""}
    <div class="card hero open intro">
      <h2>Nie wieder Schulessen vergessen</h2>
      <p>Zeigt, für welche Tage im Bestellsystem IBS5 noch nichts bestellt ist, und bestellt, bestellt um
        oder bestellt ab. Wer mag, wird werktags zur gewählten Zeit erinnert.</p>
      <p class="small">Deine Zugangsdaten bleiben verschlüsselt auf diesem Gerät und gehen nur an das
        Bestellsystem. Für die Erinnerung weckt unser Server das Gerät nur. Er sieht weder deine IBS5-Zugangsdaten noch
        deine Bestellungen. Nimmst du den Stundenplan aus Sdui dazu, laufen dessen Anmeldung und Abruf durch ihn.</p>
      <p class="small muted">Kein Angebot von Sunshine Catering oder dem Hersteller von IBS5.</p>
    </div>
    ${wantInstall ? "" : installTip()}
    <div class="card">
      <h2 class="u-mt0">Anmelden</h2>
      <p class="small muted">Mit Kundennummer und Passwort des Schulessen-Bestellsystems (IBS5).</p>
      ${message ? `<p class="error">${esc(message)}</p>` : ""}
      ${retry ? `<div class="row"><button id="b-resume" type="button" class="block">Trotzdem jetzt versuchen</button></div>` : ""}
      <form id="f-login" autocomplete="on">
        <label for="cn">Kundennummer</label>
        <input id="cn" name="username" type="text" inputmode="numeric" autocomplete="username" required value="${esc(prefill.customerNo)}">
        <label for="pw">Passwort</label>
        ${passwordField("pw", 'name="password"')}
        <label class="check"><input id="remember" type="checkbox" checked> Auf diesem Gerät merken</label>
        ${pushSupported ? `<label class="check"><input id="want-push" type="checkbox" checked> Werktags um ${DEFAULT_PUSH_TIME} Uhr erinnern</label>` : ""}
        <div class="row"><button type="submit" class="block">Speichern und prüfen</button></div>
      </form>
    </div>`;
  wireInstallTip();
  // perm: bereits gestartete Abfrage der Benachrichtigungs-Erlaubnis, wenn die Erinnerung gleich mit an soll.
  const attempt = async (creds, remember, perm = null) => {
    if (adding && store.accounts.some((a) => a.customerNo === creds.customerNo)) {
      return showSetup("Diese Kundennummer ist schon eingerichtet.", creds, null, { adding });
    }
    busy("Anmelden …");
    const c = clientFor(creds.customerNo);
    try {
      await login(c, creds, remember);
    } catch (e) {
      const isPause = e instanceof IbsPausedError;
      showSetup(e instanceof IbsAuthError ? `Anmeldung abgelehnt: ${e.message}` : e.message, creds,
        isPause ? { creds, remember, wantPush: !!perm } : null, { adding });
      return;
    }
    if (remember) {
      try {
        await saveCreds(creds, c.profile?.name || "");
      } catch (e) {
        // Etwa im privaten Modus oder bei vollem Speicher: ohne Konto keine Erinnerung.
        if (adding) return showSetup(`Speichern auf diesem Gerät fehlgeschlagen: ${e.message}`, creds, null, { adding });
        sessionCreds = creds;
        pushNotice = `Zugangsdaten konnten auf diesem Gerät nicht gespeichert werden (${e.message}). `
          + "Angemeldet nur, bis die Seite geschlossen wird; die Erinnerung ist aus.";
        return showHome();
      }
    } else sessionCreds = creds;
    if (perm && remember) {
      busy("Erinnerung wird eingeschaltet …");
      pushNotice = await enableAfterLogin(perm);
    }
    showHome();
  };
  document.getElementById("b-add-cancel")?.addEventListener("click", () => showSettings());
  // Erinnerung braucht gespeicherte Zugangsdaten.
  const rememberBox = document.getElementById("remember");
  const pushBox = document.getElementById("want-push");
  if (rememberBox && pushBox) rememberBox.onchange = () => { pushBox.disabled = !rememberBox.checked; };
  document.getElementById("f-login").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const remember = adding || document.getElementById("remember").checked;
    // Die Erlaubnis muss noch im Klick erfragt werden (iOS verlangt das), also vor der Anmeldung.
    const wantPush = !adding && remember && !store.push && !!document.getElementById("want-push")?.checked;
    const perm = wantPush ? Notification.requestPermission().catch(() => "denied") : null;
    attempt({
      customerNo: document.getElementById("cn").value.trim(),
      password: document.getElementById("pw").value,
    }, remember, perm);
  });
  if (retry) {
    document.getElementById("b-resume").onclick = async () => {
      // Wie beim Abschicken: die Erlaubnis noch im Klick erfragen, vor jedem await.
      const perm = retry.wantPush && !store.push ? Notification.requestPermission().catch(() => "denied") : null;
      await resume();
      attempt(retry.creds, retry.remember, perm);
    };
  }
}

/** Anleitung zum Installieren, nur für das eigene Gerät; entfällt in der installierten App. */
// Android-Browser melden über beforeinstallprompt, dass die Seite installierbar
// ist; dann ersetzt ein Knopf die Schritte über das Menü. Safari kennt das nicht.
// Wird der Dialog abgelehnt, bietet Chrome ihn eine Weile nicht an: dann wieder die Schritte.
let installPrompt = null;
addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();
  installPrompt = ev;
  refreshInstallTip();
});
addEventListener("appinstalled", () => {
  installPrompt = null;
  for (const el of document.querySelectorAll(".tip")) el.remove();
});

/** …/?installieren (z. B. als QR-Code): Karte zuerst und hervorgehoben, auch angemeldet. */
const wantInstall = new URLSearchParams(location.search).has("installieren");
// Eingebaute Browser (Instagram, Facebook, TikTok … und Android-WebViews) können nicht
// installieren. WhatsApp öffnet auf dem iPhone eine Safari-Ansicht, die sich nicht erkennen lässt.
const inAppBrowser = /FBAN|FBAV|Instagram|LinkedInApp|Snapchat|musical_ly|BytedanceWebview|\bLine\/|; wv\)/.test(navigator.userAgent);

function installTip() {
  if (standalone) return "";
  const android = /Android/.test(navigator.userAgent);
  const steps = (name, list) => `
    <div class="tip-device">${name}</div>
    <ol class="tip-steps">${list.map((x) => `<li><span>${x}</span></li>`).join("")}</ol>`;
  const ios = steps("iPhone", ["In Safari unten auf <b>Teilen</b> tippen", "<b>Zum Home-Bildschirm</b> wählen", "Von dort öffnen"])
    + `<p class="small muted">Fehlt „Zum Home-Bildschirm“, ist die Seite in einer anderen App geöffnet (etwa aus WhatsApp): erst „In Safari öffnen“.</p>`;
  const and = steps("Android", ["In Chrome oben rechts auf <b>⋮</b> tippen", "<b>App installieren</b> wählen, nicht „Verknüpfung“", "Von dort öffnen"]);
  const body = inAppBrowser
    ? `<p><b>Die Seite ist gerade in einer anderen App geöffnet.</b> Von hier lässt sie sich nicht installieren:
        im Menü dieser App <b>${isIos ? "In Safari öffnen" : "Im Browser öffnen"}</b> wählen.</p>`
    : installPrompt
      ? `<div class="row"><button id="b-install" type="button" class="block">Als App installieren</button></div>`
      : isIos ? ios : android ? and : ios + and;
  return `
    <div class="card tip${wantInstall ? " tip-focus" : ""}">
      <h3>Als App auf den Startbildschirm</h3>
      <p class="small muted">Dann öffnet sie sich wie eine App${android ? "" : ", und nur so kommen auf dem iPhone Erinnerungen an"}.</p>
      ${body}
    </div>`;
}

function wireInstallTip() {
  const button = document.getElementById("b-install");
  if (!button) return;
  button.onclick = async () => {
    const prompt = installPrompt;
    installPrompt = null;
    if (!prompt) return refreshInstallTip();
    prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    if (choice?.outcome !== "accepted") refreshInstallTip();
  };
}

/** Steht die Karte schon auf der Seite, mit dem aktuellen Stand neu zeichnen. */
function refreshInstallTip() {
  for (const el of document.querySelectorAll(".tip")) el.outerHTML = installTip();
  wireInstallTip();
}

const EYE = "M12,4.5C7,4.5 2.73,7.61 1,12c1.73,4.39 6,7.5 11,7.5s9.27,-3.11 11,-7.5c-1.73,-4.39 -6,-7.5 -11,-7.5zM12,17c-2.76,0 -5,-2.24 -5,-5s2.24,-5 5,-5 5,2.24 5,5 -2.24,5 -5,5zM12,9c-1.66,0 -3,1.34 -3,3s1.34,3 3,3 3,-1.34 3,-3 -1.34,-3 -3,-3z";
const EYE_OFF = "M12,7c2.76,0 5,2.24 5,5 0,0.65 -0.13,1.26 -0.36,1.83l2.92,2.92c1.51,-1.26 2.7,-2.89 3.43,-4.75 -1.73,-4.39 -6,-7.5 -11,-7.5 -1.4,0 -2.740,0.25 -3.98,0.7l2.16,2.16C10.74,7.13 11.35,7 12,7zM2,4.27l2.28,2.28 0.46,0.46C3.08,8.3 1.78,10.02 1,12c1.73,4.39 6,7.5 11,7.5 1.55,0 3.03,-0.3 4.38,-0.84l0.42,0.42L19.73,22 21,20.73 3.27,3 2,4.27zM7.53,9.8l1.55,1.55c-0.05,0.21 -0.08,0.43 -0.08,0.65 0,1.66 1.34,3 3,3 0.22,0 0.44,-0.03 0.65,-0.08l1.55,1.55c-0.67,0.33 -1.41,0.53 -2.2,0.53 -2.76,0 -5,-2.24 -5,-5 0,-0.79 0.2,-1.53 0.53,-2.2zM11.84,9.02l3.15,3.15 0.02,-0.16c0,-1.66 -1.34,-3 -3,-3l-0.17,0.01z";

/** Passwortfeld mit Auge zum Anzeigen, wie in der App (ic_visibility / ic_visibility_off). */
function passwordField(id, extra = "") {
  return `<div class="pw-field">
    <input id="${id}" ${extra} type="password" autocomplete="current-password" required>
    <button type="button" class="icon pw-eye" data-for="${id}" aria-label="Passwort anzeigen" title="Passwort anzeigen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${EYE}"/></svg>
    </button>
  </div>`;
}

// Ein Klickhandler für alle Augen, auch in später eingefügten Formularen.
document.addEventListener("click", (ev) => {
  const btn = ev.target.closest?.(".pw-eye");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.for);
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  btn.querySelector("path").setAttribute("d", show ? EYE_OFF : EYE);
  btn.setAttribute("aria-label", show ? "Passwort verbergen" : "Passwort anzeigen");
  btn.title = btn.getAttribute("aria-label");
});

let sessionCreds = null;

/** Hinweis für die nächste Übersicht, wenn die Erinnerung beim Anmelden nicht anging. */
let pushNotice = "";
async function enableAfterLogin(perm) {
  if ((await perm) !== "granted") return "Erinnerung ist aus, weil Benachrichtigungen nicht erlaubt wurden. Einschalten unter ⚙.";
  try {
    await pushEnable(DEFAULT_PUSH_TIME);
    return "";
  } catch (e) {
    return `Erinnerung ist aus: ${e.message}`;
  }
}
const currentCreds = () => loadCreds() ?? sessionCreds;

// ---------------------------------------------------------------- Startseite

/**
 * Übersicht. Auf dem Handy kostet jeder Tag eine Anfrage mit Pause (IP-Sperre),
 * das dauert Sekunden. Deshalb zeigt sie sofort den zuletzt gespeicherten Stand
 * und aktualisiert im Hintergrund mit Fortschrittsbalken.
 */
async function showHome(fresh = false) {
  const creds = currentCreds();
  if (!creds) return showSetup();
  const my = nextView();
  const { signal } = viewAbort;
  chrome(true);

  const today = todayBerlin();
  const cfg = { ...DEFAULT_CHECK, daysAhead: loadDaysAhead() };
  // Fällige Tage ohne Schulessen kommen dazu, auch hinter dem Prüfzeitraum:
  // nur so steht fest, ob dort noch abbestellt werden muss.
  const events = eventsFor(await loadEvents(today).catch(() => []), creds.customerNo);
  const dates = [...new Set([...targetDates(today, cfg), ...dueEvents(events, today).filter((e) => e.noMeal).map((e) => e.date)])].sort();
  const client = clientFor(creds.customerNo);
  // Ob IBS5 diesem Gerät nur Tagesansichten liefert, ist gemerkt: spart die Probe-Anfrage.
  client.dayView ||= !!(await kvGet("ibsDayView").catch(() => false));
  const lastKey = accountKey("lastDays", creds.customerNo);
  // Ohne eigenen Eintrag gilt der aus der Zeit mit einem Konto (prüft unten die Kundennummer).
  const cached = (await kvGet(lastKey).catch(() => null)) ?? (await kvGet("lastDays").catch(() => null));
  const usable = cached && cached.from === today && cached.daysAhead === cfg.daysAhead && cached.customerNo === creds.customerNo;
  if (my !== viewSeq) return;
  if (usable) await renderHome(my, creds, daysFromJson(cached.days), { staleAt: cached.at });
  else $app.innerHTML = `${kidTabs()}<p class="muted">${progressText("Wochenplan wird geladen")}</p>${progressBar()}`;

  let days;
  try {
    days = await withLogin(creds, (c) => collect(c, dates, { fresh, onProgress: setProgress, history: true, signal }));
  } catch (e) {
    if (my !== viewSeq) return;
    if (e instanceof IbsAuthError && !client.token) {
      return multi() ? showSettings(`${kidName(creds) || creds.customerNo}: Anmeldung abgelehnt: ${e.message}`)
        : showSetup(`Anmeldung abgelehnt: ${e.message}`, creds);
    }
    const isPause = e instanceof IbsPausedError;
    const card = `
      <div class="card hero ${isPause ? "bad" : "neutral"}">
        <h2>${isPause ? "Bestellsystem gesperrt oder nicht erreichbar" : usable ? "Aktualisieren fehlgeschlagen" : "Bestellstand unbekannt"}</h2>
        <p>${esc(e.message)}</p>
        <p class="small">${usable ? `Unten steht der Stand von ${esc(when(cached.at))}. ` : ""}Ein Netzfehler ist keine Aussage
          darüber, ob bestellt ist. Über mobile Daten statt WLAN geht es oft trotzdem.</p>
        <button id="b-retry" class="block">${isPause ? "Trotzdem jetzt versuchen" : "Nochmal versuchen"}</button>
      </div>`;
    document.getElementById("refresh")?.remove();
    document.getElementById("pbar-text")?.replaceWith("Aktualisieren fehlgeschlagen");
    const tabs = document.querySelector(".kids");
    if (usable && tabs) tabs.insertAdjacentHTML("afterend", card);
    else if (usable) $app.insertAdjacentHTML("afterbegin", card);
    else $app.innerHTML = kidTabs() + card + lastOkLine();
    document.getElementById("b-retry").onclick = async () => {
      if (isPause) await resume();
      showHome(true);
    };
    return;
  }
  if (client.dayView) kvSet("ibsDayView", true).catch(() => {});
  kvSet(lastKey, { at: Date.now(), from: today, daysAhead: cfg.daysAhead, customerNo: creds.customerNo, days: daysToJson(days) })
    .catch(() => {});
  await rememberName(creds);
  if (my !== viewSeq) return;
  await renderHome(my, creds, days);
}

/** Fortschrittsbalken; der Füllstand wird per Skript gesetzt (die CSP lässt keine style-Attribute zu). */
// Dünne Linie am oberen Rand, über dem Inhalt statt in ihm: Erscheinen und
// Verschwinden verschieben nichts. Der Text dazu steht im Footer (bzw. beim
// ersten Laden im Platzhalter); läuft, bis die erste Zahl kommt.
const progressBar = () => `<div id="refresh" class="refresh pbar-run"><span id="pbar-fill"></span></div>`;
const progressText = (label) => `<span id="pbar-text" data-label="${label}">${label} …</span>`;

function setProgress(done, total) {
  const fill = document.getElementById("pbar-fill");
  const text = document.getElementById("pbar-text");
  if (fill) {
    fill.parentElement.classList.remove("pbar-run");
    fill.style.width = `${Math.round((100 * done) / Math.max(total, 1))}%`;
  }
  if (text) text.textContent = `${text.dataset.label} … ${done} von ${total} Tagen`;
}

/** Zeichnet die Übersicht; mit staleAt als gespeicherter Stand, der gerade aktualisiert wird. */
async function renderHome(my, creds, days, { staleAt = null } = {}) {
  // Stundenplan nur, wenn eingerichtet; ein Sdui-Fehler darf den Bestellstand nicht aufhalten.
  const sdui = await Sdui.cachedPlan().catch(() => null);
  const scfg = sdui ? await Sdui.sduiConfig() : null;
  const strip = sdui ? stripMaker(sdui.lessons, scfg?.subjects || []) : null;
  const today = todayBerlin();
  const events = eventsFor(await loadEvents(today).catch(() => []), creds.customerNo);
  const ferien = await loadHolidays();
  const pref = await loadMealPref(creds.customerNo);
  // An Tagen ohne Schulessen ist „nicht bestellt“ gewollt: kein „offen“ in der Statuskarte.
  const noMeal = noMealDates(events);
  const skip = skipDates(ferien, pref, days.map((d) => d.date));
  const relevant = days.filter((d) => !noMeal.has(d.date) && !skip.has(d.date));
  const ferienAsk = await ferienQuestion(ferien, pref, today, creds);
  if (my !== viewSeq) return;
  homeState = { creds, days, staleAt };

  $app.innerHTML = `
    ${staleAt ? progressBar() : ""}
    ${kidTabs()}
    ${pushNotice ? `<p class="small error">${esc(pushNotice)}</p>` : ""}
    ${wantInstall ? installTip() : ""}
    ${heroCard(relevant, kidName(creds))}
    ${ferienHint(ferienAsk)}
    ${eventsCard(events, days, today)}
    ${sdui?.error ? `<p class="small error">${esc(sdui.error)}</p>` : ""}
    ${days.length ? `
      <div class="section">DIE NÄCHSTEN TAGE</div>
      ${byWeek(days.slice(0, DAY_LIST_LENGTH)).map((week) => `
        <ul class="days">${week.map((d) => dayRow(d, strip, events.filter((e) => e.date === d.date),
          holidayOn(ferien, d.date), skip.has(d.date))).join("")}</ul>`).join("")}` : ""}
    <div class="center"><button id="b-all" class="text">Alle bestellbaren Tage →</button></div>`;

  wireInstallTip();
  if (!staleAt) pushNotice = "";
  for (const li of $app.querySelectorAll(".days li")) {
    li.onclick = () => {
      const d = days.find((x) => x.date === li.dataset.date);
      if (d.isActionable || d.state === OrderState.ORDERED) showOrder(d.date);
      else li.classList.toggle("expanded");
    };
  }
  document.getElementById("b-all").onclick = () => showOrder();
  const now = document.getElementById("b-order-now");
  if (now) now.onclick = () => showOrder(relevant.find((d) => d.isActionable).date);
  for (const b of $app.querySelectorAll("[data-cancel]")) b.onclick = () => showOrder(b.dataset.cancel);
  if (ferienAsk) {
    const ask = () => showFerien(creds, ferienAsk.h, () => {
      const st = homeState;
      if (st?.creds.customerNo === creds.customerNo) renderHome(viewSeq, st.creds, st.days, { staleAt: st.staleAt });
    });
    if (ferienAsk.popup) ask();
    else if (ferienAsk.hint) document.getElementById("b-ferien").onclick = ask;
  }

  if (!staleAt) await kvSet("lastOk", { at: Date.now(), via: "app" }).catch(() => {});
  store.lastPushOk = await kvGet("lastPushOk").catch(() => null);
  if (my !== viewSeq) return;
  const stale = pushStale();
  if (stale) document.querySelector(".hero")?.insertAdjacentHTML("beforebegin", stale);

  const t = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" })
    .format(new Date(staleAt || Date.now()));
  const pushInfo = store.push && store.lastPushOk ? ` · Erinnerung zuletzt ${esc(when(store.lastPushOk.at))}` : "";
  $footer.innerHTML = `<span>${staleAt ? `Stand ${t} · ${progressText("wird aktualisiert")}` : `Geprüft ${t}${pushInfo}`}</span>
    <button id="b-heart" class="icon heart" title="Über diese App" aria-label="Über diese App">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART}"/></svg>
    </button>`;
  $footer.hidden = false;
  document.getElementById("b-heart").onclick = showAbout;
}

/** „heute 12:01“, „gestern 12:01“ oder „03.10. 12:01“ — wie checkedLabel der App. */
function when(ms) {
  const f = (o) => new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", ...o }).format(new Date(ms));
  const day = f({ year: "numeric", month: "2-digit", day: "2-digit" });
  const time = f({ hour: "2-digit", minute: "2-digit" });
  const nowDay = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" });
  if (day === nowDay.format(new Date())) return `heute ${time}`;
  if (day === nowDay.format(new Date(Date.now() - 86400000))) return `gestern ${time}`;
  return `${day.slice(0, 6)} ${time}`;
}

/** Letzte erfolgreiche Prüfung, für die Fehlerkarte. */
function lastOkLine() {
  const at = Math.max(store.lastOk?.at || 0, store.lastPushOk?.at || 0);
  return at ? `<p class="small muted center-text">Letzte erfolgreiche Prüfung: ${esc(when(at))}</p>` : "";
}

/**
 * Hat die Erinnerung seit über zwei Werktagen nicht mehr erfolgreich geprüft,
 * obwohl sie eingeschaltet ist? Schweigen ist der gefährliche Zustand.
 */
function pushStale() {
  if (!store.push) return "";
  const since = store.lastPushOk?.at || store.push.created || 0;
  // Mindestens vier Tage, bei seltenen Weckrufen die längste Lücke plus einen Tag.
  const days = Math.max(4, longestGap(store.pushWeekdays) + 1);
  if (!since || Date.now() - since < days * 86400000) return "";
  return `<div class="card hero bad"><h2>Erinnerung schweigt</h2>
    <p>Die Erinnerung hat zuletzt ${esc(since === store.lastPushOk?.at ? when(since) : "noch nie")} erfolgreich geprüft.
      Unter ⚙ → „Jetzt testen“ ausprobieren, sonst aus- und wieder einschalten.</p></div>`;
}

/** Tage nach Kalenderwoche gruppiert: jede Woche eine eigene Karte, damit der Montag sich absetzt. */
function byWeek(days) {
  const out = [];
  for (const d of days) {
    const key = isoWeek(d.date).join("-");
    if (out.at(-1)?.key !== key) out.push({ key, days: [] });
    out.at(-1).days.push(d);
  }
  return out.map((w) => w.days);
}

/** Die eine Aussage der Startseite, wie HeroCard der App: Dringendes zuerst. */
function heroCard(days, firstName) {
  const open = days.filter((d) => d.isActionable);
  const late = days.filter((d) => d.state === OrderState.DEADLINE_PASSED);
  const unclear = days.filter((d) => d.state === OrderState.UNKNOWN);
  const forName = firstName ? ` für ${esc(firstName)}` : "";
  const chips = (list) => list.map((d) => esc(De.chip(d.date))).join(", ");

  if (open.length) {
    return `<div class="card hero open">
      <h2>${open.length === 1 ? "1 Tag offen" : `${open.length} Tage offen`}${forName}</h2>
      <p>${open.some((d) => d.state === OrderState.IN_CART)
        ? "Bestellen ist noch möglich — etwas liegt nur im Warenkorb."
        : "Bestellen ist noch möglich."}</p>
      <div class="chips">${open.map((d) => `<span class="chip">${esc(De.chip(d.date))}</span>`).join(", ")}</div>
      <button id="b-order-now" class="block">Jetzt bestellen</button>
    </div>`;
  }
  if (late.length) {
    return `<div class="card hero bad">
      <h2>${late.length === 1 ? "1 Tag ohne Essen" : `${late.length} Tage ohne Essen`}${forName}</h2>
      <p>Bestellschluss vorbei: ${chips(late)} — Brot einpacken.</p>
    </div>`;
  }
  if (unclear.length) {
    return `<div class="card hero bad">
      <h2>Bestellstatus unklar</h2>
      <p>${chips(unclear)} — bitte auf der Bestellseite nachsehen.</p>
    </div>`;
  }
  if (!days.length) return `<div class="card hero ok"><h2>Keine Schultage im Prüfzeitraum</h2></div>`;
  return `<div class="card hero ok">
    <h2>satt … theoretisch ✓</h2>
    <p>bis ${esc(De.long(days.at(-1).date))}</p>
  </div>`;
}

/**
 * Zeitleiste je Tag wie TimetableStrip der App: eine gleich breite Zelle je
 * Schulstunde bis zur spätesten Stunde des ganzen Plans, gewählte Fächer dunkel,
 * Freistunden als Lücke.
 */
function stripMaker(lessons, selected) {
  const plan = Sdui.planByDay(lessons);
  const maxHour = Math.max(0, ...[...plan.values()].flatMap((m) => [...m.keys()]));
  if (!maxHour) return null;
  return (date) => {
    const day = plan.get(date);
    if (!day) return "";
    const cells = [];
    for (let h = 1; h <= maxHour; h++) {
      const ls = day.get(h) || [];
      if (!ls.length) { cells.push(`<span class="cell gap"></span>`); continue; }
      const hl = ls.some((l) => selected.includes(l.subject));
      const main = ls.find((l) => selected.includes(l.subject)) || ls[0];
      const label = main.short + (new Set(ls.map((l) => l.short)).size > 1 ? "+" : "") + (ls.some((l) => l.note) ? "*" : "");
      cells.push(`<span class="cell${hl ? " hl" : ""}" title="${esc(ls.map((l) => l.subject).join(" / "))}">${esc(label)}</span>`);
    }
    return `<div class="strip">${cells.join("")}</div>`;
  };
}

const SUB = {
  ORDERED: ["bestellt", ""],
  NOT_ORDERED: ["offen · Tippen zum Bestellen", "open"],
  IN_CART: ["nur im Warenkorb · Tippen zum Bestellen", "open"],
  DEADLINE_PASSED: ["Bestellschluss vorbei · Brot einpacken", "bad"],
  NO_OFFER: ["kein Angebot", "bad"],
  UNKNOWN: ["unklar · bitte selbst nachsehen", "bad"],
};

/** Fällige eigene Termine; an Tagen ohne Schulessen mit Knopf, solange dort noch bestellt ist. */
function eventsCard(events, days, today) {
  const due = dueEvents(events, today);
  if (!due.length) return "";
  return `<div class="card events">${due.map((e) => {
    const day = days.find((d) => d.date === e.date);
    return `<div class="event-row"><span>${esc(eventLine(e, day, today))}</span>${
      needsCancel(e, day) ? `<button class="text" data-cancel="${e.date}">Abbestellen</button>` : ""}</div>`;
  }).join("")}</div>`;
}

/** Je Kind und Ferien einmal je Seitenaufruf von selbst fragen (renderHome läuft mehrfach). */
const ferienAsked = new Set();

/**
 * Stehen Ferien an (askWithin der Vorwarnzeit) und sind dort Wochen ohne Antwort, fragt ein
 * Dialog nach; nach „Später“ bleibt bis morgen nur die Zeile auf der Startseite.
 * null: nichts zu fragen.
 */
async function ferienQuestion(ferien, pref, today, creds) {
  const h = nextHoliday(ferien, today, askWithin(loadDaysAhead()));
  if (!h || !unanswered(ferien, h, pref, today).length) return null;
  const key = `${creds.customerNo}:${h.start}`;
  const popup = !ferienAsked.has(key) && !(await askedLater(creds.customerNo, today)) && !document.querySelector("dialog[open]");
  if (popup) ferienAsked.add(key);
  return { h, popup, hint: !popup && !document.querySelector("dialog.ferien-dialog[open]") };
}

const ferienHint = (ask) => (ask?.hint ? `<p class="ferien-hint small">${esc(ask.h.name)} ${esc(rangeText(ask.h))}:
  <button type="button" id="b-ferien" class="linklike">Essen bestellen?</button></p>` : "");

/**
 * Je Ferienwoche: Essen bestellen und erinnern? Vorbelegt mit der gespeicherten
 * Antwort, sonst „ja“ (so wird ohne Antwort auch erinnert). Speichern legt alle
 * gezeigten Wochen fest; „Später“ fragt erst morgen wieder von selbst
 * (aus den Einstellungen heißt er „Abbrechen“ und ändert nichts).
 */
async function showFerien(creds, h, onDone, { fromSettings = false } = {}) {
  const today = todayBerlin();
  const ferien = await loadHolidays();
  const pref = await loadMealPref(creds.customerNo);
  const weeks = openWeeks(ferien, h, today);
  const name = kidName(creds);
  const days = (n) => (n === 5 ? "ganze Woche" : `${n} ${n === 1 ? "Tag" : "Tage"}`);
  const dlg = document.createElement("dialog");
  dlg.className = "dialog ferien-dialog";
  dlg.innerHTML = `
    <h3>${esc(h.name)} ${esc(rangeText(h))}</h3>
    <p>Soll ${name ? `für ${esc(name)} ` : ""}in diesen Wochen Essen bestellt und daran erinnert werden?</p>
    <div class="ferien-weeks">${weeks.map((w, i) => `
      <div class="ferien-week"><span>${esc(weekText(w))}<span class="muted"> · ${days(w.dates.length)}</span></span>
        ${toggle(`fw-${i}`, pref[w.monday] !== false, `Essen ${weekText(w)}`)}</div>`).join("")}</div>
    <p class="small muted">Aus: offene Tage dieser Woche sind kein Alarm (kein Hort-Essen). Vor den nächsten Ferien wird neu gefragt.</p>
    <div class="dialog-actions">
      <button type="button" class="text" data-v="later">${fromSettings ? "Abbrechen" : "Später"}</button>
      <button type="button" class="text" data-v="save">Speichern</button>
    </div>`;
  document.body.append(dlg);
  weeks.forEach((w, i) => {
    const sw = dlg.querySelector(`#fw-${i}`);
    sw.onclick = () => {
      const on = !sw.classList.contains("on");
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-checked", on);
    };
  });
  const done = async (save) => {
    const answers = Object.fromEntries(weeks.map((w, i) => [w.monday, dlg.querySelector(`#fw-${i}`).classList.contains("on")]));
    dlg.close();
    dlg.remove();
    if (save) await saveMealPref(creds.customerNo, answers, today).catch(() => {});
    else if (!fromSettings && unanswered(ferien, h, pref, today).length) await askLater(creds.customerNo, today).catch(() => {});
    onDone?.();
  };
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); done(false); });
  dlg.querySelectorAll("[data-v]").forEach((b) => { b.onclick = () => done(b.dataset.v === "save"); });
  dlg.showModal();
}

/**
 * Wie DayRow der App: Wochentag/Tag, Gericht einzeilig + Status, Symbol rechts;
 * eigene Termine und Ferien im Status. skip: Ferientag eines Kindes ohne Ferienessen.
 */
function dayRow(d, strip = null, dayEvents = [], holiday = null, skip = false) {
  let dish = d.state === OrderState.NOT_ORDERED ? "Gericht wählen"
    : d.state === OrderState.DEADLINE_PASSED ? "nicht bestellt"
    : d.orderedItems[0] || "—";
  let [sub, subCls] = SUB[d.state];
  const timeline = strip?.(d.date) || "";
  let [sym, symCls] = d.state === OrderState.ORDERED ? ["✓", "ok"] : d.isActionable ? ["!", "open"] : ["✕", "bad"];
  const titles = dayEvents.map((e) => e.title).join(", ");
  if (dayEvents.some((e) => e.noMeal)) {
    if (d.state === OrderState.ORDERED) [sub, subCls, sym, symCls] = ["bestellt, abbestellen?", "open", "!", "open"];
    else [dish, sub, subCls, sym, symCls] = ["kein Schulessen", "", "", "✓", "ok"];
  } else if (holiday && (d.state === OrderState.NO_OFFER || (skip && (d.isActionable || d.state === OrderState.DEADLINE_PASSED)))) {
    [dish, sub, subCls, sym, symCls] = [holiday, d.state === OrderState.NO_OFFER ? "kein Angebot" : "kein Essen in den Ferien", "", "✓", "ok"];
  } else if (holiday) sub = `${holiday} · ${sub}`;
  // Eigene Termine vorn in der Statuszeile, farblich abgehoben.
  const subHtml = [titles && `<span class="ev">${esc(titles)}</span>`, sub && esc(sub)].filter(Boolean).join(" · ");
  return `
    <li data-date="${d.date}">
      <div class="date"><div class="wd">${esc(De.chip(d.date).slice(0, 2))}</div><div class="dom">${Number(d.date.slice(8, 10))}</div></div>
      <div class="text"><div class="dish">${esc(dish)}</div>${
        // Mit Zeitleiste sagt der Haken rechts schon „bestellt“, wie in der App.
        timeline && d.state === OrderState.ORDERED && !titles ? "" : `<div class="sub ${subCls}">${subHtml}</div>`}${timeline}</div>
      <div class="sym ${symCls}">${sym}</div>
    </li>`;
}

// ---------------------------------------------------------------- Bestellen

/**
 * Bestellen, umbestellen, abbestellen — wie OrderScreen der App. Jeder noch
 * änderbare Tag, offene mit „nichts“ vorausgewählt, bestellte mit dem
 * bestellten Gericht. Abgeschickt wird nur, was davon abweicht.
 */
async function showOrder(focusDate = null) {
  const creds = currentCreds();
  if (!creds) return showSetup();
  const client = clientFor(creds.customerNo);
  const my = nextView();
  const { signal } = viewAbort;
  chrome(false);
  $header.hidden = true; // wie OrderScreen der App: nur „Bestellen“ und „Zurück“
  // Bei mehreren Kindern steht im Kopf, für wen bestellt wird.
  const forKid = multi() && kidName(creds) ? ` für ${esc(kidName(creds))}` : "";
  $app.innerHTML = `
    <div class="order-head"><h2>Bestellen${forKid}</h2><button id="b-back" class="text">Zurück</button></div>
    <div id="o-progress" class="progress"></div>
    <div id="o-result"></div>
    <form id="f-order"></form>`;
  document.getElementById("b-back").onclick = () => showHome();
  const $progress = document.getElementById("o-progress");
  // Unsichtbar statt ausgeblendet: verschwindet der Balken, darf nichts darunter verrutschen.
  const working = (on) => { $progress.style.visibility = on ? "" : "hidden"; };
  // Wer selbst scrollt, wird nicht mehr zum angetippten Tag zurückgeholt.
  let userScrolled = false;
  for (const ev of ["wheel", "touchmove", "keydown"]) {
    addEventListener(ev, () => { userScrolled = true; }, { once: true, passive: true });
  }
  const $result = document.getElementById("o-result");
  const form = document.getElementById("f-order");
  const setResult = (text, cls = "") => {
    $result.innerHTML = text ? `<pre class="msg order-result ${cls}">${esc(text)}</pre>` : "";
  };

  let days = [];
  let all = [];
  // Jeder Ladevorgang hat seine Nummer: ein überholter (z. B. nach dem Abschicken neu
  // gestartet) bricht ab, statt weiter Tage in die neue Liste zu hängen.
  let loadSeq = 0;
  let submitting = false;
  const ferien = await loadHolidays();
  // Die bestellte Linie, falls sie sich noch ändern lässt (DayStatus.ordered() der App).
  const orderedOf = (d) => d.entries.find((e) => e.isOrdered && e.selectable) ?? null;
  const isChangeable = (d) =>
    d.state === OrderState.NOT_ORDERED || d.state === OrderState.IN_CART ? d.entries.some((e) => e.selectable)
      : d.state === OrderState.ORDERED ? orderedOf(d) != null
      : false;

  const dayFieldset = (d) => {
    const current = orderedOf(d);
    const what = current ? " — bestellt" : d.state === OrderState.IN_CART ? " — liegt im Warenkorb" : " — offen";
    const options = d.entries.filter((e) => e.selectable).map((e) => `
      <label class="option">
        <input type="radio" name="d-${d.date}" value="${esc(e.menuLineId)}" ${current?.menuLineId === e.menuLineId ? "checked" : ""}>
        <span>${esc(e.name)}${current?.menuLineId === e.menuLineId ? " (bestellt)" : ""}</span>
      </label>`).join("");
    return `
      <fieldset class="card day-order" id="day-${d.date}">
        <legend>${esc(De.long(d.date) + (holidayOn(ferien, d.date) ? ` (${holidayOn(ferien, d.date)})` : "") + what)}</legend>
        ${options}
        <label class="option">
          <input type="radio" name="d-${d.date}" value="" ${current ? "" : "checked"}>
          <span>${current ? "abbestellen" : "nichts"}</span>
        </label>
      </fieldset>`;
  };

  /**
   * Kalenderwoche für Kalenderwoche laden und jede gleich anzeigen. IBS5 stellt
   * Speisepläne wochenweise ein: Haben nach Tagen mit Speiseplan Montag und
   * Dienstag einer Woche keinen, ist weiter voraus noch nichts eingestellt.
   * (Ein einzelner Feiertag hält das nicht auf.) Ferien sind keine solche
   * Grenze: Eine leere Ferienwoche wird nach Mo/Di übersprungen und zählt
   * nicht zu den ORDER_WEEKS, Ferienessen wird angezeigt wie jede Woche.
   */
  async function load() {
    const mine = ++loadSeq;
    const current = () => my === viewSeq && mine === loadSeq;
    working(true);
    form.innerHTML = `<div id="o-days"></div><p id="o-more" class="small muted"></p>
      <button id="b-submit" type="submit" class="block" disabled>Nichts geändert</button>`;
    const $days = document.getElementById("o-days");
    const $more = document.getElementById("o-more");
    const today = todayBerlin();
    const monday = addDays(today, 1 - weekdayNo(today));
    const get = (dates) => withLogin(creds, (c) => collect(c, dates, { signal }));
    const offered = (ds) => ds.some((d) => d.state !== OrderState.NO_OFFER);
    const anyHoliday = (ds) => ds.some((d) => holidayOn(ferien, d));
    days = [];
    all = [];
    let error = null;
    try {
      // Ferienwochen verlängern das Fenster, aber nicht unbegrenzt (Sommerferien: 7 Wochen).
      for (let w = 0, n = 0; n < ORDER_WEEKS && w < ORDER_WEEKS + 8 && current(); w++) {
        const mon = addDays(monday, 7 * w);
        const dates = [0, 1, 2, 3, 4].map((i) => addDays(mon, i)).filter((d) => d >= today);
        if (!dates.length) continue;
        $more.textContent = `KW ${isoWeek(mon)[1]} wird geladen …`;
        let week = await get(dates.slice(0, 2));
        if (!current()) return;
        const holidayWeek = dates.every((d) => holidayOn(ferien, d));
        const stop = dates.length === 5 && offered(all) && !offered(week) && !anyHoliday(dates.slice(0, 2));
        if (holidayWeek && !offered(week)) {
          all = all.concat(week);
          continue;
        }
        n++;
        if (!stop) week = week.concat(await get(dates.slice(2)));
        if (!current()) return;
        all = all.concat(week);
        if (stop || (!offered(week) && offered(all) && !anyHoliday(dates))) break;
        const shown = week.filter(isChangeable);
        days = days.concat(shown);
        $days.insertAdjacentHTML("beforeend", shown.map(dayFieldset).join(""));
        refresh();
        if (focusDate && shown.some((d) => d.date === focusDate)) {
          document.getElementById(`day-${focusDate}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
        }
      }
    } catch (e) {
      error = e;
    }
    if (!current()) return;
    working(false);
    $more.remove();
    // Solange darunter noch Wochen fehlten, konnte der Tag nicht ganz nach oben;
    // jetzt steht die Seite und er wird genau ausgerichtet.
    if (focusDate && !userScrolled) document.getElementById(`day-${focusDate}`)?.scrollIntoView({ block: "start" });
    focusDate = null;
    if (error) setResult(error.message, "error");
    if (!days.length) {
      $days.innerHTML = error ? "" : `<p>Keine Tage, die sich noch ändern lassen.</p>`;
      document.getElementById("b-submit")?.remove();
    }
  }

  const pending = () => days.map((d) => {
    const v = form.querySelector(`input[name="d-${d.date}"]:checked`)?.value;
    return {
      date: d.date,
      current: orderedOf(d),
      target: v ? d.entries.find((e) => e.menuLineId === v && e.selectable) ?? null : null,
    };
  }).filter((c) => changeKind(c) !== "NONE");

  function refresh() {
    const submit = document.getElementById("b-submit");
    if (!submit) return;
    const changes = pending();
    for (const d of days) {
      document.getElementById(`day-${d.date}`)?.classList.toggle("changed", changes.some((c) => c.date === d.date));
    }
    submit.disabled = submitting || !changes.length;
    submit.textContent = !changes.length ? "Nichts geändert"
      : changes.every((c) => changeKind(c) === "ORDER") ? `${changes.length} Essen bestellen`
      : changes.length === 1 ? "1 Änderung abschicken"
      : `${changes.length} Änderungen abschicken`;
  }

  const describe = (c) => {
    const day = De.chip(c.date);
    return { ORDER: `${day} bestellen: ${c.target?.name}`, SWITCH: `${day} umbestellen auf: ${c.target?.name}`,
      CANCEL: `${day} abbestellen: ${c.current?.name}` }[changeKind(c)];
  };

  form.addEventListener("change", refresh);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (submitting) return;
    const changes = pending();
    if (!changes.length || !(await confirmDialog("Verbindlich abschicken?", changes.map(describe)))) return;
    if (submitting) return;

    // Bis zum Neuladen bleibt der Knopf aus: zwei Bestellungen auf einem Warenkorb zählen sich gegenseitig.
    // „Zurück“ ebenso: die Ergebnismeldung, auch „nicht bestätigt“, steht nur in dieser Ansicht.
    submitting = true;
    document.getElementById("b-submit").disabled = true;
    document.getElementById("b-back").disabled = true;
    working(true);
    const previouslyInCart = all.flatMap((d) => d.entries.filter((e) => e.quantityInCart === "1" && e.selectable));
    const outcome = await withLogin(creds, (c) =>
      placeOrders(c, changes, { previouslyInCart, reload: (ds) => collect(c, ds, { fresh: true }) }),
    ).catch((e) => ({ kind: "aborted", reason: e.message }));
    working(false);
    const back = document.getElementById("b-back");
    if (back) back.disabled = false;

    if (outcome.kind === "done") setResult(`Erledigt:\n${outcome.changes.map(describe).join("\n")}`, "ok");
    else if (outcome.kind === "aborted") setResult(`Nichts abgeschickt: ${outcome.reason}`, "error");
    else {
      setResult(`Abgeschickt, aber nicht bestätigt (${outcome.reason}) — bitte auf der Bestellseite nachsehen: `
        + (outcome.missing || []).map(De.short).join(", "), "error");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Die geänderten Tage hat placeOrders frisch geladen, der Rest kommt aus dem Zwischenspeicher.
    submitting = false;
    if (outcome.kind === "done" || outcome.kind === "unconfirmed") await load();
    else refresh();
  });

  await load();
}

const REPO_URL = "https://github.com/thmschk/sunshine-reminder";
const DONATE_URL = "https://paypal.me/LorenzThomschke";
// ic_heart der App (Material favorite_border).
const HEART = "M16.5,3c-1.74,0 -3.41,0.81 -4.5,2.09C10.91,3.81 9.24,3 7.5,3 4.42,3 2,5.42 2,8.5c0,3.78 3.4,6.86 8.55,11.54L12,21.35l1.45,-1.32C18.6,15.36 22,12.28 22,8.5 22,5.42 19.58,3 16.5,3zM12.1,18.55l-0.1,0.1 -0.1,-0.1C7.14,14.24 4,11.39 4,8.5 4,6.5 5.5,5 7.5,5c1.54,0 3.04,0.99 3.57,2.36h1.87C13.46,5.99 14.96,5 16.5,5c2,0 3.5,1.5 3.5,3.5 0,2.89 -3.14,5.74 -7.9,10.05z";

/** Wie DonateDialog der App: erst der Satz, dann der Griff nach draußen. */
function showAbout() {
  const dlg = document.createElement("dialog");
  dlg.className = "dialog about";
  dlg.innerHTML = `
    <svg class="about-heart" viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART}"/></svg>
    <h3>Über diese App</h3>
    <p>Diese App wurde mithilfe eines KI-Agenten in meiner Freizeit entwickelt. Ich freue mich über Feedback.
      Wer will, darf gerne auch <a href="${REPO_URL}" target="_blank" rel="noopener">mitcoden</a>.
      Wer mir unbedingt einen Espresso spendieren möchte, darf das per
      <a href="${DONATE_URL}" target="_blank" rel="noopener">PayPal.Me</a> machen.</p>
    <div class="dialog-actions"><button type="button" class="text">Schließen</button></div>`;
  document.body.append(dlg);
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.addEventListener("cancel", close);
  dlg.querySelector("button").onclick = close;
  dlg.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));
  dlg.showModal();
}

/** Rückfrage wie AlertDialog der App; true = „Abschicken“. */
function confirmDialog(title, lines) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog";
    dlg.innerHTML = `
      <h3>${esc(title)}</h3>
      ${lines.map((l) => `<p>${esc(l)}</p>`).join("")}
      <div class="dialog-actions">
        <button type="button" class="text" data-v="0">Abbrechen</button>
        <button type="button" class="text" data-v="1">Abschicken</button>
      </div>`;
    document.body.append(dlg);
    const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener("cancel", () => done(false));
    dlg.querySelectorAll("button").forEach((b) => { b.onclick = () => done(b.dataset.v === "1"); });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------- Termine

/** „Anna · “ vor einem Termin, der nur ein Kind betrifft; leer bei einem Kind. */
function whoText(e) {
  const acc = e.who && store.accounts.find((a) => a.customerNo === e.who);
  return multi() && acc ? `${esc(accountLabel(acc))} · ` : "";
}

const leadText = (n) => (n === 7 ? "eine Woche" : n === 1 ? "einen Tag" : `${n} Tage`) + " vorher";

/** Plus oben: eigenen Termin eintragen; eingetragene sehen und löschen. Nur auf dem Gerät. */
function showEvents() {
  const today = todayBerlin();
  let changed = false;
  const dlg = document.createElement("dialog");
  dlg.className = "dialog events-dialog";
  const close = () => {
    dlg.close();
    dlg.remove();
    if (changed) showHome();
  };
  const render = async () => {
    const list = await loadEvents(today).catch(() => []);
    dlg.innerHTML = `
      <h3>Termin eintragen</h3>
      <form id="f-event">
        <label for="ev-title">Was</label>
        <input id="ev-title" type="text" maxlength="60" required placeholder="z. B. Wandertag">
        <label for="ev-date">Wann</label>
        <input id="ev-date" type="date" min="${today}" required>
        <label for="ev-lead">Erinnern</label>
        <select id="ev-lead">${LEADS.map((n) => `<option value="${n}"${n === 2 ? " selected" : ""}>${leadText(n)}</option>`).join("")}</select>
        ${multi() ? `<label for="ev-who">Für</label>
        <select id="ev-who"><option value="">alle Kinder</option>${store.accounts.map((a) =>
          `<option value="${esc(a.customerNo)}"${a.customerNo === currentCreds()?.customerNo ? " selected" : ""}>${esc(accountLabel(a))}</option>`).join("")}</select>` : ""}
        <label class="check"><input id="ev-nomeal" type="checkbox"> kein Schulessen an dem Tag</label>
        <p class="small muted">Bleibt nur auf diesem Gerät: nicht auf anderen Handys, und „Abmelden“ löscht es.
          ${store.push ? "Erinnert wird mit der täglichen Erinnerung." : "Die Erinnerung ist aus (⚙) — dann steht es nur hier auf der Startseite."}</p>
        <div class="dialog-actions">
          <button type="button" class="text" id="ev-close">Schließen</button>
          <button type="submit" class="text">Speichern</button>
        </div>
      </form>
      ${list.length ? `<div class="section">EINGETRAGEN</div>
        <ul class="event-list">${list.map((e) => `
          <li><span>${esc(De.chip(e.date))} ${esc(e.title)}<span class="muted"> · ${whoText(e)}${e.noMeal ? "kein Schulessen · " : ""}${leadText(e.lead)}</span></span>
            <button type="button" class="text" data-del="${e.id}" aria-label="Termin löschen">Löschen</button></li>`).join("")}</ul>` : ""}`;
    dlg.querySelector("#ev-close").onclick = close;
    dlg.querySelector("#f-event").onsubmit = async (ev) => {
      ev.preventDefault();
      const title = dlg.querySelector("#ev-title").value.trim();
      const date = dlg.querySelector("#ev-date").value;
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) return;
      await addEvent(today, { title, date, lead: Number(dlg.querySelector("#ev-lead").value),
        noMeal: dlg.querySelector("#ev-nomeal").checked, who: dlg.querySelector("#ev-who")?.value || null });
      changed = true;
      close();
    };
    for (const b of dlg.querySelectorAll("[data-del]")) {
      b.onclick = async () => {
        await removeEvent(today, b.dataset.del);
        changed = true;
        render();
      };
    }
  };
  dlg.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
  document.body.append(dlg);
  render().then(() => dlg.showModal());
}

// ---------------------------------------------------------------- Einstellungen

// Einfarbige Symbole (Material, 24er Raster), wie in der Kopfzeile.
const ICON = {
  bell: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z",
  clock: "M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z",
  calendar: "M20 3h-1V1h-2v2H7V1H5v2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 18H4V8h16v13z",
  play: "M8 5v14l11-7z",
  school: "M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z",
  face: "M9 11.75c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zm6 0c-.69 0-1.25.56-1.25 1.25s.56 1.25 1.25 1.25 1.25-.56 1.25-1.25-.56-1.25-1.25-1.25zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8 0-.29.02-.58.05-.86 2.36-1.05 4.23-2.98 5.21-5.37C11.07 8.33 14.05 10 17.42 10c.78 0 1.53-.09 2.25-.26.21.71.33 1.47.33 2.26 0 4.41-3.59 8-8 8z",
  star: "M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z",
  person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  logout: "M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  key: "M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z",
};
const ico = (name) => `<svg class="s-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;

/**
 * Eine Zeile der Einstellungen im Android-Stil: Symbol, Titel, rechts der
 * aktuelle Wert oder ein Bedienelement, nur wo nötig ein kleiner Hinweis darunter.
 */
function srow(icon, title, { value = "", hint = "", right = "", cls = "", tag = "div", id = "", tip = "" } = {}) {
  return `<${tag} ${id ? `id="${id}"` : ""} ${tip ? `title="${esc(tip)}"` : ""} class="srow ${tag === "button" ? "srow-btn " : ""}${cls}">${ico(icon)}
    <span class="srow-t">${title}</span>${value ? `<span class="srow-v">${value}</span>` : ""}${right}</${tag}>
    ${hint ? `<div class="srow-hint">${hint}</div>` : ""}`;
}

/** Kinder: je Konto eine Zeile, Entfernen erst ab zwei (sonst „Abmelden und alles löschen“). */
function accountRows(creds) {
  if (!store.accounts.length) {
    const c = clients.get(creds?.customerNo);
    return srow("person", esc(c?.profile?.name || "Angemeldet"), { value: `Kd. ${esc(creds?.customerNo || "")}` });
  }
  return store.accounts.map((a) => srow("person", esc(a.name || accountLabel(a)), {
    value: `Kd. ${esc(a.customerNo)}`,
    right: multi() ? `<button type="button" class="text srow-x" data-remove="${esc(a.customerNo)}">Entfernen</button>` : "",
  })).join("") + srow("add", "Kind hinzufügen", { tag: "button", id: "b-kid-add",
    hint: multi() ? "" : "für Geschwister mit eigener Kundennummer" });
}

/** Einstellungen im Android-Stil: Bereiche ohne Karten, Werte rechts, Ändern per Antippen. */
function showSettings(message = "") {
  nextView();
  const creds = currentCreds();
  chrome(false);
  $header.hidden = true;
  $app.innerHTML = `
    <div class="s-head"><button id="b-back" class="icon" aria-label="Zurück" title="Zurück">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button><h2>Einstellungen</h2></div>

    <div class="group-title">Erinnerung</div>
    <div class="group" id="push-box"></div>

    <div class="group-title">Ferien (Berlin)</div>
    <div class="group" id="ferien-box"></div>

    <div class="group-title">Stundenplan (Sdui)</div>
    <div class="group" id="sdui-box"></div>

    <div class="group-title">${multi() ? "Kinder" : "Konto"}</div>
    <div class="group">
      ${message ? `<p class="small error group-pad">${esc(message)}</p>` : ""}
      ${accountRows(creds)}
      ${srow("logout", "Abmelden und alles löschen", { tag: "button", id: "b-logout", cls: "danger-row" })}
    </div>

    <p class="foot-note">Testversion · <a href="https://github.com/thmschk/sunshine-reminder#architektur" target="_blank" rel="noopener">So funktioniert's</a>
      · <button id="b-about" class="linklike">Über die App</button></p>`;
  document.getElementById("b-back").onclick = () => showHome();
  document.getElementById("b-about").onclick = showAbout;
  wirePushBox();
  wireFerienBox();
  wireSduiBox();
  const add = document.getElementById("b-kid-add");
  if (add) add.onclick = () => showSetup("", {}, null, { adding: true });
  for (const b of $app.querySelectorAll("[data-remove]")) {
    b.onclick = async () => {
      const acc = store.accounts.find((a) => a.customerNo === b.dataset.remove);
      if (!acc || !confirm(`${accountLabel(acc)} (Kd. ${acc.customerNo}) von diesem Gerät entfernen? Seine Termine gehen mit.`)) return;
      try {
        store.accounts = await removeAccount(acc.customerNo);
      } catch (e) {
        store.accounts = await loadAccounts().catch(() => store.accounts);
        return showSettings(`Entfernen fehlgeschlagen: ${e.message}`);
      }
      clients.delete(acc.customerNo);
      if (store.active === acc.customerNo) selectAccount(store.accounts[0].customerNo);
      showSettings();
    };
  }
  document.getElementById("b-logout").onclick = async () => {
    if (!confirm("Alles auf diesem Gerät löschen? Zugangsdaten, Sdui, Einstellungen und Erinnerung.")) return;
    await pushDisable().catch(() => {});
    // Ein Fehler wird nur gemeldet: nach freezeWrites kann die Seite ohnehin nichts mehr ablegen.
    await clearCreds().catch((e) => alert(`Löschen fehlgeschlagen, auf dem Gerät kann noch etwas liegen: ${e.message}`));
    // Neu laden beendet alle noch laufenden Abfragen dieser Seite.
    location.replace(location.pathname);
  };
}

/**
 * Vorwarnzeit: die Zeile zeigt den Wert, Antippen klappt −/+ darunter auf. Kein
 * Schieberegler, der verstellt sich beim Scrollen über ihn hinweg.
 */
function daysAheadRow() {
  const n = loadDaysAhead();
  return srow("calendar", "Vorwarnzeit", { tag: "button", id: "b-days", value: `<span id="days-ahead-val">${n}</span> Tage` }) + `
    <div id="days-edit" class="srow-edit" hidden>
      <button type="button" id="days-minus" class="step" aria-label="einen Tag weniger" ${n <= DAYS_AHEAD.min ? "disabled" : ""}>−</button>
      <button type="button" id="days-plus" class="step" aria-label="einen Tag mehr" ${n >= DAYS_AHEAD.max ? "disabled" : ""}>+</button>
      <span class="srow-hint u-m0">so weit schaut die Übersicht voraus, die Erinnerung höchstens 5 Schultage</span>
    </div>`;
}

function wireDaysAhead() {
  document.getElementById("b-days").onclick = () => {
    const e = document.getElementById("days-edit");
    e.hidden = !e.hidden;
  };
  const step = (d) => () => {
    saveDaysAhead(clampDaysAhead(loadDaysAhead() + d));
    const n = loadDaysAhead();
    document.getElementById("days-ahead-val").textContent = n;
    document.getElementById("days-minus").disabled = n <= DAYS_AHEAD.min;
    document.getElementById("days-plus").disabled = n >= DAYS_AHEAD.max;
  };
  document.getElementById("days-minus").onclick = step(-1);
  document.getElementById("days-plus").onclick = step(1);
}

/** Je Kind die nächsten Ferien; antippen öffnet die Frage je Woche. Ohne Antwort wird erinnert. */
async function wireFerienBox() {
  const box = document.getElementById("ferien-box");
  if (!box) return;
  const creds = currentCreds();
  const kids = store.accounts.length ? store.accounts : creds ? [creds] : [];
  const prefs = await Promise.all(kids.map((a) => loadMealPref(a.customerNo)));
  const ferien = await loadHolidays();
  if (!document.body.contains(box)) return;
  const today = todayBerlin();
  const h = nextHoliday(ferien, today, 400);
  const known = ferien.until ? `Termine bekannt bis ${De.long(ferien.until)}.` : "Termine gerade nicht verfügbar.";
  if (!h) {
    box.innerHTML = srow("school", "Keine Ferien bekannt", { hint: known });
    return;
  }
  const weeks = openWeeks(ferien, h, today);
  const state = (pref) => {
    if (unanswered(ferien, h, pref, today).length) return "noch offen";
    const on = weeks.filter((w) => pref[w.monday]).length;
    return on === weeks.length ? "Essen" : on ? `Essen ${on} von ${weeks.length} Wochen` : "kein Essen";
  };
  const title = `${esc(h.name)} ${esc(rangeText(h))}`;
  box.innerHTML = kids.map((a, i) => srow("school", multi() ? `${esc(accountLabel(a))}: ${title}` : title, {
    tag: "button", id: `ferien-${i}`, value: esc(state(prefs[i])),
    hint: i < kids.length - 1 ? "" : `Gefragt wird je Ferienwoche, vor allen Ferien neu. Ohne Antwort wird erinnert. ${known}`,
  })).join("");
  kids.forEach((a, i) => {
    document.getElementById(`ferien-${i}`).onclick = () => showFerien(a, h, wireFerienBox, { fromSettings: true });
  });
}

// ---------------------------------------------------------------- Sdui

const SDUI_NOTE = `Sdui lässt Webseiten nicht direkt zu, deshalb laufen Anmeldung und Abruf über unseren Server. Er reicht
  sie nur durch und speichert nichts. Dein Sdui-Passwort geht dabei einmal hindurch. Auf dem Gerät bleibt nur ein
  Zugangsschlüssel, der ein Jahr gilt.`;

async function wireSduiBox(message = "") {
  const box = document.getElementById("sdui-box");
  if (!box) return;
  const cfg = await Sdui.sduiConfig();
  if (!box.isConnected) return; // inzwischen eine andere Ansicht
  const msg = message ? `<p class="small error group-pad">${esc(message)}</p>` : "";
  if (!cfg) {
    box.innerHTML = `${msg}
      ${srow("school", "Stundenplan einrichten", { tag: "button", id: "b-sdui-setup",
        hint: "Stunden je Tag in der Übersicht, Erinnerung an Fächer wie Sport" })}`;
    document.getElementById("b-sdui-setup").onclick = () => sduiSetupForm();
    return;
  }
  const known = (await kvGet("sduiKnown")) || [];
  const shorts = new Map(((await kvGet("sduiPlan"))?.lessons || []).map((l) => [l.subject, l.short]));
  if (!box.isConnected) return;
  // „Erinnern an“ ist selbst die Zeile: zugeklappt rechts die Kürzel, aufgeklappt die Fächerliste darunter.
  box.innerHTML = `${msg}
    ${srow("school", esc(cfg.childName || "verbunden"), { hint: esc(cfg.slink || ""),
      tip: "Sdui läuft über unseren Server, der nichts speichert." })}
    ${known.length ? `
    <details class="srow-details">
      <summary class="srow">${ico("star")}<span class="srow-t">Erinnern an</span><span class="srow-v dd-value"></span></summary>
      <div class="subjects">${known.map((sub) => `
        <label class="check"><input type="checkbox" value="${esc(sub)}" ${cfg.subjects.includes(sub) ? "checked" : ""}>
          ${esc(sub)}${shorts.get(sub) ? ` <span class="small muted">(${esc(shorts.get(sub))})</span>` : ""}</label>`).join("")}</div>
    </details>` : srow("star", "Erinnern an", { value: "noch kein Plan" })}
    ${srow("logout", "Sdui entfernen", { tag: "button", id: "b-sdui-off", cls: "danger-row" })}`;
  // Im zugeklappten Feld stehen die Kürzel der gewählten Fächer, wie in der App.
  const showChosen = () => {
    const chosen = [...box.querySelectorAll(".subjects input:checked")].map((x) => x.value);
    const v = box.querySelector(".dd-value");
    if (v) v.textContent = chosen.map((sub) => shorts.get(sub) || sub).join(", ") || "keins";
    return chosen;
  };
  box.querySelectorAll(".subjects input").forEach((cb) => {
    cb.onchange = async () => { await kvSet("sduiSubjects", showChosen()); };
  });
  showChosen();
  document.getElementById("b-sdui-off").onclick = async () => {
    if (!confirm("Sdui-Zugang und Stundenplan auf diesem Gerät löschen?")) return;
    for (const k of ["sdui", "sduiSubjects", "sduiPlan", "sduiKnown", "sduiNotified"]) await kvDel(k);
    wireSduiBox();
  };
}

function sduiSetupForm(message = "") {
  const box = document.getElementById("sdui-box");
  if (!box) return; // Einstellungen inzwischen verlassen
  box.innerHTML = `<div class="group-pad">
    ${message ? `<p class="small error">${esc(message)}</p>` : ""}
    <p class="small muted u-m0">${SDUI_NOTE}</p>
    <form id="f-sdui">
      <label class="u-normal" for="s-school">Schule (Login-Adresse oder Kürzel)</label>
      <input id="s-school" type="text" placeholder="sdui.app/meine-schule/login" required autocomplete="off">
      <label class="u-normal" for="s-id">E-Mail oder Benutzername</label>
      <input id="s-id" type="text" autocomplete="username" required>
      <label class="u-normal" for="s-pw">Passwort</label>
      ${passwordField("s-pw")}
      <div class="row">
        <button type="submit" class="block">Verbinden</button>
      </div>
      <div class="row u-mt4"><button type="button" id="b-sdui-cancel" class="text">Abbrechen</button></div>
    </form></div>`;
  document.getElementById("b-sdui-cancel").onclick = () => wireSduiBox();
  document.getElementById("f-sdui").onsubmit = async (ev) => {
    ev.preventDefault();
    const slink = Sdui.parseSlink(document.getElementById("s-school").value);
    const identifier = document.getElementById("s-id").value.trim();
    const password = document.getElementById("s-pw").value;
    box.innerHTML = `<p class="small muted group-pad">Verbinde mit Sdui …</p>`;
    try {
      const { token, expires } = await Sdui.login(identifier, password, slink);
      const kids = await Sdui.children(token);
      if (!kids.length) throw new Error("Am Sdui-Konto ist kein Kind hinterlegt.");
      const pick = kids.length === 1 ? kids[0] : await chooseChild(kids);
      if (!pick) return wireSduiBox();
      await secretSet("sdui", { token, expires, slink, childId: pick.id, childName: pick.name });
      await kvDel("sduiPlan");
      const plan = await Sdui.cachedPlan({ force: true });
      wireSduiBox(plan?.error || "");
    } catch (e) {
      if (box.isConnected) sduiSetupForm(e.message);
    }
  };
}

function chooseChild(kids) {
  return new Promise((resolve) => {
    const box = document.getElementById("sdui-box");
    if (!box) return resolve(null);
    box.innerHTML = `<div class="group-pad"><p class="small muted u-mb6">Für welches Kind?</p>
      ${kids.map((k, i) => `<button class="text kid u-block u-pl0" data-i="${i}">${esc(k.name)}</button>`).join("")}
      <button class="text u-pl0" id="b-kid-cancel">Abbrechen</button></div>`;
    box.querySelectorAll(".kid").forEach((b) => { b.onclick = () => resolve(kids[Number(b.dataset.i)]); });
    document.getElementById("b-kid-cancel").onclick = () => resolve(null);
  });
}

// ---------------------------------------------------------------- Erinnerung

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const WEEKDAYS = ["Mo", "Di", "Mi", "Do", "Fr"];

/** „Mo–Fr“, „Mo–Mi“, „Mo, Do“: zusammenhängende Tage als Spanne. */
function weekdaysText(days) {
  const parts = [];
  for (const d of [...days].sort()) {
    const last = parts.at(-1);
    if (last && last[1] === d - 1) last[1] = d;
    else parts.push([d, d]);
  }
  return parts.map(([a, b]) => (a === b ? WEEKDAYS[a - 1] : `${WEEKDAYS[a - 1]}${b - a > 1 ? "–" : ", "}${WEEKDAYS[b - 1]}`)).join(", ");
}

const toggle = (id, on, label) =>
  `<button type="button" id="${id}" class="switch${on ? " on" : ""}" role="switch" aria-checked="${on}" aria-label="${label}"></button>`;

function pushBoxHtml(message = "") {
  const msg = message ? `<p class="small error group-pad">${esc(message)}</p>` : "";
  if (!pushSupported) {
    return srow("bell", "Erinnerung", { value: "nicht möglich", hint: isIos && !standalone
      ? "Auf dem iPhone nur, wenn die Seite über Teilen → „Zum Home-Bildschirm“ installiert ist und von dort geöffnet wird."
      : "Dieser Browser kann keine Erinnerungen empfangen." }) + daysAheadRow();
  }
  const on = !!store.push;
  const time = on ? store.push.time : DEFAULT_PUSH_TIME;
  // Betreiber-Gerät markieren: nur sichtbar über …/#betreiber, braucht den Schlüssel vom Server.
  const admin = on && location.hash === "#betreiber" ? `
    ${srow("key", "Betreiber-Gerät", { hint: "bekommt die Alarme der täglichen Selbstprüfung" })}
    <div class="group-pad">${passwordField("admin-key", 'placeholder="Betreiber-Schlüssel"')}
      <div class="row"><button id="b-push-admin" class="text u-pl0">Als Betreiber-Gerät markieren</button></div></div>` : "";
  return `${msg}
    ${srow("bell", "Erinnerung werktags", { right: toggle("push-switch", on, "Erinnerung") })}
    ${srow("clock", "Uhrzeit", { hint: "Meldung kommt bis zu 30 min später",
      right: `<input id="push-time" class="time-value" type="time" value="${esc(time)}" step="300" aria-label="Uhrzeit">` })}
    ${srow("calendar", "Tage", { value: weekdaysText(store.pushWeekdays) })}
    <div class="srow-edit wd-pick">${WEEKDAYS.map((n, i) => `<button type="button" class="wd-btn${store.pushWeekdays.includes(i + 1) ? " on" : ""}"
      data-wd="${i + 1}" aria-pressed="${store.pushWeekdays.includes(i + 1)}">${n}</button>`).join("")}</div>
    ${daysAheadRow()}
    ${on ? srow("play", "Jetzt testen", { tag: "button", id: "b-push-test" }) : ""}
    ${admin}`;
}

function wirePushBox(message = "") {
  const box = document.getElementById("push-box");
  if (!box) return;
  box.innerHTML = pushBoxHtml(message);
  wireDaysAhead();
  const sw = document.getElementById("push-switch");
  const test = document.getElementById("b-push-test");
  const time = document.getElementById("push-time");
  const guard = (fn) => async () => {
    try {
      await fn();
      wirePushBox();
    } catch (e) {
      wirePushBox(e.message);
    }
  };
  if (sw) sw.onclick = guard(() => (store.push ? pushDisable() : pushEnable(time?.value || DEFAULT_PUSH_TIME)));
  if (test) test.onclick = () => runPushTest(test);
  const adm = document.getElementById("b-push-admin");
  if (adm) adm.onclick = guard(async () => {
    const p = await currentPush();
    await api("POST", `/subscriptions/${p.id}/admin`, null, p.secret,
      { "X-Admin-Key": document.getElementById("admin-key").value });
    alert("Dieses Gerät ist jetzt Betreiber-Gerät.");
  });
  // Die ganze Zeile öffnet die Zeitauswahl, nicht nur die Ziffern.
  time?.closest(".srow")?.addEventListener("click", (ev) => {
    if (ev.target !== time) try { time.showPicker(); } catch { time.focus(); }
  });
  // Ohne Abo merkt sich das Feld nur die Wahl fürs Einschalten.
  if (store.push && time) time.onchange = guard(() => pushSetTime(time.value));
  const wdButtons = box.querySelectorAll(".wd-pick .wd-btn");
  for (const b of wdButtons) {
    b.onclick = guard(async () => {
      // Jeder Tipp rechnet vom gespeicherten Stand aus: bis der Server geantwortet hat (danach
      // zeichnet guard neu, bei Fehler mit dem alten Stand), nimmt die Leiste keinen weiteren an.
      for (const x of wdButtons) x.disabled = true;
      const n = Number(b.dataset.wd);
      const next = store.pushWeekdays.includes(n) ? store.pushWeekdays.filter((x) => x !== n) : [...store.pushWeekdays, n].sort();
      if (!next.length) throw new Error("Mindestens ein Tag muss bleiben. Ganz aus geht mit dem Schalter oben.");
      await pushSetWeekdays(next);
    });
  }
}

const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function api(method, path, body, secret, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  // Mit Frist: solange eine Änderung läuft, sind z. B. die Wochentage gesperrt.
  const r = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000) })
    .catch((e) => { throw new Error(e?.name === "TimeoutError" ? "Server antwortet nicht" : `Server nicht erreichbar: ${e.message}`); });
  if (!r.ok) throw new Error(`Server: HTTP ${r.status}`);
  return r.json().catch(() => ({}));
}

async function pushEnable(time) {
  if (!loadCreds()) throw new Error("Für die Erinnerung müssen die Zugangsdaten auf diesem Gerät gespeichert sein.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    // Nach einmal "Blockieren" fragt der Browser nicht wieder; freigeben geht nur von Hand.
    throw new Error(isIos
      ? "Benachrichtigungen sind nicht erlaubt. Einstellungen → Mitteilungen → satt → Mitteilungen erlauben."
      : "Benachrichtigungen sind nicht erlaubt. Links neben der Adresse auf das Schloss tippen → Berechtigungen → "
        + "Benachrichtigungen → Zulassen, dann hier nochmal einschalten.");
  }
  // serviceWorker.ready käme ohne erfolgreiche Registrierung nie zurück.
  if (!(await swReady)) throw new Error("Dieser Browser kann den Hintergrunddienst für Erinnerungen nicht starten.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api("GET", "/vapid");
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  const { id, secret } = await api("POST", "/subscriptions", {
    subscription: sub.toJSON(), time, weekdays: store.pushWeekdays, tz: "Europe/Berlin",
  });
  store.push = { id, secret, time, created: Date.now() };
  await kvSet("push", store.push);
}

/** Abo frisch aus dem Speicher: der Service Worker legt es bei pushsubscriptionchange womöglich neu an. */
async function currentPush() {
  store.push = (await kvGet("push")) ?? store.push;
  return store.push;
}

/** Tage merken (auch für den Service Worker) und, wenn die Erinnerung läuft, dem Server melden. */
async function pushSetWeekdays(weekdays) {
  const p = await currentPush();
  if (p) await api("PUT", `/subscriptions/${p.id}`, { weekdays }, p.secret);
  store.pushWeekdays = weekdays;
  await kvSet("pushWeekdays", weekdays);
}

async function pushSetTime(time) {
  if (!/^\d{2}:\d{2}$/.test(time)) return;
  const p = await currentPush();
  await api("PUT", `/subscriptions/${p.id}`, { time }, p.secret);
  store.push = { ...p, time };
  await kvSet("push", store.push);
}

/**
 * „Jetzt testen“ mit sichtbarem Ablauf: Weckruf senden, auf die Meldung warten,
 * Erfolg zeigen. Der Service Worker meldet sich, sobald die Meldung angezeigt ist.
 */
async function runPushTest(btn) {
  btn.disabled = true;
  btn.insertAdjacentHTML("afterend", `<div id="test-status" class="srow-edit">
    <div class="pbar pbar-run"><span></span></div><span class="small muted" id="test-text">Weckruf wird gesendet …</span></div>`);
  const text = () => document.getElementById("test-text");
  const finish = (msg, ok) => {
    const box = document.getElementById("test-status");
    if (!box) return;
    box.innerHTML = `<span class="small ${ok ? "ok-text" : "error"}">${esc(msg)}</span>`;
    btn.disabled = false;
    setTimeout(() => box.remove(), 8000);
  };
  const shown = new Promise((resolve) => {
    const onMsg = (ev) => {
      if (!ev.data?.testShown) return;
      navigator.serviceWorker.removeEventListener("message", onMsg);
      resolve(ev.data.testShown);
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    setTimeout(() => resolve(null), 45000);
  });
  try {
    await pushTest();
    if (text()) text().textContent = "Gesendet, das Gerät prüft gerade beim Bestellsystem …";
  } catch (e) {
    return finish(`Senden fehlgeschlagen: ${e.message}`, false);
  }
  const title = await shown;
  finish(title ? `✓ Meldung angezeigt: „${title}“` : "Gesendet, aber keine Meldung bestätigt. Sind Benachrichtigungen erlaubt?", !!title);
}

async function pushTest() {
  const p = await currentPush();
  await api("POST", `/subscriptions/${p.id}/test`, null, p.secret);
}

async function pushDisable() {
  const p = await currentPush();
  store.push = null;
  await kvDel("push");
  if (p) await api("DELETE", `/subscriptions/${p.id}`, null, p.secret).catch(() => {});
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

$reload.onclick = () => showHome(true);
$settings.onclick = () => showSettings();
$add.onclick = showEvents;

// Ohne Service Worker läuft die Seite weiter, nur Erinnerungen gehen dann nicht.
const swReady = "serviceWorker" in navigator
  ? navigator.serviceWorker.register("sw.js", { type: "module" }).then(() => true, () => false)
  : Promise.resolve(false);

// Antippen der Erinnerung öffnet ./?order=<Tag>[&k=<Kundennummer>] → direkt in die Bestellansicht.
await loadStore();
const orderDate = new URLSearchParams(location.search).get("order");
const orderKid = new URLSearchParams(location.search).get("k");
if (orderKid && store.accounts.some((a) => a.customerNo === orderKid)) selectAccount(orderKid);
if (orderDate && /^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
  history.replaceState(null, "", "./");
  if (currentCreds()) {
    chrome(true);
    showOrder(orderDate);
  } else showHome();
} else showHome();
