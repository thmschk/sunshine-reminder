import {
  DEFAULT_CHECK, De, IbsAuthError, IbsClient, OrderState,
  addDays, changeKind, collect, placeOrders, targetDates, todayBerlin, weekdayNo,
} from "./ibs.js";

// Zugangsdaten liegen nur in diesem Browser. Prototyp: localStorage; für den
// Service Worker (Push-Prüfung) wandern sie später nach IndexedDB.
const CREDS_KEY = "hs.creds";
const DAYS_AHEAD_KEY = "hs.daysAhead";
const ORDER_WEEKS = 8;
/** So viele Tage zeigt die Liste auf der Startseite (wie DAY_LIST_LENGTH der App). */
const DAY_LIST_LENGTH = 5;

// Wie SettingsStore der Android-App: Standard 7, 1–14 Tage.
const DAYS_AHEAD = { def: 7, min: 1, max: 14 };
function loadDaysAhead() {
  try {
    const n = parseInt(localStorage.getItem(DAYS_AHEAD_KEY), 10);
    return n >= DAYS_AHEAD.min && n <= DAYS_AHEAD.max ? n : DAYS_AHEAD.def;
  } catch {
    return DAYS_AHEAD.def;
  }
}
function saveDaysAhead(n) {
  try { localStorage.setItem(DAYS_AHEAD_KEY, String(n)); } catch { /* privater Modus */ }
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

function loadCreds() {
  try {
    const c = JSON.parse(localStorage.getItem(CREDS_KEY) || "null");
    return c?.customerNo && c?.password ? c : null;
  } catch {
    return null;
  }
}
function saveCreds(c) {
  try { localStorage.setItem(CREDS_KEY, JSON.stringify(c)); } catch { /* privater Modus */ }
}
function clearCreds() {
  try { localStorage.removeItem(CREDS_KEY); } catch { /* egal */ }
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
    if (remember) saveCreds(creds);
    else sessionCreds = creds;
    showHome();
  });
}

let sessionCreds = null;
const currentCreds = () => loadCreds() ?? sessionCreds;

// ---------------------------------------------------------------- Startseite

async function showHome() {
  const creds = currentCreds();
  if (!creds) return showSetup();
  chrome(true);
  busy("Wochenplan wird geladen …");

  const today = todayBerlin();
  let days;
  try {
    const cfg = { ...DEFAULT_CHECK, daysAhead: loadDaysAhead() };
    days = await withLogin(creds, () => collect(client, targetDates(today, cfg)));
  } catch (e) {
    if (e instanceof IbsAuthError && !client.token) return showSetup(`Anmeldung abgelehnt: ${e.message}`, creds);
    $app.innerHTML = `
      <div class="card hero neutral">
        <h2>Bestellstand unbekannt</h2>
        <p>${esc(e.message)}</p>
        <p class="small">Ein Netzfehler ist keine Aussage darüber, ob bestellt ist.</p>
        <button id="b-retry" class="block">Nochmal versuchen</button>
      </div>`;
    document.getElementById("b-retry").onclick = showHome;
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
  busy(`Speisepläne der nächsten ${ORDER_WEEKS} Wochen werden geladen …`);

  const today = todayBerlin();
  const dates = [];
  for (let i = 0; i < ORDER_WEEKS * 7; i++) {
    const d = addDays(today, i);
    if (weekdayNo(d) <= 5) dates.push(d);
  }
  let all;
  try {
    all = await withLogin(creds, () => collect(client, dates));
  } catch (e) {
    $app.innerHTML = `<div class="card hero bad"><h2>Laden fehlgeschlagen</h2><p>${esc(e.message)}</p></div>
      <div class="row"><button id="b-back" class="text">← Zurück</button></div>`;
    document.getElementById("b-back").onclick = showHome;
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
    document.getElementById("b-back").onclick = showHome;
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

  document.getElementById("b-back").onclick = showHome;
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
      placeOrders(client, changes, { dryRun, previouslyInCart, reload: (ds) => collect(client, ds) }),
    ).catch((e) => ({ kind: "aborted", reason: e.message }));

    const html = {
      done: `<div class="card hero ok"><h2>Erledigt</h2><pre class="msg small">${esc(list)}</pre></div>`,
      dryrun: `<div class="card hero ok"><h2>Probelauf ok</h2><p class="small">Alles lag korrekt im Warenkorb und wurde wieder entfernt.</p><pre class="msg small">${esc(list)}</pre></div>`,
      aborted: `<div class="card hero bad"><h2>Nichts abgeschickt</h2><p>${esc(result.reason)}</p></div>`,
      unconfirmed: `<div class="card hero open"><h2>Abgeschickt, aber nicht bestätigt</h2><p>${esc(result.reason)}</p>
        <p class="small">Bitte auf der Bestellseite nachsehen: ${esc((result.missing || []).map(De.short).join(", "))}</p></div>`,
    }[result.kind];
    $app.innerHTML = `${html}<div class="row"><button id="b-home" class="block">Zur Übersicht</button></div>`;
    document.getElementById("b-home").onclick = showHome;
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
  document.getElementById("b-back").onclick = showHome;
  const range = document.getElementById("days-ahead");
  const showVal = () => {
    const n = Number(range.value);
    document.getElementById("days-ahead-val").textContent = n === 1 ? "1 Tag" : `${n} Tage`;
  };
  range.oninput = showVal;
  range.onchange = () => saveDaysAhead(Number(range.value));
  showVal();
  document.getElementById("b-logout").onclick = () => {
    if (!confirm("Zugangsdaten auf diesem Gerät löschen?")) return;
    clearCreds();
    sessionCreds = null;
    client.token = null;
    profile = null;
    loggedInAs = null;
    showSetup();
  };
}

$reload.onclick = showHome;
$settings.onclick = showSettings;

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => { /* Seite funktioniert auch ohne */ });
}

showHome();
