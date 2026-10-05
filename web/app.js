import {
  AlarmText, De, IbsAuthError, IbsClient, OrderState, STATE_LABEL, WEB_URL,
  addDays, changeKind, collect, evaluate, placeOrders, targetDates, todayBerlin, weekdayNo,
} from "./ibs.js";

// Zugangsdaten liegen nur in diesem Browser. Prototyp: localStorage; für den
// Service Worker (Push-Prüfung) wandern sie später nach IndexedDB.
const CREDS_KEY = "hs.creds";
const ORDER_WEEKS = 8;

const $app = document.getElementById("app");
const $reload = document.getElementById("btn-reload");
const $settings = document.getElementById("btn-settings");

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
  $reload.hidden = true;
  $settings.hidden = true;
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
        <div class="row"><button type="submit">Anmelden</button></div>
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
  $reload.hidden = false;
  $settings.hidden = false;
  busy("Wochenplan wird geladen …");

  const today = todayBerlin();
  let days;
  try {
    days = await withLogin(creds, () => collect(client, targetDates(today)));
  } catch (e) {
    if (e instanceof IbsAuthError && !client.token) return showSetup(`Anmeldung abgelehnt: ${e.message}`, creds);
    $app.innerHTML = `
      <div class="card status bad">
        <h2>Bestellstand unbekannt</h2>
        <p>${esc(e.message)}</p>
        <p class="small">Ein Netzfehler ist keine Aussage darüber, ob bestellt ist.</p>
      </div>
      <div class="row"><button id="b-retry">Nochmal versuchen</button></div>`;
    document.getElementById("b-retry").onclick = showHome;
    return;
  }

  const alarm = evaluate(days);
  const first = profile?.firstName || "";
  let status;
  if (!days.length) {
    status = `<div class="card status ok"><h2>Keine Schultage im Prüfzeitraum</h2></div>`;
  } else if (alarm.kind === "ok") {
    status = `<div class="card status ok"><h2>Alles bestellt ✓</h2>
      <p class="small">${first ? `Für ${esc(first)} · ` : ""}bis ${esc(De.chip(days.at(-1).date))}</p></div>`;
  } else {
    const cls = alarm.actionable.length ? "warn" : "bad";
    status = `<div class="card status ${cls}"><h2>${esc(AlarmText.title(alarm, first))}</h2>
      <pre class="msg small">${esc(AlarmText.body(alarm))}</pre>
      ${alarm.actionable.length ? `<div class="row"><button id="b-order-now">Jetzt bestellen</button></div>` : ""}</div>`;
  }

  $app.innerHTML = `
    ${status}
    <h3>DIE NÄCHSTEN TAGE</h3>
    <div class="card">
      <ul class="days">
        ${days.map((d) => `
          <li data-date="${d.date}">
            <span class="date">${esc(De.chip(d.date))}</span>
            <span class="dish">${esc(d.orderedItems[0] || (d.state === OrderState.NO_OFFER ? "" : "—"))}</span>
            <span class="badge ${d.state}">${esc(shortLabel(d.state))}</span>
          </li>`).join("")}
      </ul>
    </div>
    <div class="row">
      <button id="b-all" class="secondary">Alle bestellbaren Tage →</button>
      <a class="button secondary" href="${WEB_URL}" target="_blank" rel="noopener">Bestellseite öffnen</a>
    </div>`;

  for (const li of $app.querySelectorAll(".days li")) li.onclick = () => showOrder(li.dataset.date);
  document.getElementById("b-all").onclick = () => showOrder();
  const now = document.getElementById("b-order-now");
  if (now) now.onclick = () => showOrder(alarm.actionable[0].date);
}

function shortLabel(state) {
  return {
    ORDERED: "bestellt",
    IN_CART: "im Warenkorb",
    NOT_ORDERED: "offen",
    DEADLINE_PASSED: "zu spät",
    NO_OFFER: "kein Angebot",
    UNKNOWN: "unklar",
  }[state];
}

// ---------------------------------------------------------------- Bestellen

async function showOrder(focusDate = null) {
  const creds = currentCreds();
  if (!creds) return showSetup();
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
    $app.innerHTML = `<div class="card status bad"><h2>Laden fehlgeschlagen</h2><p>${esc(e.message)}</p></div>
      <div class="row"><button id="b-back" class="secondary">← Zurück</button></div>`;
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
      <div class="row"><button id="b-back" class="secondary">← Zurück</button></div>`;
    document.getElementById("b-back").onclick = showHome;
    return;
  }

  $app.innerHTML = `
    <div class="row" style="margin-top:0"><button id="b-back" class="secondary">← Zurück</button></div>
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
        <div class="row" style="margin-top:8px"><button id="b-submit" type="submit" disabled>Nichts geändert</button></div>
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
      done: `<div class="card status ok"><h2>Erledigt</h2><pre class="msg small">${esc(list)}</pre></div>`,
      dryrun: `<div class="card status ok"><h2>Probelauf ok</h2><p class="small">Alles lag korrekt im Warenkorb und wurde wieder entfernt.</p><pre class="msg small">${esc(list)}</pre></div>`,
      aborted: `<div class="card status bad"><h2>Nichts abgeschickt</h2><p>${esc(result.reason)}</p></div>`,
      unconfirmed: `<div class="card status warn"><h2>Abgeschickt, aber nicht bestätigt</h2><p>${esc(result.reason)}</p>
        <p class="small">Bitte auf der Bestellseite nachsehen: ${esc((result.missing || []).map(De.short).join(", "))}</p></div>`,
    }[result.kind];
    $app.innerHTML = `${html}<div class="row"><button id="b-home">Zur Übersicht</button></div>`;
    document.getElementById("b-home").onclick = showHome;
  });

  if (focusDate) document.getElementById(`day-${focusDate}`)?.scrollIntoView({ block: "start" });
}

// ---------------------------------------------------------------- Einstellungen

function showSettings() {
  const creds = currentCreds();
  $app.innerHTML = `
    <div class="row" style="margin-top:0"><button id="b-back" class="secondary">← Zurück</button></div>
    <div class="card">
      <h2 style="margin-top:0">Konto</h2>
      <p>${esc(profile?.name || "")}${profile?.institution ? `<br><span class="muted small">${esc(profile.institution)}</span>` : ""}</p>
      <p class="small muted">Kundennummer ${esc(creds?.customerNo || "")} · ${loadCreds() ? "auf diesem Gerät gespeichert" : "nur für diese Sitzung"}</p>
      <div class="row"><button id="b-logout" class="secondary">Abmelden und Zugangsdaten löschen</button></div>
    </div>
    <div class="card small muted">
      <p style="margin-top:0"><b>Prototyp.</b> Es gibt noch keine Erinnerung — die Seite prüft nur, wenn sie offen ist.</p>
      <p>Kein offizielles Angebot von Sunshine Catering oder dem Hersteller von IBS5. Die Seite spricht direkt
        aus deinem Browser mit dem Bestellsystem; über unseren Server laufen keine Zugangsdaten.</p>
    </div>`;
  document.getElementById("b-back").onclick = showHome;
  document.getElementById("b-logout").onclick = () => {
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
