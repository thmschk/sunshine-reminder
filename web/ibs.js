// IBS5-Client, Wochenplan-Parser, Prüfung und Bestellung für den Browser.
//
// Portiert aus android/core (IbsClient, WeekplanParser, OrderChecker, OrderPlacer);
// fachliche Begründungen stehen dort. Der Parser arbeitet bewusst mit regulären
// Ausdrücken statt DOMParser, weil er auch im Service Worker laufen muss, und den
// gibt es dort nicht.
//
// Handy-Browser bekommen von IBS5 am User-Agent erkannt statt des Wochenplans eine
// Tagesansicht (id="dayplan"), auch bei Angabe von year/week. Der Client erkennt
// das an der ersten Antwort und lädt dann je Tag über WeekplanMobile?date=.

export const BASE_URL = "https://ibs.sunshine-catering.de/ibs5";
export const WEB_URL = "https://ibs.sunshine-catering.de/IBS5";

export class IbsError extends Error {}
/** Login abgelehnt, oder der Token ist nicht (mehr) gültig. */
export class IbsAuthError extends IbsError {}
/** Die Antwort sah nicht nach einem Wochenplan aus. */
export class ParserError extends IbsError {}

// ---------------------------------------------------------------- Datum

/** Datumswerte sind durchgehend "YYYY-MM-DD"-Strings; gerechnet wird in UTC. */
const toDate = (iso) => new Date(iso + "T00:00:00Z");
const toIso = (d) => d.toISOString().slice(0, 10);

export function addDays(iso, n) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/** 1 = Montag … 7 = Sonntag */
export const weekdayNo = (iso) => ((toDate(iso).getUTCDay() + 6) % 7) + 1;

/**
 * Heute in Europe/Berlin, unabhängig von der Zeitzone des Geräts. Über
 * formatToParts statt einer Locale mit ISO-Schreibweise: Chrome auf Android
 * bringt nur einen Teil der Locales mit und fiele sonst auf "5.10.2026" zurück.
 */
export function todayBerlin(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** ISO-Kalenderwoche: [Jahr, Woche] */
export function isoWeek(iso) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + 4 - weekdayNo(iso));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return [d.getUTCFullYear(), Math.ceil(((d - yearStart) / 86400000 + 1) / 7)];
}

const LONG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
const SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const dmy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
export const De = {
  weekday: (iso) => LONG[weekdayNo(iso) - 1],
  long: (iso) => `${LONG[weekdayNo(iso) - 1]}, ${dmy(iso)}`,
  short: (iso) => `${SHORT[weekdayNo(iso) - 1]} ${dmy(iso)}`,
  chip: (iso) => `${SHORT[weekdayNo(iso) - 1]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`,
};

// ---------------------------------------------------------------- Client

/**
 * Zwei Eigenheiten des Servers (siehe IbsClient.kt): ohne Accept-Language kommt
 * HTTP 500 (setzt der Browser selbst), und authentifizierte Endpunkte wollen
 * X-Requested-With. Ohne gültigen Token leitet IBS5 per 302 auf eine Fehlerseite
 * ohne CORS-Freigabe um. Der Browser prüft CORS schon an der 302-Antwort, also
 * kommt dann nur ein Netzfehler an — nicht unterscheidbar von einem echten.
 * Solche Fehler bei angemeldeten Aufrufen tragen deshalb maybeAuth.
 */
export class IbsClient {
  /** hooks.before() vor jeder Anfrage, hooks.failed({path, status, network}) danach (siehe guard.js). */
  constructor(baseUrl = BASE_URL, hooks = {}) {
    this.base = baseUrl.replace(/\/+$/, "");
    this.token = null;
    this.hooks = hooks;
  }

  /**
   * Bewusst ohne Wiederholung: die Sperrpolitik des Anbieters ist unbekannt.
   *
   * Ohne X-Requested-With, damit der Login eine einfache CORS-Anfrage ohne
   * Preflight bleibt: der Service Worker schickt Preflights ohne Accept-Language,
   * und darauf antwortet IBS5 bei /Login/Login mit 302 statt 200.
   */
  async login(customerNo, password) {
    const body = new URLSearchParams({
      identifierValue: customerNo,
      secretValue: password,
      identifierType: "0",
      secretType: "0",
    });
    const text = await this.#send("/Login/Login", { method: "POST", body }, false);
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new IbsError("Login lieferte kein JSON");
    }
    if (obj.errorMessage) throw new IbsAuthError(obj.errorMessage);
    if (!obj.token) throw new IbsError("Login-Antwort enthielt kein Token");
    this.token = obj.token;
    return new Profile(obj.name1 || "", obj.institutionName1 || "");
  }

  weekplan(year, week) {
    const q = year != null && week != null ? `?year=${year}&week=${week}` : "";
    return this.#send(`/Mealplan/Weekplan${q}`, { method: "GET" });
  }

  /** Tagesansicht der Mobilseite für einen Tag. */
  dayplan(date) {
    return this.#send(`/Mealplan/WeekplanMobile?date=${date}`, { method: "GET" });
  }

  async cart() {
    return CartResponse.from(this.#json(await this.#send("/Mealplan/UpdateBalanceAndCart", { method: "GET" })));
  }

  /** Typ I = neu bestellen; bestellt ist erst mit submitCart(). */
  addToCart(entry) { return this.#saveOrder(entry, 1, "I"); }

  /** Typ D, Menge −1 = Abbestellung in den Warenkorb. */
  cancelInCart(entry) { return this.#saveOrder(entry, -1, "D"); }

  #saveOrder(entry, quantity, type) {
    return this.#postJson("/Mealplan/SaveOrder", {
      mealOrderQuantity: {
        CustomerId: entry.customerId,
        ServeDate: entry.date,
        MenuGroupId: entry.menuGroupId,
        MenuLineId: entry.menuLineId,
        QuantityInShoppingCart: quantity,
        ShoppingCartOrderType: type,
      },
    });
  }

  clearCart(customerId, date, menuGroupId) {
    return this.#postJson("/Mealplan/ClearCart", {
      mealOrderQuantity: { CustomerId: customerId, ServeDate: date, MenuGroupId: menuGroupId },
    });
  }

  /** Schickt den GESAMTEN Warenkorb ab — OrderPlacer prüft vorher dessen Inhalt. */
  submitCart() { return this.#postJson("/Cart/Order", null); }

  async #postJson(path, payload) {
    const text = await this.#send(path, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return CartResponse.from(this.#json(text, path));
  }

  #json(text, what = "Antwort") {
    try {
      return JSON.parse(text);
    } catch {
      throw new IbsError(`${what} lieferte kein JSON`);
    }
  }

  async #send(path, init, auth = true) {
    // Ausdrücklich gesetzt: Anfragen aus dem Service Worker tragen es sonst nicht immer.
    const headers = { "Accept-Language": "de-DE,de;q=0.9", ...(init.headers || {}) };
    if (auth) {
      if (!this.token) throw new IbsAuthError("Nicht eingeloggt");
      headers.Authorization = `Bearer ${this.token}`;
      headers["X-Requested-With"] = "XMLHttpRequest";
    }
    await this.hooks.before?.();
    let resp;
    try {
      resp = await fetch(this.base + path, {
        ...init,
        headers,
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
      });
    } catch (e) {
      await this.hooks.failed?.({ path, network: true });
      const err = new IbsError(`Keine Verbindung zum Bestellsystem (${path}): ${e.message}`);
      err.maybeAuth = auth;
      throw err;
    }
    if (!resp.ok && resp.type !== "opaqueredirect") await this.hooks.failed?.({ path, status: resp.status });
    if (resp.type === "opaqueredirect" || resp.status === 401 || resp.status === 403) {
      throw new IbsAuthError(`${path}: Anmeldung abgelaufen oder abgelehnt`);
    }
    if (!resp.ok) throw new IbsError(`${path}: HTTP ${resp.status}`);
    return resp.text();
  }
}

/** Mealplan-Endpunkte antworten in camelCase, Cart/Order in PascalCase. */
export class CartResponse {
  constructor(ok, message, totalItemsInCart) {
    Object.assign(this, { ok, message, totalItemsInCart });
  }
  static from(obj) {
    const field = (n) => {
      const v = obj?.[n] ?? obj?.[n[0].toUpperCase() + n.slice(1)];
      return v == null || v === "" ? null : String(v);
    };
    const status = field("messageStatus");
    const total = field("totalItemsInCart");
    return new CartResponse(
      status == null || status.toUpperCase() === "OK",
      field("message"),
      total == null || Number.isNaN(parseInt(total, 10)) ? null : parseInt(total, 10),
    );
  }
}

export class Profile {
  constructor(name, institution) {
    Object.assign(this, { name, institution });
  }
  /** IBS5 liefert "Nachname, Vorname"; lieber leer als falsch. */
  get firstName() {
    const n = this.name.trim();
    if (n.includes(",")) return n.slice(n.indexOf(",") + 1).trim();
    return n ? n.split(/\s+/).pop() : "";
  }
}

// ---------------------------------------------------------------- Parser

export const OrderState = Object.freeze({
  ORDERED: "ORDERED",
  IN_CART: "IN_CART",
  NOT_ORDERED: "NOT_ORDERED",
  DEADLINE_PASSED: "DEADLINE_PASSED",
  NO_OFFER: "NO_OFFER",
  UNKNOWN: "UNKNOWN",
});

export const STATE_LABEL = {
  ORDERED: "bestellt",
  IN_CART: "nur im Warenkorb — nicht abgeschickt",
  NOT_ORDERED: "nicht bestellt (noch bestellbar)",
  DEADLINE_PASSED: "nicht bestellt, Bestellschluss vorbei",
  NO_OFFER: "kein Angebot",
  UNKNOWN: "unklar",
};

const STATUS_ORDERED = "2";
const STATUS_NOT_ORDERED = "0";

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß",
  eacute: "é", egrave: "è", agrave: "à", ndash: "–", mdash: "—",
};
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });

// Ein Start-Tag mit Attributen; Anführungszeichen dürfen ">" enthalten.
const TAG = /<([a-zA-Z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
const ATTR = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attributes(src) {
  const out = new Map();
  for (const m of src.matchAll(ATTR)) {
    out.set(m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

const ID_FULL = /^menu_quantity_(?:mobile-)?(\d{4}-\d{2}-\d{2})_(\d+)_(\d+)$/;
const ID_DATE = /[_-](\d{4}-\d{2}-\d{2})_/;
const DE_DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
// Kundennummer: Wochenplan clickMenuCheckbox(…) 6. Argument, Tagesansicht changeItemQuantity(…) 4. Argument.
const ONCLICK = [
  { re: /clickMenuCheckbox\(([^)]*)\)/, index: 5 },
  { re: /changeItemQuantity\(([^)]*)\)/, index: 3 },
];
/** Die Regel aus dem Seiten-JS von IBS5 (M5/KV-SPERRLOGIK). */
const KV_NAME = /M5|KALTVERPFLEGUNG|\bKV\b/i;

function customerIdFrom(onclick) {
  for (const { re, index } of ONCLICK) {
    const args = re.exec(onclick)?.[1];
    if (args) return (args.split(",")[index] || "").trim().replace(/^'+|'+$/g, "");
  }
  return "";
}

export class MenuEntry {
  constructor(f) {
    Object.assign(this, f);
  }
  /**
   * Kaltverpflegung ist nie wählbar: der Wochenplan liefert sie readonly und ohne
   * onclick, die Tagesansicht sperrt sie nur im Seiten-JS — daher zusätzlich isKv.
   */
  get selectable() {
    return this.orderable && !this.isKv && !!this.customerId && !!this.menuGroupId && !!this.menuLineId;
  }
  get isOrdered() { return this.status === STATUS_ORDERED || this.quantityOrdered !== ""; }
  get isUnderstood() { return this.status === STATUS_ORDERED || this.status === STATUS_NOT_ORDERED; }
}

export class DayStatus {
  constructor(date, state, entries = []) {
    this.date = date;
    this.state = state;
    this.entries = entries;
  }
  get orderedItems() { return this.entries.filter((e) => e.isOrdered).map((e) => e.name); }
  get orderable() { return this.entries.some((e) => e.orderable); }
  get isActionable() { return this.state === OrderState.NOT_ORDERED || this.state === OrderState.IN_CART; }
  get label() { return STATE_LABEL[this.state]; }
}

function dayState(entries) {
  if (entries.some((e) => e.isOrdered)) return OrderState.ORDERED;
  if (entries.some((e) => e.quantityInCart !== "")) return OrderState.IN_CART;
  if (!entries.every((e) => e.isUnderstood)) return OrderState.UNKNOWN;
  if (entries.some((e) => e.orderable)) return OrderState.NOT_ORDERED;
  return OrderState.DEADLINE_PASSED;
}

/**
 * Wochenplan oder Tagesansicht in Tage zerlegen.
 * @returns {{days: Map<string, DayStatus>, displayedWeek: number|null, view: "week"|"day"}}
 */
export function parseWeekplan(html) {
  // Anker am Container: eine Ferienwoche ist legitim leer, eine Fehlerseite nie ein Plan.
  const view = /\bid\s*=\s*["']?weekplan["'\s>]/.test(html) ? "week"
    : /\bid\s*=\s*["']?dayplan["'\s>]/.test(html) ? "day" : null;
  if (!view) {
    throw new ParserError("Antwort enthält keinen Wochenplan — vermutlich eine Fehler- oder Login-Seite.");
  }
  const text = decode(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " "));
  const kw = /\bKW\s*(\d{1,2})\b/.exec(text);

  const byDate = new Map();
  for (const m of html.matchAll(TAG)) {
    if (!/data-order-status/i.test(m[2])) continue;
    const a = attributes(m[2]);
    if (!a.has("data-order-status")) continue;
    const id = a.get("id") || "";
    let date = ID_DATE.exec(id)?.[1];
    if (!date) {
      const d = DE_DATE.exec((a.get("data-date") || "").trim());
      if (d) date = `${d[3]}-${d[2]}-${d[1]}`;
    }
    if (!date) continue;
    const full = ID_FULL.exec(id);
    const name = (a.get("data-name") || "").trim();
    const entry = new MenuEntry({
      date,
      name,
      status: (a.get("data-order-status") || "").trim(),
      quantityOrdered: (a.get("data-quantity-ordered") || "").trim(),
      quantityInCart: (a.get("data-quantity-in-shopping-cart") || "").trim(),
      // Wochenplan: Attribut readonly; Tagesansicht: data-readonly="true".
      orderable: !a.has("readonly") && (a.get("data-readonly") || "").trim() !== "true",
      isKv: KV_NAME.test(name),
      menuGroupId: full?.[2] || "",
      menuLineId: full?.[3] || "",
      customerId: customerIdFrom(a.get("onclick") || ""),
    });
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(entry);
  }

  const days = new Map();
  for (const [date, entries] of byDate) days.set(date, new DayStatus(date, dayState(entries), entries));
  return { days, displayedWeek: view === "week" && kw ? parseInt(kw[1], 10) : null, view };
}

// ---------------------------------------------------------------- Prüfung

export const DEFAULT_CHECK = Object.freeze({ daysAhead: 9, weekdays: [1, 2, 3, 4, 5], includeToday: false });

export function targetDates(today, cfg = DEFAULT_CHECK) {
  const out = [];
  for (let i = cfg.includeToday ? 0 : 1; i <= cfg.daysAhead; i++) {
    const d = addDays(today, i);
    if (cfg.weekdays.includes(weekdayNo(d))) out.push(d);
  }
  return out;
}

/**
 * Jede betroffene Kalenderwoche einmal laden; Login muss vorher erfolgt sein.
 * Liefert IBS5 statt der Woche eine Tagesansicht (Handy), wird je Tag geladen.
 */
export async function collect(client, dates, { fresh = false, onProgress } = {}) {
  if (client.dayView) return collectByDay(client, dates, fresh, onProgress);
  const weeks = new Map();
  for (const d of dates) {
    const [y, w] = isoWeek(d);
    const key = `${y}-${String(w).padStart(2, "0")}`;
    if (!weeks.has(key)) weeks.set(key, { y, w, dates: [] });
    weeks.get(key).dates.push(d);
  }
  const result = [];
  for (const key of [...weeks.keys()].sort()) {
    const { y, w, dates: ds } = weeks.get(key);
    const plan = parseWeekplan(await client.weekplan(y, w));
    if (plan.view === "day") {
      client.dayView = true;
      return collectByDay(client, dates, fresh, onProgress);
    }
    if (plan.displayedWeek != null && plan.displayedWeek !== w) {
      throw new IbsError(`Angefragt war KW ${w}, geliefert wurde KW ${plan.displayedWeek}`);
    }
    for (const d of ds) result.push(plan.days.get(d) ?? new DayStatus(d, OrderState.NO_OFFER));
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

// Die Tagesansicht kostet eine Anfrage je Tag. Zu viele in kurzer Zeit quittiert
// IBS5 mit einer IP-Sperre (HTTP 406 auf alles, auch die eigene Startseite) —
// deshalb strikt nacheinander, mit Pause, und kurz zwischengespeichert.
const DAY_GAP_MS = 400;
const DAY_CACHE_MS = 3 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectByDay(client, dates, fresh, onProgress) {
  client.dayCache ??= new Map();
  const out = [];
  for (const d of dates) {
    onProgress?.(out.length, dates.length);
    const hit = client.dayCache.get(d);
    if (!fresh && hit && Date.now() - hit.at < DAY_CACHE_MS) {
      out.push(hit.day);
      continue;
    }
    // Mit etwas Zufall, damit Geräte hinter derselben IP nicht im Gleichtakt fragen.
    const gap = DAY_GAP_MS + Math.floor(Math.random() * 300);
    if (client.lastDayFetch) await sleep(Math.max(0, client.lastDayFetch + gap - Date.now()));
    client.lastDayFetch = Date.now();
    const plan = parseWeekplan(await client.dayplan(d));
    const other = [...plan.days.keys()].find((k) => k !== d);
    if (other) throw new IbsError(`Angefragt war ${De.short(d)}, geliefert wurde ${De.short(other)}`);
    const day = plan.days.get(d) ?? new DayStatus(d, OrderState.NO_OFFER);
    client.dayCache.set(d, { at: Date.now(), day });
    out.push(day);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Tage für den Speicher des Geräts, damit die Übersicht beim Öffnen sofort den letzten Stand zeigt. */
export const daysToJson = (days) => days.map((d) => ({ date: d.date, state: d.state, entries: d.entries.map((e) => ({ ...e })) }));
export const daysFromJson = (arr) => arr.map((d) => new DayStatus(d.date, d.state, d.entries.map((e) => new MenuEntry(e))));

/**
 * Ein Netzfehler ist keine Aussage über den Bestellstand: deshalb "failed" als
 * eigener Fall statt einer leeren Alarmliste.
 */
export function evaluate(days) {
  const actionable = days.filter((d) => d.isActionable);
  const tooLate = days.filter((d) => d.state === OrderState.DEADLINE_PASSED);
  const unclear = days.filter((d) => d.state === OrderState.UNKNOWN);
  const kind = actionable.length || tooLate.length || unclear.length ? "alarm" : "ok";
  return { kind, actionable, tooLate, unclear, days };
}

export const AlarmText = {
  title(alarm, firstName = "") {
    const open = alarm.actionable.length;
    const late = alarm.tooLate.length;
    const what =
      open === 1 ? "1 ausstehende Bestellung"
      : open > 1 ? `${open} ausstehende Bestellungen`
      : late === 1 ? "1 Tag ohne Essen"
      : late > 1 ? `${late} Tage ohne Essen`
      : "Bestellstatus unklar";
    return firstName ? `${what} für ${firstName}` : what;
  },
  body(alarm) {
    const parts = [];
    if (alarm.actionable.length) {
      parts.push("Bestellen ist noch möglich:\n" + alarm.actionable
        .map((d) => `  • ${De.long(d.date)}${d.state === OrderState.IN_CART ? " (liegt im Warenkorb, nicht abgeschickt!)" : ""}`)
        .join("\n"));
    }
    if (alarm.tooLate.length) {
      parts.push("Bestellschluss vorbei:\n" + alarm.tooLate.map((d) => `  • ${De.long(d.date)}`).join("\n"));
    }
    if (alarm.unclear.length) {
      parts.push("Bestellstatus unklar — bitte selbst nachsehen:\n" + alarm.unclear.map((d) => `  • ${De.long(d.date)}`).join("\n"));
    }
    return parts.join("\n\n");
  },
};

// ---------------------------------------------------------------- Bestellen

/** current = bestellte Linie oder null, target = gewünschte Linie oder null ("nichts"). */
export function changeKind(c) {
  if (!c.current && c.target) return "ORDER";
  if (c.current && !c.target) return "CANCEL";
  if (c.current && c.target && c.current.menuLineId !== c.target.menuLineId) return "SWITCH";
  return "NONE";
}

/**
 * Warenkorb füllen, prüfen, abschicken. Cart/Order schickt den ganzen Warenkorb
 * ab; weicht die Zahl der Einträge ab, liegt dort etwas Fremdes, dann wird nicht
 * abgeschickt. Umbestellen = nur neue Linie Typ I, die Abbestellung der alten
 * legt der Server selbst dazu (zwei Einträge).
 *
 * @returns {Promise<{kind:"done"|"dryrun"|"aborted"|"unconfirmed", reason?:string, missing?:string[], changes?:object[]}>}
 */
export async function placeOrders(client, requested, { dryRun = false, previouslyInCart = [], reload }) {
  const changes = requested.filter((c) => changeKind(c) !== "NONE");
  if (!changes.length) return { kind: "aborted", reason: "Nichts geändert." };
  if (new Set(changes.map((c) => c.date)).size !== changes.length) {
    return { kind: "aborted", reason: "Je Tag nur eine Änderung." };
  }
  const locked = changes.find((c) => [c.current, c.target].some((e) => e && !e.selectable));
  if (locked) return { kind: "aborted", reason: `${De.short(locked.date)}: nicht mehr änderbar.` };

  const touched = [];
  const rollback = async () => {
    for (const e of touched) await client.clearCart(e.customerId, e.date, e.menuGroupId).catch(() => {});
    for (const old of previouslyInCart.filter((o) => touched.some((t) => t.date === o.date))) {
      await client.addToCart(old).catch(() => {});
    }
  };

  try {
    let total = null;
    for (const c of changes) {
      const anchor = c.target ?? c.current;
      touched.push(anchor);
      await client.clearCart(anchor.customerId, anchor.date, anchor.menuGroupId);
      const added = changeKind(c) === "CANCEL" ? await client.cancelInCart(c.current) : await client.addToCart(c.target);
      if (!added.ok) {
        await rollback();
        return { kind: "aborted", reason: `${De.short(c.date)}: ${added.message || "vom Bestellsystem abgelehnt"}` };
      }
      total = added.totalItemsInCart;
    }
    const expected = changes.reduce((n, c) => n + (changeKind(c) === "SWITCH" ? 2 : 1), 0);
    if (total !== expected) {
      await rollback();
      return {
        kind: "aborted",
        reason: `Im Warenkorb liegen ${total ?? "?"} statt ${expected} Einträge — vermutlich noch etwas anderes. Nichts abgeschickt.`,
      };
    }
    if (dryRun) {
      await rollback();
      return { kind: "dryrun", changes };
    }
    const sent = await client.submitCart();
    if (!sent.ok) {
      await rollback();
      return { kind: "aborted", reason: sent.message || "Bestellung abgelehnt." };
    }
  } catch (e) {
    await rollback();
    return { kind: "aborted", reason: e.message };
  }

  const dates = changes.map((c) => c.date);
  let after;
  try {
    after = await reload(dates);
  } catch (e) {
    return { kind: "unconfirmed", reason: `Nachprüfung fehlgeschlagen: ${e.message}`, missing: dates };
  }
  const asRequested = (c) => {
    // Eine Linie mit liegengebliebener Abbestellung (Status 3) gilt weiter als bestellt.
    const ordered = (after.find((d) => d.date === c.date)?.entries || []).filter((e) => e.isOrdered);
    return c.target ? ordered.length === 1 && ordered[0].menuLineId === c.target.menuLineId : ordered.length === 0;
  };
  const missing = changes.filter((c) => !asRequested(c)).map((c) => c.date);
  return missing.length
    ? { kind: "unconfirmed", reason: "Nicht alle Tage stehen so im Wochenplan wie gewünscht.", missing }
    : { kind: "done", changes };
}
