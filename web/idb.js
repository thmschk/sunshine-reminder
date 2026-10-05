// Kleiner Schlüssel-Wert-Speicher in IndexedDB. Seite und Service Worker teilen
// ihn: der Service Worker braucht bei der Push-Prüfung Zugangsdaten und
// Einstellungen, an localStorage kommt er nicht heran.
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
