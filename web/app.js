import {
  DEFAULT_CHECK, De, IbsAuthError, IbsClient, OrderState,
  addDays, changeKind, collect, isoWeek, placeOrders, targetDates, todayBerlin, weekdayNo,
} from "./ibs.js";
import { kvClear, kvDel, kvGet, kvSet, secretGet, secretSet } from "./idb.js";
import * as Sdui from "./sdui.js";
import { IbsPausedError, guardHooks, resume } from "./guard.js";

// Zugangsdaten (verschlüsselt, siehe idb.js) und Einstellungen liegen nur in
// diesem Browser, in IndexedDB, damit auch der Service Worker sie bei der
// Push-Prüfung lesen kann. Beim Start
// einmal in den Speicher geladen; vorher genutztes localStorage wird übernommen.
const ORDER_WEEKS = 8;
/** So viele Tage zeigt die Liste auf der Startseite (wie DAY_LIST_LENGTH der App). */
const DAY_LIST_LENGTH = 5;

// Wie SettingsStore der Android-App: Standard 7, 1–14 Tage; Prüfzeit Standard 12:00.
const DAYS_AHEAD = { def: 7, min: 1, max: 14 };
const DEFAULT_PUSH_TIME = "12:00";
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
let profile = null;
let loggedInAs = null;

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

/**
 * Einmal einloggen und den Token behalten. Ein abgelaufener Token zeigt sich als
 * Auth- oder Netzfehler (siehe IbsClient#send) → einmal neu anmelden; ist das
 * Netz wirklich weg, scheitert der zweite Versuch genauso.
 */
async function ensureLogin(creds, force = false) {
  if (!force && client.token && loggedInAs === creds.customerNo) return;
  profile = await client.login(creds.customerNo, creds.password);
  loggedInAs = creds.customerNo;
}
async function withLogin(creds, fn) {
  await ensureLogin(creds);
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof IbsAuthError || e.maybeAuth)) throw e;
    await ensureLogin(creds, true);
    return fn();
  }
}

function busy(text) {
  $app.innerHTML = `<p class="muted">${esc(text)}</p>`;
}

// ---------------------------------------------------------------- Einrichten

function showSetup(message = "", prefill = {}) {
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
      client.token = null;
      await ensureLogin(creds, true);
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

async function showHome(fresh = false) {
  const creds = currentCreds();
  if (!creds) return showSetup();
  chrome(true);
  busy("Wochenplan wird geladen …");

  const today = todayBerlin();
  let days;
  try {
    const cfg = { ...DEFAULT_CHECK, daysAhead: loadDaysAhead() };
    days = await withLogin(creds, () => collect(client, targetDates(today, cfg), { fresh }));
  } catch (e) {
    if (e instanceof IbsAuthError && !client.token) return showSetup(`Anmeldung abgelehnt: ${e.message}`, creds);
    const isPause = e instanceof IbsPausedError;
    $app.innerHTML = `
      <div class="card hero ${isPause ? "bad" : "neutral"}">
        <h2>${isPause ? "Bestellsystem gesperrt oder nicht erreichbar" : "Bestellstand unbekannt"}</h2>
        <p>${esc(e.message)}</p>
        <p class="small">Ein Netzfehler ist keine Aussage darüber, ob bestellt ist. Über mobile Daten statt WLAN
          geht es oft trotzdem.</p>
        <button id="b-retry" class="block">${isPause ? "Trotzdem jetzt versuchen" : "Nochmal versuchen"}</button>
      </div>
      ${lastOkLine()}`;
    document.getElementById("b-retry").onclick = async () => {
      if (isPause) await resume();
      showHome(true);
    };
    return;
  }

  // Stundenplan nur, wenn eingerichtet; ein Sdui-Fehler darf den Bestellstand nicht aufhalten.
  const sdui = await Sdui.cachedPlan().catch(() => null);
  const cfg = sdui ? await Sdui.sduiConfig() : null;
  const strip = sdui ? stripMaker(sdui.lessons, cfg?.subjects || []) : null;

  $app.innerHTML = `
    ${heroCard(days, profile?.firstName || "")}
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

  await kvSet("lastOk", { at: Date.now(), via: "app" }).catch(() => {});
  store.lastPushOk = await kvGet("lastPushOk").catch(() => null);
  const stale = pushStale();
  if (stale) $app.insertAdjacentHTML("afterbegin", stale);
  const t = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const pushInfo = store.push && store.lastPushOk ? ` · Erinnerung zuletzt ${esc(when(store.lastPushOk.at))}` : "";
  $footer.innerHTML = `<span>Geprüft ${t}${pushInfo}</span>
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
    <h2>Alles bestellt ✓</h2>
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
  chrome(false);
  $header.hidden = true; // wie OrderScreen der App: nur „Bestellen“ und „Zurück“
  $app.innerHTML = `
    <div class="order-head"><h2>Bestellen</h2><button id="b-back" class="text">Zurück</button></div>
    <div id="o-progress" class="progress"></div>
    <div id="o-result"></div>
    <form id="f-order"></form>`;
  document.getElementById("b-back").onclick = () => showHome();
  const $progress = document.getElementById("o-progress");
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

  async function load(fresh = false) {
    $progress.hidden = false;
    form.innerHTML = "";
    // Woche für Woche laden und aufhören, sobald nach einer Woche mit Speiseplan
    // eine ohne kommt: weiter voraus hat IBS5 noch nichts eingestellt.
    const today = todayBerlin();
    all = [];
    try {
      for (let w = 0; w < ORDER_WEEKS; w++) {
        const dates = [];
        for (let i = w * 7; i < (w + 1) * 7; i++) {
          const d = addDays(today, i);
          if (weekdayNo(d) <= 5) dates.push(d);
        }
        const week = await withLogin(creds, () => collect(client, dates, { fresh }));
        const offered = week.some((d) => d.state !== OrderState.NO_OFFER);
        all = all.concat(week);
        if (!offered && all.some((d) => d.state !== OrderState.NO_OFFER)) break;
      }
    } catch (e) {
      $progress.hidden = true;
      setResult(e.message, "error");
      return;
    }
    $progress.hidden = true;
    days = all.filter(isChangeable);
    render();
  }

  function render() {
    if (!days.length) {
      form.innerHTML = `<p>Keine Tage, die sich noch ändern lassen.</p>`;
      return;
    }
    form.innerHTML = `
      ${days.map((d) => {
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
      }).join("")}
      <button id="b-submit" type="submit" class="block" disabled>Nichts geändert</button>`;
    refresh();
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
    $progress.hidden = false;
    const previouslyInCart = all.flatMap((d) => d.entries.filter((e) => e.quantityInCart === "1" && e.selectable));
    const outcome = await withLogin(creds, () =>
      placeOrders(client, changes, { previouslyInCart, reload: (ds) => collect(client, ds, { fresh: true }) }),
    ).catch((e) => ({ kind: "aborted", reason: e.message }));
    $progress.hidden = true;

    if (outcome.kind === "done") setResult(`Erledigt:\n${outcome.changes.map(describe).join("\n")}`, "ok");
    else if (outcome.kind === "aborted") setResult(`Nichts abgeschickt: ${outcome.reason}`, "error");
    else {
      setResult(`Abgeschickt, aber nicht bestätigt (${outcome.reason}) — bitte auf der Bestellseite nachsehen: `
        + (outcome.missing || []).map(De.short).join(", "), "error");
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (outcome.kind === "done" || outcome.kind === "unconfirmed") await load(true);
    else refresh();
  });

  await load();
  if (focusDate) document.getElementById(`day-${focusDate}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
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

function showSettings() {
  const creds = currentCreds();
  chrome(false);
  $header.hidden = true;
  $app.innerHTML = `
    <div class="back-head"><button id="b-back" class="text">← Zurück</button></div>
    <div class="card settings">
      <h2>Einstellungen</h2>
      <h4>Erinnerung</h4>
      <div id="push-box">${pushBoxHtml()}</div>
      <hr>
      <h4>Schulessen (Sunshine)</h4>
      <div>Vorwarnzeit: <span id="days-ahead-val"></span></div>
      <p class="small muted u-my48">So weit schaut die Übersicht voraus, ab morgen gerechnet.
        Die Erinnerung prüft davon höchstens die nächsten 5 Schultage.</p>
      <input id="days-ahead" type="range" min="${DAYS_AHEAD.min}" max="${DAYS_AHEAD.max}" step="1" value="${loadDaysAhead()}" aria-label="Vorwarnzeit">
      <p class="small muted u-mb0">${esc(profile?.name || "")}${profile?.institution ? ` · ${esc(profile.institution)}` : ""}<br>
        Kundennummer ${esc(creds?.customerNo || "")} · ${loadCreds() ? "auf diesem Gerät gespeichert" : "nur für diese Sitzung"}</p>
      <button id="b-logout" class="danger">Abmelden und alles löschen</button>
      <hr>
      <h4>Stundenplan (Sdui)</h4>
      <div id="sdui-box"></div>
      <hr>
      <h4>Über diese Seite</h4>
      <p class="small muted u-mt0"><b>Testversion.</b> Die Erinnerung prüft auf diesem Gerät. Unser Server weckt
        es dafür nur und kennt weder IBS5-Zugangsdaten noch Bestellungen. Nur die Sdui-Anbindung läuft durch ihn
        (siehe dort). Auf dem iPhone ist die Erinnerung noch nicht ausprobiert.</p>
      <p class="small muted">Kein offizielles Angebot von Sunshine Catering oder dem Hersteller von IBS5. Die Seite spricht direkt
        aus deinem Browser mit dem Bestellsystem.</p>
    </div>`;
  document.getElementById("b-back").onclick = () => showHome();
  const range = document.getElementById("days-ahead");
  const showVal = () => {
    const n = Number(range.value);
    document.getElementById("days-ahead-val").textContent = n === 1 ? "1 Tag" : `${n} Tage`;
  };
  range.oninput = showVal;
  range.onchange = () => saveDaysAhead(Number(range.value));
  showVal();
  wirePushBox();
  wireSduiBox();
  document.getElementById("b-logout").onclick = async () => {
    if (!confirm("Alles auf diesem Gerät löschen? Zugangsdaten, Sdui, Einstellungen und Erinnerung.")) return;
    await pushDisable().catch(() => {});
    await clearCreds();
    sessionCreds = null;
    client.token = null;
    profile = null;
    loggedInAs = null;
    showSetup();
  };
}

// ---------------------------------------------------------------- Sdui

const SDUI_NOTE = `Sdui lässt Webseiten nicht direkt zu, deshalb laufen Anmeldung und Abruf über unseren Server. Er reicht
  sie nur durch und speichert nichts. Dein Sdui-Passwort geht dabei einmal hindurch; auf dem Gerät bleibt nur ein
  Zugangsschlüssel, der ein Jahr gilt.`;

async function wireSduiBox(message = "") {
  const box = document.getElementById("sdui-box");
  if (!box) return;
  const cfg = await Sdui.sduiConfig();
  const msg = message ? `<p class="small error">${esc(message)}</p>` : "";
  if (!cfg) {
    box.innerHTML = `${msg}<p class="small muted u-mb6">Wer mag, holt sich den Stundenplan dazu: Die
      Startseite zeigt je Tag die Stunden, und die Erinnerung meldet am Vortag gewählte Fächer wie Sport.</p>
      <button id="b-sdui-setup" class="text u-pl0">Einrichten …</button>`;
    document.getElementById("b-sdui-setup").onclick = () => sduiSetupForm();
    return;
  }
  const known = (await kvGet("sduiKnown")) || [];
  const shorts = new Map(((await kvGet("sduiPlan"))?.lessons || []).map((l) => [l.subject, l.short]));
  box.innerHTML = `${msg}
    <div>${esc(cfg.childName || "")}${cfg.slink ? ` <span class="small muted">· ${esc(cfg.slink)}</span>` : ""}</div>
    <p class="small muted u-my64">Am Vortag mit der Essenserinnerung melden:</p>
    ${known.length ? `
    <details class="dropdown">
      <summary><span class="dd-label">Erinnern an</span><span class="dd-value"></span></summary>
      <div class="subjects">${known.map((sub) => `
        <label class="check"><input type="checkbox" value="${esc(sub)}" ${cfg.subjects.includes(sub) ? "checked" : ""}>
          ${esc(sub)}${shorts.get(sub) ? ` <span class="small muted">(${esc(shorts.get(sub))})</span>` : ""}</label>`).join("")}</div>
    </details>` : `<p class="small muted">Noch kein Plan geladen.</p>`}
    <button id="b-sdui-off" class="danger">Sdui entfernen</button>`;
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
  box.innerHTML = `
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
    </form>`;
  document.getElementById("b-sdui-cancel").onclick = () => wireSduiBox();
  document.getElementById("f-sdui").onsubmit = async (ev) => {
    ev.preventDefault();
    const slink = Sdui.parseSlink(document.getElementById("s-school").value);
    const identifier = document.getElementById("s-id").value.trim();
    const password = document.getElementById("s-pw").value;
    box.innerHTML = `<p class="small muted">Verbinde mit Sdui …</p>`;
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
    box.innerHTML = `<p class="small muted u-mb6">Für welches Kind?</p>
      ${kids.map((k, i) => `<button class="text kid u-block u-pl0" data-i="${i}">${esc(k.name)}</button>`).join("")}
      <button class="text u-pl0" id="b-kid-cancel">Abbrechen</button>`;
    box.querySelectorAll(".kid").forEach((b) => { b.onclick = () => resolve(kids[Number(b.dataset.i)]); });
    document.getElementById("b-kid-cancel").onclick = () => resolve(null);
  });
}

// ---------------------------------------------------------------- Erinnerung

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function pushBoxHtml(message = "") {
  const msg = message ? `<p class="small error">${esc(message)}</p>` : "";
  if (!pushSupported) {
    return `<p class="small muted u-m0">${isIos && !standalone
      ? "Auf dem iPhone gibt es Erinnerungen nur, wenn die Seite über Teilen → „Zum Home-Bildschirm“ installiert ist und von dort geöffnet wird."
      : "Dieser Browser kann keine Erinnerungen empfangen."}</p>`;
  }
  if (!store.push) {
    return `${msg}<p class="small muted u-mb6">Werktags zur gewählten Zeit prüft dieses Gerät selbst und meldet sich,
      wenn etwas offen ist. Unser Server weckt es dafür nur — er kennt weder Zugangsdaten noch Bestellstand.</p>
      <label class="u-normal" for="push-time">Uhrzeit</label>
      <input id="push-time" type="time" value="${DEFAULT_PUSH_TIME}" step="300">
      <div class="row"><button id="b-push-on" class="block">Erinnerung einschalten</button></div>`;
  }
  return `${msg}<div>Werktags gegen ${esc(store.push.time)}</div>
    <label class="u-normal" for="push-time">Uhrzeit ändern</label>
    <input id="push-time" type="time" value="${esc(store.push.time)}" step="300">
    <div class="row">
      <button id="b-push-test" class="text">Jetzt testen</button>
      <button id="b-push-off" class="danger">Ausschalten</button>
    </div>
`;
}

function wirePushBox(message = "") {
  const box = document.getElementById("push-box");
  if (!box) return;
  box.innerHTML = pushBoxHtml(message);
  const on = document.getElementById("b-push-on");
  const off = document.getElementById("b-push-off");
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
  if (on) on.onclick = guard(() => pushEnable(time.value || DEFAULT_PUSH_TIME));
  if (off) off.onclick = guard(pushDisable);
  if (test) test.onclick = guard(pushTest);
  if (store.push && time) time.onchange = guard(() => pushSetTime(time.value));
}

const b64ToBytes = (b64) => {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

async function api(method, path, body, secret) {
  const headers = { "Content-Type": "application/json" };
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
      ? "Benachrichtigungen sind nicht erlaubt. Einstellungen → Mitteilungen → immerhin.satt → Mitteilungen erlauben."
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
