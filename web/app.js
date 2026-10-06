import {
  DEFAULT_CHECK, De, IbsAuthError, IbsClient, OrderState,
  addDays, changeKind, collect, daysFromJson, daysToJson, isoWeek, placeOrders, targetDates, todayBerlin, weekdayNo,
} from "./ibs.js";
import { kvClear, kvDel, kvGet, kvSet, secretGet, secretSet } from "./idb.js";
import * as Sdui from "./sdui.js";
import { IbsPausedError, guardHooks, resume } from "./guard.js";
import { login, withSession } from "./session.js";

// Zugangsdaten (verschlüsselt, siehe idb.js) und Einstellungen liegen nur in
// diesem Browser, in IndexedDB, damit auch der Service Worker sie bei der
// Push-Prüfung lesen kann. Beim Start
// einmal in den Speicher geladen; vorher genutztes localStorage wird übernommen.
const ORDER_WEEKS = 8;
/** So viele Tage zeigt die Liste auf der Startseite (wie DAY_LIST_LENGTH der App). */
const DAY_LIST_LENGTH = 5;

// Wie SettingsStore der Android-App: Standard 7, 1–14 Tage; Prüfzeit Standard 12:00.
const DAYS_AHEAD = { def: 7, min: 1, max: 14 };
// 17:00 statt Mittag: verteilt die Abfragen weg von der Zeit, zu der die meisten ohnehin nachsehen.
const DEFAULT_PUSH_TIME = "17:00";
const store = { creds: null, daysAhead: DAYS_AHEAD.def, push: null };

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
  const c = await secretGet("creds").catch(() => undefined);
  store.creds = c?.customerNo && c?.password ? c : null;
  const n = await kvGet("daysAhead");
  store.daysAhead = n >= DAYS_AHEAD.min && n <= DAYS_AHEAD.max ? n : DAYS_AHEAD.def;
  store.push = (await kvGet("push")) || null;
  store.lastOk = (await kvGet("lastOk")) || null;
  store.lastPushOk = (await kvGet("lastPushOk")) || null;
}
const loadCreds = () => store.creds;
const loadDaysAhead = () => store.daysAhead;
function saveDaysAhead(n) {
  store.daysAhead = n;
  kvSet("daysAhead", n).catch(() => {});
}

const $app = document.getElementById("app");
const $reload = document.getElementById("btn-reload");
const $settings = document.getElementById("btn-settings");
const $web = document.getElementById("btn-web");
const $footer = document.getElementById("footer");

const $header = document.querySelector("header");

function chrome(visible) {
  $header.hidden = false;
  $reload.hidden = $settings.hidden = $web.hidden = !visible;
  if (!visible) $footer.hidden = true;
}

const client = new IbsClient(undefined, guardHooks);
// Geladene Tage teilt die Seite über IndexedDB mit dem Service Worker (siehe dayCache in ibs.js).
client.dayStore = { load: () => kvGet("dayCache"), save: (rows) => kvSet("dayCache", rows) };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function saveCreds(c) {
  store.creds = c;
  await secretSet("creds", c).catch(() => {});
}
/** Abmelden: alles, was diese Seite auf dem Gerät abgelegt hat, samt Schlüssel. */
async function clearCreds() {
  store.creds = null;
  await kvClear().catch(() => {});
  store.lastOk = store.lastPushOk = null;
}

/** Token nur speichern, wenn auch die Zugangsdaten gespeichert sind („Auf diesem Gerät merken“). */
const withLogin = (creds, fn) => withSession(client, creds, fn, { persist: loadCreds()?.customerNo === creds.customerNo });

function busy(text) {
  $app.innerHTML = `<p class="muted">${esc(text)}</p>`;
}

// ---------------------------------------------------------------- Einrichten

/**
 * Zähler der zuletzt geöffneten Ansicht. Lädt die Übersicht noch, während schon
 * eine andere Ansicht offen ist, darf sie danach nicht mehr zeichnen.
 */
let viewSeq = 0;

function showSetup(message = "", prefill = {}) {
  viewSeq++;
  chrome(false);
  $app.innerHTML = `
    <div class="card hero open intro">
      <h2>Nie wieder Schulessen vergessen</h2>
      <p>Zeigt, für welche Tage im Bestellsystem IBS5 noch nichts bestellt ist, und bestellt, bestellt um
        oder bestellt ab. Wer mag, wird werktags zur gewählten Zeit erinnert.</p>
      <p class="small">Deine Zugangsdaten bleiben verschlüsselt auf diesem Gerät und gehen nur an das
        Bestellsystem. Für die Erinnerung weckt unser Server das Gerät nur. Er sieht weder deine IBS5-Zugangsdaten noch
        deine Bestellungen. Nimmst du den Stundenplan aus Sdui dazu, laufen dessen Anmeldung und Abruf durch ihn.</p>
      <p class="small muted">Kein Angebot von Sunshine Catering oder dem Hersteller von IBS5.</p>
    </div>
    ${installTip()}
    <div class="card">
      <h2 class="u-mt0">Anmelden</h2>
      <p class="small muted">Mit Kundennummer und Passwort des Schulessen-Bestellsystems (IBS5).</p>
      ${message ? `<p class="error">${esc(message)}</p>` : ""}
      <form id="f-login" autocomplete="on">
        <label for="cn">Kundennummer</label>
        <input id="cn" name="username" type="text" inputmode="numeric" autocomplete="username" required value="${esc(prefill.customerNo)}">
        <label for="pw">Passwort</label>
        ${passwordField("pw", 'name="password"')}
        <label class="check"><input id="remember" type="checkbox" checked> Auf diesem Gerät merken</label>
        <div class="row"><button type="submit" class="block">Speichern und prüfen</button></div>
      </form>
    </div>`;
  document.getElementById("f-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const creds = {
      customerNo: document.getElementById("cn").value.trim(),
      password: document.getElementById("pw").value,
    };
    const remember = document.getElementById("remember").checked;
    busy("Anmelden …");
    try {
      await login(client, creds, remember);
    } catch (e) {
      showSetup(e instanceof IbsAuthError ? `Anmeldung abgelehnt: ${e.message}` : e.message, creds);
      return;
    }
    if (remember) await saveCreds(creds);
    else sessionCreds = creds;
    showHome();
  });
}

/** Anleitung zum Installieren, nur für das eigene Gerät; entfällt in der installierten App. */
function installTip() {
  if (standalone) return "";
  const android = /Android/.test(navigator.userAgent);
  const steps = (name, list) => `
    <div class="tip-device">${name}</div>
    <ol class="tip-steps">${list.map((x) => `<li><span>${x}</span></li>`).join("")}</ol>`;
  const ios = steps("iPhone", ["In Safari unten auf <b>Teilen</b> tippen", "<b>Zum Home-Bildschirm</b> wählen", "Von dort öffnen"]);
  const and = steps("Android", ["In Chrome oben rechts auf <b>⋮</b> tippen", "<b>App installieren</b> wählen, nicht „Verknüpfung“", "Von dort öffnen"]);
  return `
    <div class="card tip">
      <h3>Als App auf den Startbildschirm</h3>
      <p class="small muted">Dann öffnet sie sich wie eine App${android ? "" : ", und nur so kommen auf dem iPhone Erinnerungen an"}.</p>
      ${isIos ? ios : android ? and : ios + and}
    </div>`;
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
  const my = ++viewSeq;
  chrome(true);

  const today = todayBerlin();
  const cfg = { ...DEFAULT_CHECK, daysAhead: loadDaysAhead() };
  const dates = targetDates(today, cfg);
  // Ob IBS5 diesem Gerät nur Tagesansichten liefert, ist gemerkt: spart die Probe-Anfrage.
  client.dayView ||= !!(await kvGet("ibsDayView").catch(() => false));
  const cached = await kvGet("lastDays").catch(() => null);
  const usable = cached && cached.from === today && cached.daysAhead === cfg.daysAhead && cached.customerNo === creds.customerNo;
  if (my !== viewSeq) return;
  if (usable) await renderHome(my, daysFromJson(cached.days), { staleAt: cached.at });
  else $app.innerHTML = `<p class="muted">${progressText("Wochenplan wird geladen")}</p>${progressBar()}`;

  let days;
  try {
    days = await withLogin(creds, () => collect(client, dates, { fresh, onProgress: setProgress, history: true }));
  } catch (e) {
    if (my !== viewSeq) return;
    if (e instanceof IbsAuthError && !client.token) return showSetup(`Anmeldung abgelehnt: ${e.message}`, creds);
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
    if (usable) $app.insertAdjacentHTML("afterbegin", card);
    else $app.innerHTML = card + lastOkLine();
    document.getElementById("b-retry").onclick = async () => {
      if (isPause) await resume();
      showHome(true);
    };
    return;
  }
  if (client.dayView) kvSet("ibsDayView", true).catch(() => {});
  kvSet("lastDays", { at: Date.now(), from: today, daysAhead: cfg.daysAhead, customerNo: creds.customerNo, days: daysToJson(days) })
    .catch(() => {});
  if (my !== viewSeq) return;
  await renderHome(my, days);
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
async function renderHome(my, days, { staleAt = null } = {}) {
  // Stundenplan nur, wenn eingerichtet; ein Sdui-Fehler darf den Bestellstand nicht aufhalten.
  const sdui = await Sdui.cachedPlan().catch(() => null);
  const scfg = sdui ? await Sdui.sduiConfig() : null;
  const strip = sdui ? stripMaker(sdui.lessons, scfg?.subjects || []) : null;
  if (my !== viewSeq) return;

  $app.innerHTML = `
    ${staleAt ? progressBar() : ""}
    ${heroCard(days, client.profile?.firstName || "")}
    ${sdui?.error ? `<p class="small error">${esc(sdui.error)}</p>` : ""}
    ${days.length ? `
      <div class="section">DIE NÄCHSTEN TAGE</div>
      ${byWeek(days.slice(0, DAY_LIST_LENGTH)).map((week) => `
        <ul class="days">${week.map((d) => dayRow(d, strip)).join("")}</ul>`).join("")}` : ""}
    <div class="center"><button id="b-all" class="text">Alle bestellbaren Tage →</button></div>`;

  for (const li of $app.querySelectorAll(".days li")) {
    li.onclick = () => {
      const d = days.find((x) => x.date === li.dataset.date);
      if (d.isActionable || d.state === OrderState.ORDERED) showOrder(d.date);
      else li.classList.toggle("expanded");
    };
  }
  document.getElementById("b-all").onclick = () => showOrder();
  const now = document.getElementById("b-order-now");
  if (now) now.onclick = () => showOrder(days.find((d) => d.isActionable).date);

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
  if (!since || Date.now() - since < 4 * 86400000) return "";
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
      <div class="chips">${open.map((d) => `<span class="chip">${esc(De.chip(d.date))}</span>`).join("")}</div>
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

/** Wie DayRow der App: Wochentag/Tag, Gericht einzeilig + Status, Symbol rechts. */
function dayRow(d, strip = null) {
  const dish = d.state === OrderState.NOT_ORDERED ? "Gericht wählen"
    : d.state === OrderState.DEADLINE_PASSED ? "nicht bestellt"
    : d.orderedItems[0] || "—";
  const [sub, subCls] = SUB[d.state];
  const timeline = strip?.(d.date) || "";
  const [sym, symCls] = d.state === OrderState.ORDERED ? ["✓", "ok"] : d.isActionable ? ["!", "open"] : ["✕", "bad"];
  return `
    <li data-date="${d.date}">
      <div class="date"><div class="wd">${esc(De.chip(d.date).slice(0, 2))}</div><div class="dom">${Number(d.date.slice(8, 10))}</div></div>
      <div class="text"><div class="dish">${esc(dish)}</div>${
        // Mit Zeitleiste sagt der Haken rechts schon „bestellt“, wie in der App.
        timeline && d.state === OrderState.ORDERED ? "" : `<div class="sub ${subCls}">${esc(sub)}</div>`}${timeline}</div>
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
  const my = ++viewSeq;
  chrome(false);
  $header.hidden = true; // wie OrderScreen der App: nur „Bestellen“ und „Zurück“
  $app.innerHTML = `
    <div class="order-head"><h2>Bestellen</h2><button id="b-back" class="text">Zurück</button></div>
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
        <legend>${esc(De.long(d.date) + what)}</legend>
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
   * (Ein einzelner Feiertag hält das nicht auf.)
   */
  async function load() {
    working(true);
    form.innerHTML = `<div id="o-days"></div><p id="o-more" class="small muted"></p>
      <button id="b-submit" type="submit" class="block" disabled>Nichts geändert</button>`;
    const $days = document.getElementById("o-days");
    const $more = document.getElementById("o-more");
    const today = todayBerlin();
    const monday = addDays(today, 1 - weekdayNo(today));
    const get = (dates) => withLogin(creds, () => collect(client, dates));
    const offered = (ds) => ds.some((d) => d.state !== OrderState.NO_OFFER);
    days = [];
    all = [];
    let error = null;
    try {
      for (let w = 0; w < ORDER_WEEKS && my === viewSeq; w++) {
        const mon = addDays(monday, 7 * w);
        const dates = [0, 1, 2, 3, 4].map((i) => addDays(mon, i)).filter((d) => d >= today);
        if (!dates.length) continue;
        $more.textContent = `KW ${isoWeek(mon)[1]} wird geladen …`;
        let week = await get(dates.slice(0, 2));
        const stop = dates.length === 5 && offered(all) && !offered(week);
        if (!stop && my === viewSeq) week = week.concat(await get(dates.slice(2)));
        if (my !== viewSeq) return;
        all = all.concat(week);
        if (stop || (!offered(week) && offered(all))) break;
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
    if (my !== viewSeq) return;
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
    submit.disabled = !changes.length;
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
    const changes = pending();
    if (!changes.length || !(await confirmDialog("Verbindlich abschicken?", changes.map(describe)))) return;

    document.getElementById("b-submit").disabled = true;
    working(true);
    const previouslyInCart = all.flatMap((d) => d.entries.filter((e) => e.quantityInCart === "1" && e.selectable));
    const outcome = await withLogin(creds, () =>
      placeOrders(client, changes, { previouslyInCart, reload: (ds) => collect(client, ds, { fresh: true }) }),
    ).catch((e) => ({ kind: "aborted", reason: e.message }));
    working(false);

    if (outcome.kind === "done") setResult(`Erledigt:\n${outcome.changes.map(describe).join("\n")}`, "ok");
    else if (outcome.kind === "aborted") setResult(`Nichts abgeschickt: ${outcome.reason}`, "error");
    else {
      setResult(`Abgeschickt, aber nicht bestätigt (${outcome.reason}) — bitte auf der Bestellseite nachsehen: `
        + (outcome.missing || []).map(De.short).join(", "), "error");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    // Die geänderten Tage hat placeOrders frisch geladen, der Rest kommt aus dem Zwischenspeicher.
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

/** Einstellungen im Android-Stil: Bereiche ohne Karten, Werte rechts, Ändern per Antippen. */
function showSettings() {
  viewSeq++;
  const creds = currentCreds();
  chrome(false);
  $header.hidden = true;
  $app.innerHTML = `
    <div class="s-head"><button id="b-back" class="icon" aria-label="Zurück" title="Zurück">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    </button><h2>Einstellungen</h2></div>

    <div class="group-title">Erinnerung</div>
    <div class="group" id="push-box"></div>

    <div class="group-title">Stundenplan (Sdui)</div>
    <div class="group" id="sdui-box"></div>

    <div class="group-title">Konto</div>
    <div class="group">
      ${srow("person", esc(client.profile?.name || "Angemeldet"), { value: `Kd. ${esc(creds?.customerNo || "")}` })}
      ${srow("logout", "Abmelden und alles löschen", { tag: "button", id: "b-logout", cls: "danger-row" })}
    </div>

    <p class="foot-note">Testversion · <a href="https://github.com/thmschk/sunshine-reminder#architektur" target="_blank" rel="noopener">So funktioniert's</a>
      · <button id="b-about" class="linklike">Über die App</button></p>`;
  document.getElementById("b-back").onclick = () => showHome();
  document.getElementById("b-about").onclick = showAbout;
  wirePushBox();
  wireSduiBox();
  document.getElementById("b-logout").onclick = async () => {
    if (!confirm("Alles auf diesem Gerät löschen? Zugangsdaten, Sdui, Einstellungen und Erinnerung.")) return;
    await pushDisable().catch(() => {});
    await clearCreds();
    sessionCreds = null;
    client.token = client.profile = client.customerNo = null;
    client.dayCache = null;
    showSetup();
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
    saveDaysAhead(Math.min(DAYS_AHEAD.max, Math.max(DAYS_AHEAD.min, loadDaysAhead() + d)));
    const n = loadDaysAhead();
    document.getElementById("days-ahead-val").textContent = n;
    document.getElementById("days-minus").disabled = n <= DAYS_AHEAD.min;
    document.getElementById("days-plus").disabled = n >= DAYS_AHEAD.max;
  };
  document.getElementById("days-minus").onclick = step(-1);
  document.getElementById("days-plus").onclick = step(1);
}

// ---------------------------------------------------------------- Sdui

const SDUI_NOTE = `Sdui lässt Webseiten nicht direkt zu, deshalb laufen Anmeldung und Abruf über unseren Server. Er reicht
  sie nur durch und speichert nichts. Dein Sdui-Passwort geht dabei einmal hindurch. Auf dem Gerät bleibt nur ein
  Zugangsschlüssel, der ein Jahr gilt.`;

async function wireSduiBox(message = "") {
  const box = document.getElementById("sdui-box");
  if (!box) return;
  const cfg = await Sdui.sduiConfig();
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
      sduiSetupForm(e.message);
    }
  };
}

function chooseChild(kids) {
  return new Promise((resolve) => {
    const box = document.getElementById("sdui-box");
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
    await api("POST", `/subscriptions/${store.push.id}/admin`, null, store.push.secret,
      { "X-Admin-Key": document.getElementById("admin-key").value });
    alert("Dieses Gerät ist jetzt Betreiber-Gerät.");
  });
  // Die ganze Zeile öffnet die Zeitauswahl, nicht nur die Ziffern.
  time?.closest(".srow")?.addEventListener("click", (ev) => {
    if (ev.target !== time) try { time.showPicker(); } catch { time.focus(); }
  });
  // Ohne Abo merkt sich das Feld nur die Wahl fürs Einschalten.
  if (store.push && time) time.onchange = guard(() => pushSetTime(time.value));
}

const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function api(method, path, body, secret, extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  const r = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
    subscription: sub.toJSON(), time, weekdays: [1, 2, 3, 4, 5], tz: "Europe/Berlin",
  });
  store.push = { id, secret, time, created: Date.now() };
  await kvSet("push", store.push);
}

async function pushSetTime(time) {
  if (!/^\d{2}:\d{2}$/.test(time)) return;
  await api("PUT", `/subscriptions/${store.push.id}`, { time }, store.push.secret);
  store.push = { ...store.push, time };
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
  await api("POST", `/subscriptions/${store.push.id}/test`, null, store.push.secret);
}

async function pushDisable() {
  const p = store.push;
  store.push = null;
  await kvDel("push");
  if (p) await api("DELETE", `/subscriptions/${p.id}`, null, p.secret).catch(() => {});
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

$reload.onclick = () => showHome(true);
$settings.onclick = showSettings;

// Ohne Service Worker läuft die Seite weiter, nur Erinnerungen gehen dann nicht.
const swReady = "serviceWorker" in navigator
  ? navigator.serviceWorker.register("sw.js", { type: "module" }).then(() => true, () => false)
  : Promise.resolve(false);

// Antippen der Erinnerung öffnet ./?order=<Tag> → direkt in die Bestellansicht.
await loadStore();
const orderDate = new URLSearchParams(location.search).get("order");
if (orderDate && /^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
  history.replaceState(null, "", "./");
  if (currentCreds()) {
    chrome(true);
    showOrder(orderDate);
  } else showHome();
} else showHome();
