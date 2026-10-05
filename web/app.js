import {
  DEFAULT_CHECK, De, IbsAuthError, IbsClient, OrderState,
  addDays, changeKind, collect, placeOrders, targetDates, todayBerlin, weekdayNo,
} from "./ibs.js";
import { kvDel, kvGet, kvSet } from "./idb.js";

// Zugangsdaten und Einstellungen liegen nur in diesem Browser, in IndexedDB,
// damit auch der Service Worker sie bei der Push-Prüfung lesen kann. Beim Start
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
      await kvSet("creds", JSON.parse(old));
      const n = parseInt(localStorage.getItem("hs.daysAhead"), 10);
      if (n) await kvSet("daysAhead", n);
      localStorage.removeItem("hs.creds");
      localStorage.removeItem("hs.daysAhead");
    }
  } catch { /* kein localStorage */ }
  const c = await kvGet("creds");
  store.creds = c?.customerNo && c?.password ? c : null;
  const n = await kvGet("daysAhead");
  store.daysAhead = n >= DAYS_AHEAD.min && n <= DAYS_AHEAD.max ? n : DAYS_AHEAD.def;
  store.push = (await kvGet("push")) || null;
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

function chrome(visible) {
  $reload.hidden = $settings.hidden = $web.hidden = !visible;
  if (!visible) $footer.hidden = true;
}

const client = new IbsClient();
let profile = null;
let loggedInAs = null;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function saveCreds(c) {
  store.creds = c;
  await kvSet("creds", c).catch(() => {});
}
async function clearCreds() {
  store.creds = null;
  await kvDel("creds");
  await kvDel("notified");
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
    <div class="card">
      <h2 style="margin-top:0">Anmelden</h2>
      <p class="small muted">Mit den Zugangsdaten des Schulessen-Bestellsystems (IBS5). Sie bleiben in
        diesem Browser und gehen nur an das Bestellsystem selbst.</p>
      ${message ? `<p class="error">${esc(message)}</p>` : ""}
      <form id="f-login" autocomplete="on">
        <label for="cn">Kundennummer</label>
        <input id="cn" name="username" type="text" inputmode="numeric" autocomplete="username" required value="${esc(prefill.customerNo)}">
        <label for="pw">Passwort</label>
        <input id="pw" name="password" type="password" autocomplete="current-password" required>
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
    $app.innerHTML = `
      <div class="card hero neutral">
        <h2>Bestellstand unbekannt</h2>
        <p>${esc(e.message)}</p>
        <p class="small">Ein Netzfehler ist keine Aussage darüber, ob bestellt ist.</p>
        <button id="b-retry" class="block">Nochmal versuchen</button>
      </div>`;
    document.getElementById("b-retry").onclick = () => showHome(true);
    return;
  }

  $app.innerHTML = `
    ${heroCard(days, profile?.firstName || "")}
    ${days.length ? `
      <div class="section">DIE NÄCHSTEN TAGE</div>
      <ul class="days">${days.slice(0, DAY_LIST_LENGTH).map(dayRow).join("")}</ul>` : ""}
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

  const t = new Intl.DateTimeFormat("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" }).format(new Date());
  $footer.textContent = `Geprüft ${t}`;
  $footer.hidden = false;
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

const SUB = {
  ORDERED: ["bestellt", ""],
  NOT_ORDERED: ["offen · Tippen zum Bestellen", "open"],
  IN_CART: ["nur im Warenkorb · Tippen zum Bestellen", "open"],
  DEADLINE_PASSED: ["Bestellschluss vorbei · Brot einpacken", "bad"],
  NO_OFFER: ["kein Angebot", "bad"],
  UNKNOWN: ["unklar · bitte selbst nachsehen", "bad"],
};

/** Wie DayRow der App: Wochentag/Tag, Gericht einzeilig + Status, Symbol rechts. */
function dayRow(d) {
  const dish = d.state === OrderState.NOT_ORDERED ? "Gericht wählen"
    : d.state === OrderState.DEADLINE_PASSED ? "nicht bestellt"
    : d.orderedItems[0] || "—";
  const [sub, subCls] = SUB[d.state];
  const [sym, symCls] = d.state === OrderState.ORDERED ? ["✓", "ok"] : d.isActionable ? ["!", "open"] : ["✕", "bad"];
  return `
    <li data-date="${d.date}">
      <div class="date"><div class="wd">${esc(De.chip(d.date).slice(0, 2))}</div><div class="dom">${Number(d.date.slice(8, 10))}</div></div>
      <div class="text"><div class="dish">${esc(dish)}</div><div class="sub ${subCls}">${esc(sub)}</div></div>
      <div class="sym ${symCls}">${sym}</div>
    </li>`;
}

// ---------------------------------------------------------------- Bestellen

async function showOrder(focusDate = null) {
  const creds = currentCreds();
  if (!creds) return showSetup();
  $footer.hidden = true;
  busy("Speisepläne werden geladen …");

  // Woche für Woche laden und aufhören, sobald nach einer Woche mit Speiseplan
  // eine ohne kommt: weiter voraus hat IBS5 noch nichts eingestellt.
  const today = todayBerlin();
  let all = [];
  try {
    for (let w = 0; w < ORDER_WEEKS; w++) {
      const dates = [];
      for (let i = w * 7; i < (w + 1) * 7; i++) {
        const d = addDays(today, i);
        if (weekdayNo(d) <= 5) dates.push(d);
      }
      const week = await withLogin(creds, () => collect(client, dates));
      const offered = week.some((d) => d.state !== OrderState.NO_OFFER);
      all = all.concat(week);
      if (!offered && all.some((d) => d.state !== OrderState.NO_OFFER)) break;
    }
  } catch (e) {
    $app.innerHTML = `<div class="card hero bad"><h2>Laden fehlgeschlagen</h2><p>${esc(e.message)}</p></div>
      <div class="row"><button id="b-back" class="text">← Zurück</button></div>`;
    document.getElementById("b-back").onclick = () => showHome();
    return;
  }

  // Nur Tage, an denen sich noch etwas wählen lässt; die bestellte Linie muss
  // selbst änderbar sein, sonst ist der Tag gesperrt.
  const days = all.filter((d) => {
    const ordered = d.entries.find((e) => e.isOrdered);
    return d.entries.some((e) => e.selectable) && (!ordered || ordered.selectable);
  });
  const previouslyInCart = all.flatMap((d) => d.entries.filter((e) => e.quantityInCart !== "" && e.selectable));

  if (!days.length) {
    $app.innerHTML = `<div class="card"><p>Keine Tage, die sich noch ändern lassen.</p></div>
      <div class="row"><button id="b-back" class="text">← Zurück</button></div>`;
    document.getElementById("b-back").onclick = () => showHome();
    return;
  }

  $app.innerHTML = `
    <div class="row" style="margin-top:0"><button id="b-back" class="text">← Zurück</button></div>
    <p class="small muted">Offene Tage stehen auf „nichts“. Wer ein anderes Gericht wählt, bestellt um.
      Abgeschickt wird nur, was du änderst.</p>
    <form id="f-order">
      ${days.map((d) => {
        const ordered = d.entries.find((e) => e.isOrdered);
        const none = ordered ? "abbestellen" : "nichts";
        return `
        <div class="card day-order" id="day-${d.date}">
          <fieldset>
            <legend>${esc(De.long(d.date))}${d.state === OrderState.IN_CART ? ` <span class="badge IN_CART">im Warenkorb</span>` : ""}</legend>
            ${d.entries.map((e, i) => `
              <label class="choice ${e.selectable ? "" : "locked"}">
                <input type="radio" name="d-${d.date}" value="${i}" ${e.isOrdered ? "checked" : ""} ${e.selectable ? "" : "disabled"}>
                <span>${esc(e.name)}${e.isOrdered ? " <span class='badge ORDERED'>bestellt</span>" : ""}${e.selectable ? "" : " <span class='small'>(nicht wählbar)</span>"}</span>
              </label>`).join("")}
            <label class="choice"><input type="radio" name="d-${d.date}" value="none" ${ordered ? "" : "checked"}><span>${none}</span></label>
          </fieldset>
        </div>`;
      }).join("")}
      <div class="sticky">
        <label class="check small"><input id="dry" type="checkbox"> Nur Probelauf (Warenkorb füllen, prüfen, wieder leeren)</label>
        <div class="row" style="margin-top:8px"><button id="b-submit" type="submit" class="block" disabled>Nichts geändert</button></div>
      </div>
    </form>`;

  document.getElementById("b-back").onclick = () => showHome();
  const form = document.getElementById("f-order");
  const submit = document.getElementById("b-submit");

  const pending = () => days.map((d) => {
    const v = form.querySelector(`input[name="d-${d.date}"]:checked`)?.value;
    return {
      date: d.date,
      current: d.entries.find((e) => e.isOrdered) ?? null,
      target: v == null || v === "none" ? null : d.entries[Number(v)],
    };
  }).filter((c) => changeKind(c) !== "NONE");

  const refresh = () => {
    const changes = pending();
    for (const d of days) {
      document.getElementById(`day-${d.date}`).classList.toggle("changed", changes.some((c) => c.date === d.date));
    }
    submit.disabled = !changes.length;
    submit.textContent = changes.length ? `Abschicken (${changes.length})` : "Nichts geändert";
  };
  form.addEventListener("change", refresh);
  refresh();

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const changes = pending();
    const dryRun = document.getElementById("dry").checked;
    const verb = { ORDER: "bestellen", SWITCH: "umbestellen auf", CANCEL: "abbestellen" };
    const list = changes.map((c) => `• ${De.short(c.date)}: ${verb[changeKind(c)]} ${c.target?.name ?? c.current?.name ?? ""}`).join("\n");
    if (!dryRun && !confirm(`Verbindlich abschicken?\n\n${list}`)) return;

    busy(dryRun ? "Probelauf …" : "Wird abgeschickt …");
    const result = await withLogin(creds, () =>
      placeOrders(client, changes, { dryRun, previouslyInCart, reload: (ds) => collect(client, ds, { fresh: true }) }),
    ).catch((e) => ({ kind: "aborted", reason: e.message }));

    const html = {
      done: `<div class="card hero ok"><h2>Erledigt</h2><pre class="msg small">${esc(list)}</pre></div>`,
      dryrun: `<div class="card hero ok"><h2>Probelauf ok</h2><p class="small">Alles lag korrekt im Warenkorb und wurde wieder entfernt.</p><pre class="msg small">${esc(list)}</pre></div>`,
      aborted: `<div class="card hero bad"><h2>Nichts abgeschickt</h2><p>${esc(result.reason)}</p></div>`,
      unconfirmed: `<div class="card hero open"><h2>Abgeschickt, aber nicht bestätigt</h2><p>${esc(result.reason)}</p>
        <p class="small">Bitte auf der Bestellseite nachsehen: ${esc((result.missing || []).map(De.short).join(", "))}</p></div>`,
    }[result.kind];
    $app.innerHTML = `${html}<div class="row"><button id="b-home" class="block">Zur Übersicht</button></div>`;
    document.getElementById("b-home").onclick = () => showHome();
  });

  if (focusDate) document.getElementById(`day-${focusDate}`)?.scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------------- Einstellungen

function showSettings() {
  const creds = currentCreds();
  $footer.hidden = true;
  $app.innerHTML = `
    <div class="card settings">
      <h2>Einstellungen</h2>
      <h4>Erinnerung</h4>
      <div id="push-box">${pushBoxHtml()}</div>
      <hr>
      <h4>Schulessen (Sunshine)</h4>
      <div>Vorwarnzeit: <span id="days-ahead-val"></span></div>
      <p class="small muted" style="margin:4px 0 8px">So weit schaut die Übersicht voraus, ab morgen gerechnet.</p>
      <input id="days-ahead" type="range" min="${DAYS_AHEAD.min}" max="${DAYS_AHEAD.max}" step="1" value="${loadDaysAhead()}" aria-label="Vorwarnzeit">
      <p class="small muted" style="margin-bottom:0">${esc(profile?.name || "")}${profile?.institution ? ` · ${esc(profile.institution)}` : ""}<br>
        Kundennummer ${esc(creds?.customerNo || "")} · ${loadCreds() ? "auf diesem Gerät gespeichert" : "nur für diese Sitzung"}</p>
      <button id="b-logout" class="danger">Zugangsdaten löschen</button>
      <hr>
      <h4>Über diese Seite</h4>
      <p class="small muted" style="margin-top:0"><b>Prototyp.</b> Es gibt noch keine Erinnerung — die Seite prüft nur, wenn sie offen ist.</p>
      <p class="small muted">Kein offizielles Angebot von Sunshine Catering oder dem Hersteller von IBS5. Die Seite spricht direkt
        aus deinem Browser mit dem Bestellsystem; über unseren Server laufen keine Zugangsdaten.</p>
      <div class="row" style="justify-content:flex-end"><button id="b-back" class="text">Schließen</button></div>
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
  document.getElementById("b-logout").onclick = async () => {
    if (!confirm("Zugangsdaten auf diesem Gerät löschen? Die Erinnerung wird dabei ausgeschaltet.")) return;
    await pushDisable().catch(() => {});
    await clearCreds();
    sessionCreds = null;
    client.token = null;
    profile = null;
    loggedInAs = null;
    showSetup();
  };
}

// ---------------------------------------------------------------- Erinnerung

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function pushBoxHtml(message = "") {
  const msg = message ? `<p class="small error">${esc(message)}</p>` : "";
  if (!pushSupported) {
    return `<p class="small muted" style="margin:0">${isIos && !standalone
      ? "Auf dem iPhone gibt es Erinnerungen nur, wenn die Seite über Teilen → „Zum Home-Bildschirm“ installiert ist und von dort geöffnet wird."
      : "Dieser Browser kann keine Erinnerungen empfangen."}</p>`;
  }
  if (!store.push) {
    return `${msg}<p class="small muted" style="margin:0 0 6px">Werktags zur gewählten Zeit prüft dieses Gerät selbst und meldet sich,
      wenn etwas offen ist. Unser Server weckt es dafür nur — er kennt weder Zugangsdaten noch Bestellstand.</p>
      <label for="push-time" style="font-weight:normal">Uhrzeit</label>
      <input id="push-time" type="time" value="${DEFAULT_PUSH_TIME}" step="300">
      <div class="row"><button id="b-push-on" class="block">Erinnerung einschalten</button></div>`;
  }
  return `${msg}<div>Werktags gegen ${esc(store.push.time)}</div>
    <label for="push-time" style="font-weight:normal">Uhrzeit ändern</label>
    <input id="push-time" type="time" value="${esc(store.push.time)}" step="300">
    <div class="row">
      <button id="b-push-test" class="text">Jetzt testen</button>
      <button id="b-push-off" class="danger">Ausschalten</button>
    </div>`;
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
  if (perm !== "granted") throw new Error("Benachrichtigungen sind für diese Seite nicht erlaubt.");
  // serviceWorker.ready käme ohne erfolgreiche Registrierung nie zurück.
  if (!(await swReady)) throw new Error("Dieser Browser kann den Hintergrunddienst für Erinnerungen nicht starten.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api("GET", "/vapid");
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  const { id, secret } = await api("POST", "/subscriptions", {
    subscription: sub.toJSON(), time, weekdays: [1, 2, 3, 4, 5], tz: "Europe/Berlin",
  });
  store.push = { id, secret, time };
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
