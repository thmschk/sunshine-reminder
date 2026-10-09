// IBS5-Token über Seitenaufrufe und Weckrufe hinweg behalten: spart je Vorgang
// den Login. Wie lange ein Token gilt, sagt IBS5 nicht; abgelaufen zeigt er sich
// als Auth- oder Netzfehler (siehe IbsClient#send), dann wird einmal neu
// angemeldet. Gespeichert wird verschlüsselt wie die Zugangsdaten, je
// Kundennummer, und nur, wenn diese selbst gespeichert sind.

import { IbsAuthError, Profile } from "./ibs.js";
import { kvDel, secretGet, secretSet } from "./idb.js";
import { loadAccounts } from "./accounts.js";

const KEY = "ibsSession";
const keyOf = (customerNo) => `${KEY}:${customerNo}`;

async function loadSaved(customerNo) {
  const saved = await secretGet(keyOf(customerNo)).catch(() => undefined);
  if (saved) return saved;
  // Eintrag aus der Zeit mit nur einem Konto übernehmen.
  const old = await secretGet(KEY).catch(() => undefined);
  if (old?.customerNo !== customerNo) return undefined;
  await secretSet(keyOf(customerNo), old).catch(() => {});
  await kvDel(KEY);
  return old;
}

/** Anmelden; client.token bleibt bei Ablehnung leer (daran erkennt die Seite falsche Zugangsdaten). */
export async function login(client, creds, persist) {
  client.token = null;
  client.profile = await client.login(creds.customerNo, creds.password);
  client.customerNo = creds.customerNo;
  // Nur für ein Konto, das noch gespeichert ist: ein Weckruf kann ein inzwischen
  // entferntes Kind (oder „Alles löschen“) überdauern.
  if (persist && (await loadAccounts()).some((a) => a.customerNo === creds.customerNo)) {
    const { name, institution } = client.profile;
    await secretSet(keyOf(creds.customerNo), { customerNo: creds.customerNo, token: client.token, name, institution }).catch(() => {});
  }
}

/** fn mit gültigem Token ausführen: gespeicherten nehmen, sonst anmelden; bei Ablauf einmal neu. */
export async function withSession(client, creds, fn, { persist = true } = {}) {
  if (client.customerNo !== creds.customerNo) {
    client.token = null;
    client.profile = null;
    client.customerNo = null;
    const saved = persist ? await loadSaved(creds.customerNo) : undefined;
    if (saved?.token && saved.customerNo === creds.customerNo) {
      client.token = saved.token;
      client.profile = new Profile(saved.name || "", saved.institution || "");
      client.customerNo = creds.customerNo;
    }
  }
  if (!client.token) await login(client, creds, persist);
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof IbsAuthError || e.maybeAuth)) throw e;
    await login(client, creds, persist);
    return fn();
  }
}
