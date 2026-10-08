// IBS5-Konten auf diesem Gerät: je Kind eine Kundennummer mit Passwort,
// verschlüsselt wie zuvor die einzelnen Zugangsdaten. Seite und Service Worker
// lesen beide über loadAccounts(), damit ein frisch geladener Service Worker
// auch dann die Konten findet, wenn die Seite seit dem Update nicht offen war.
// Was je Konto zwischengespeichert wird, trägt die Kundennummer im Schlüssel.

import { Profile } from "./ibs.js";
import { kvDel, kvGet, kvSet, secretGet, secretSet } from "./idb.js";

const KEY = "accounts";
const LEGACY = "creds";
const ACTIVE = "activeAccount";

/** Schlüssel eines Zwischenspeichers je Konto, z. B. dayCache:12345. */
export const accountKey = (base, customerNo) => `${base}:${customerNo}`;
/** Diese Schlüssel gehören je einem Konto; „Kind entfernen“ löscht sie. */
const PER_ACCOUNT = ["ibsSession", "dayCache", "lastDays"];

const valid = (a) => !!(a?.customerNo && a?.password);

/** Gespeicherte Konten; der einzelne Eintrag aus der Zeit vor mehreren Kindern wird dabei übernommen. */
export async function loadAccounts() {
  const list = await secretGet(KEY).catch(() => undefined);
  if (Array.isArray(list)) return list.filter(valid);
  const old = await secretGet(LEGACY).catch(() => undefined);
  if (!valid(old)) return [];
  const migrated = [{ customerNo: old.customerNo, password: old.password, name: "" }];
  await secretSet(KEY, migrated);
  await kvDel(LEGACY);
  return migrated;
}

export const saveAccounts = (list) => secretSet(KEY, list);

/** Neues Konto anhängen oder ein vorhandenes mit derselben Kundennummer ersetzen. */
export async function upsertAccount(account) {
  const list = await loadAccounts();
  const i = list.findIndex((a) => a.customerNo === account.customerNo);
  if (i >= 0) list[i] = { ...list[i], ...account };
  else list.push(account);
  await saveAccounts(list);
  return list;
}

/** Konto samt seiner Zwischenspeicher und nur ihm zugeordneter Termine löschen. */
export async function removeAccount(customerNo) {
  const list = (await loadAccounts()).filter((a) => a.customerNo !== customerNo);
  await saveAccounts(list);
  for (const base of PER_ACCOUNT) await kvDel(accountKey(base, customerNo));
  const events = (await kvGet("events")) || [];
  await kvSet("events", events.filter((e) => e.who !== customerNo));
  const notified = (await kvGet("notified")) || [];
  await kvSet("notified", notified.filter((k) => !k.includes(`:${customerNo}:`)));
  if ((await kvGet(ACTIVE)) === customerNo) await kvDel(ACTIVE);
  return list;
}

export const loadActive = () => kvGet(ACTIVE);
export const saveActive = (customerNo) => kvSet(ACTIVE, customerNo).catch(() => {});

/** Vorname für Reiter und Meldungen; ohne bekannten Namen die Kundennummer. */
export const accountLabel = (a) => new Profile(a?.name || "", "").firstName || `Kd. ${a?.customerNo || ""}`;

/**
 * Tages-Zwischenspeicher (siehe dayCache in ibs.js) je Kundennummer. Gelesen
 * wird beim Kontowechsel, wenn withSession client.customerNo schon gesetzt hat;
 * der Eintrag aus der Zeit mit einem Konto gilt, solange die Kundennummer passt.
 */
export const dayStore = (client) => ({
  load: async () => (await kvGet(accountKey("dayCache", client.customerNo))) ?? kvGet("dayCache"),
  save: (rows) => kvSet(accountKey("dayCache", rows.customerNo), rows),
});
