// Kleiner Schlüssel-Wert-Speicher in IndexedDB. Seite und Service Worker teilen
// ihn: der Service Worker braucht bei der Push-Prüfung Zugangsdaten und
// Einstellungen, an localStorage kommt er nicht heran.
// Interner Name aus der Zeit vor der Umbenennung; ein neuer Name hieße neue, leere Datenbank.
const DB = "happy-sunshine";
const STORE = "kv";

let opening = null;
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
    tx.onerror = () => reject(tx.error);
  }));
}

/** Liefert undefined, wenn IndexedDB fehlt (privater Modus) oder der Schlüssel unbekannt ist. */
export const kvGet = (key) => run("readonly", (s) => s.get(key)).catch(() => undefined);
export const kvSet = (key, value) => run("readwrite", (s) => s.put(value, key));
export const kvDel = (key) => run("readwrite", (s) => s.delete(key)).catch(() => {});
/** Leert den ganzen Speicher dieser Seite, auch den Schlüssel der Verschlüsselung. */
export const kvClear = () => run("readwrite", (s) => s.clear());

// ---------------------------------------------------------------- verschlüsselt
//
// Zugangsdaten liegen AES-GCM-verschlüsselt. Der Schlüssel wird im Browser
// erzeugt und als nicht exportierbarer CryptoKey in derselben Datenbank
// abgelegt: Seite und Service Worker können damit entschlüsseln, eine kopierte
// Speicherdatei (z. B. aus einem Backup) gibt ohne den Browser nichts preis.
// Gegen Zugriff auf das entsperrte Gerät hilft das nicht.

const KEY = "cryptoKey";

async function key() {
  let k = await kvGet(KEY);
  if (!k) {
    k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await kvSet(KEY, k);
  }
  return k;
}

export async function secretSet(name, value) {
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
