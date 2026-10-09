// Kleiner Schlüssel-Wert-Speicher in IndexedDB. Seite und Service Worker teilen
// ihn: der Service Worker braucht bei der Push-Prüfung Zugangsdaten und
// Einstellungen, an localStorage kommt er nicht heran.
// Interner Name aus der Zeit vor der Umbenennung; ein neuer Name hieße neue, leere Datenbank.
const DB = "happy-sunshine";
const STORE = "kv";

let opening = null;
// Nach „Alles löschen“ darf diese Seite nichts mehr ablegen, auch nicht aus noch laufenden Abfragen.
let frozen = false;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    // tx.error ist beim error-Event der Anfrage noch leer, erst beim Abbruch gesetzt.
    tx.onerror = (e) => reject(e.target?.error || tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB-Transaktion abgebrochen"));
  }));
}

/** Liefert undefined, wenn IndexedDB fehlt (privater Modus) oder der Schlüssel unbekannt ist. */
export const kvGet = (key) => run("readonly", (s) => s.get(key)).catch(() => undefined);
export const kvSet = (key, value) => (frozen ? Promise.resolve() : run("readwrite", (s) => s.put(value, key)));
export const kvDel = (key) => run("readwrite", (s) => s.delete(key)).catch(() => {});
/**
 * Lesen, ändern, schreiben in einer Transaktion: Seite und Service Worker können
 * sich dabei nicht gegenseitig überschreiben. fn(alt) liefert { value?, result? };
 * ohne value wird nichts geschrieben, result ist der Rückgabewert.
 */
export function kvUpdate(key, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, frozen ? "readonly" : "readwrite");
    const s = tx.objectStore(STORE);
    let out;
    const req = s.get(key);
    req.onsuccess = () => {
      const { value, result } = fn(req.result) || {};
      out = result;
      if (value !== undefined && !frozen) s.put(value, key);
    };
    tx.oncomplete = () => resolve(out);
    tx.onerror = (e) => reject(e.target?.error || tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB-Transaktion abgebrochen"));
  }));
}
/** Leert den ganzen Speicher dieser Seite, auch den Schlüssel der Verschlüsselung. */
export const kvClear = () => run("readwrite", (s) => s.clear());
/** Ab jetzt schreibt dieser Kontext nichts mehr (Abmelden; die Seite lädt danach neu). */
export const freezeWrites = () => { frozen = true; };

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

/** Liest einen verschlüsselten Eintrag; ein älterer Klartext-Eintrag wird dabei verschlüsselt. */
export async function secretGet(name) {
  const rec = await kvGet(name);
  if (!rec) return undefined;
  if (rec.enc !== 1) {
    await secretSet(name, rec);
    return rec;
  }
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, await key(), rec.ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return undefined; // Schlüssel verloren (Website-Daten teilweise gelöscht): neu anmelden.
  }
}
