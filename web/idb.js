// Kleiner Schlüssel-Wert-Speicher in IndexedDB. Seite und Service Worker teilen
// ihn: der Service Worker braucht bei der Push-Prüfung Zugangsdaten und
// Einstellungen, an localStorage kommt er nicht heran.
// Interner Name aus der Zeit vor der Umbenennung; ein neuer Name hieße neue, leere Datenbank.
const DB = "happy-sunshine";
const STORE = "kv";

let opening = null;
// Nach „Alles löschen“ darf diese Seite nichts mehr ablegen, auch nicht aus noch laufenden Abfragen.
let frozen = false;
/**
 * Verbindung öffnen bzw. die offene liefern. Geht sie verloren (iOS trennt sie
 * gelegentlich, ein anderer Kontext will eine neue Version), wird sie verworfen
 * und beim nächsten Zugriff neu geöffnet. Scheitert schon das Öffnen, trägt der
 * Fehler noIdb: dann gibt es hier keine IndexedDB (privater Modus). Ausgenommen
 * ist UnknownError: so meldet iOS auch beim Öffnen die verlorene Verbindung.
 */
function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { if (opening === mine) opening = null; };
      db.onversionchange = () => { db.close(); if (opening === mine) opening = null; };
      resolve(db);
    };
    req.onerror = () => {
      if (opening === mine) opening = null;
      const e = req.error || new Error("IndexedDB nicht verfügbar");
      reject(Object.assign(e, { noIdb: e.name !== "UnknownError" }));
    };
  }).catch((e) => {
    // indexedDB.open selbst kann werfen (z. B. kein indexedDB im Kontext).
    if (opening === mine) opening = null;
    const err = e instanceof Error ? e : new Error(String(e));
    throw Object.assign(err, { noIdb: err.noIdb ?? err.name !== "UnknownError" });
  });
  const mine = opening;
  return opening;
}

// Fehler, nach denen die Verbindung nicht mehr taugt: geschlossen bzw. iOS
// („Connection to Indexed Database server lost“).
const lost = (e) => e?.name === "InvalidStateError" || e?.name === "UnknownError";

/**
 * Eine Transaktion auf dem Speicher. build(store) stellt die Anfragen und
 * liefert eine Funktion für das Ergebnis nach dem Abschluss. Ist die Verbindung
 * verloren, wird sie verworfen und die Transaktion einmal auf einer neuen
 * wiederholt (eine abgebrochene Transaktion hat nichts geschrieben).
 */
function transact(mode, build, retry = true) {
  const conn = open();
  return conn.then((db) => new Promise((resolve, reject) => {
    // Wirft InvalidStateError, wenn die Verbindung schon geschlossen ist.
    const tx = db.transaction(STORE, mode);
    const done = build(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(done());
    // tx.error ist beim error-Event der Anfrage noch leer, erst beim Abbruch gesetzt.
    tx.onerror = (e) => reject(e.target?.error || tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB-Transaktion abgebrochen"));
  }).catch((e) => {
    if (!lost(e)) throw e;
    if (opening === conn) {
      opening = null;
      try { db.close(); } catch { /* schon zu */ }
    }
    if (!retry) throw e;
    return transact(mode, build, false);
  }), (e) => (retry && !e?.noIdb && lost(e) ? transact(mode, build, false) : Promise.reject(e)));
}

function run(mode, fn) {
  return transact(mode, (s) => {
    const req = fn(s);
    return () => req?.result;
  });
}

/**
 * Strenges Lesen: undefined nur, wenn IndexedDB fehlt (privater Modus) oder der
 * Schlüssel unbekannt ist. Eine kaputte Verbindung ist ein Fehler, sonst sähe sie
 * aus wie ein leerer Speicher (etwa „nicht angemeldet“).
 */
export const kvRead = (key) => run("readonly", (s) => s.get(key)).catch((e) => {
  if (e?.noIdb) return undefined;
  throw e;
});
/** Nachsichtiges Lesen für Einstellungen und Zwischenspeicher: jeder Fehler ergibt undefined. */
export const kvGet = (key) => run("readonly", (s) => s.get(key)).catch(() => undefined);
export const kvSet = (key, value) => (frozen ? Promise.resolve() : run("readwrite", (s) => s.put(value, key)));
export const kvDel = (key) => run("readwrite", (s) => s.delete(key)).catch(() => {});
/**
 * Lesen, ändern, schreiben in einer Transaktion: Seite und Service Worker können
 * sich dabei nicht gegenseitig überschreiben. fn(alt) liefert { value?, result? };
 * ohne value wird nichts geschrieben, result ist der Rückgabewert.
 */
export function kvUpdate(key, fn) {
  return transact(frozen ? "readonly" : "readwrite", (s) => {
    let out;
    const req = s.get(key);
    req.onsuccess = () => {
      const { value, result } = fn(req.result) || {};
      out = result;
      if (value !== undefined && !frozen) s.put(value, key);
    };
    return () => out;
  });
}
/** Leert den ganzen Speicher dieser Seite, auch den Schlüssel der Verschlüsselung. */
export const kvClear = () => run("readwrite", (s) => s.clear());
/** Ab jetzt schreibt dieser Kontext nichts mehr (Abmelden; die Seite lädt danach neu). */
export const freezeWrites = () => { frozen = true; };
/** Nur für Tests: Verbindung schließen, ohne sie zu verwerfen — wie eine, die iOS verloren hat. */
export const closeConnection = async () => (await opening?.catch(() => null))?.close();

// ---------------------------------------------------------------- verschlüsselt
//
// Zugangsdaten liegen AES-GCM-verschlüsselt. Der Schlüssel wird im Browser
// erzeugt und als nicht exportierbarer CryptoKey in derselben Datenbank
// abgelegt: Seite und Service Worker können damit entschlüsseln, eine kopierte
// Speicherdatei (z. B. aus einem Backup) gibt ohne den Browser nichts preis.
// Gegen Zugriff auf das entsperrte Gerät hilft das nicht.

const KEY = "cryptoKey";

/**
 * Schlüssel lesen oder einmalig anlegen. Seite und Service Worker können das
 * gleichzeitig tun: add() statt put(), der Verlierer nimmt den Schlüssel des
 * Gewinners — sonst wäre, was der andere damit verschlüsselt hat, verloren.
 * Ein Lesefehler legt keinen neuen Schlüssel an.
 */
async function key() {
  const k = await run("readonly", (s) => s.get(KEY));
  if (k) return k;
  if (frozen) throw new Error("Speicher gelöscht");
  const fresh = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  try {
    await run("readwrite", (s) => s.add(fresh, KEY));
    return fresh;
  } catch (e) {
    if (e?.name !== "ConstraintError") throw e;
    return run("readonly", (s) => s.get(KEY));
  }
}

export async function secretSet(name, value) {
  if (frozen) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(), data);
  await kvSet(name, { enc: 1, iv, ct: new Uint8Array(ct) });
}

/**
 * Liest einen verschlüsselten Eintrag; ein älterer Klartext-Eintrag wird dabei
 * verschlüsselt. Ein Fehler des Speichers wird geworfen, nicht als „leer“ gemeldet.
 */
export async function secretGet(name) {
  const rec = await kvRead(name);
  if (!rec) return undefined;
  if (rec.enc !== 1) {
    await secretSet(name, rec);
    return rec;
  }
  const k = await key();
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, k, rec.ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return undefined; // Schlüssel verloren (Website-Daten teilweise gelöscht): neu anmelden.
  }
}
