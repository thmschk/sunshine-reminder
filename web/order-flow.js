// Ablauf einer Bestellung ohne Oberfläche: Warenkorb ansehen, Rückfrage, Budget,
// placeOrders bzw. Warenkorb abschicken oder verwerfen. Die Bestellansicht (app.js)
// gibt Anmeldung, Rückfrage und Fortschritt als Callbacks herein und zeigt das Ergebnis.
import { De, cartOthers, changeKind, collect, placeOrders, submitCartAsSeen } from "./ibs.js";
import { budgetFor, unmetered } from "./guard.js";

// Anfragen einer Bestellung höchstens, CORS-Vorabfragen mitgezählt: je Tag Vorab-Laden,
// Leeren, Hinzufügen und Nachladen, dazu Warenkorb-Zahl, Abschicken, Bestellhistorie
// und vielleicht ein Login. Meist sind es weniger (placeOrders).
export const orderCost = (changes) => 8 * changes.length + 8;
/** Vor dem Bestellen gilt ein geladener Tag so lange als aktuell: die Bestellansicht hat ihn meist gerade geladen. */
export const ORDER_PRELOAD_MAX_AGE_MS = 2 * 60 * 1000;
/** Anfragen, um den Warenkorb zu verwerfen (Verwerfen, danach die Zahl). */
const DISCARD_COST = 4;

/**
 * Laden für placeOrders bzw. submitCartAsSeen: reload frisch, preload höchstens
 * ORDER_PRELOAD_MAX_AGE_MS alt, verify über die Bestellhistorie. schoolDay wie bei collect.
 */
export const loaders = (c, schoolDay, load = collect) => ({
  reload: (ds) => load(c, ds, { fresh: true, schoolDay }),
  preload: (ds) => load(c, ds, { maxAgeMs: ORDER_PRELOAD_MAX_AGE_MS, schoolDay }),
  verify: (ds) => load(c, ds, { fresh: true, history: true, schoolDay }),
});

/**
 * Auswahl abschicken. Abgeschickt wird immer der ganze Warenkorb: erst nachsehen,
 * was sonst darin liegt (cartOthers), dann fragen.
 *
 * changes: [{date, current, target}] (nur Abweichungen); days: alle geladenen Tage
 * (was dort schon im Warenkorb lag, legt ein Abbruch zurück, siehe placeOrders).
 * withClient(fn): fn(client) angemeldet ausführen. ask(changes, cart): Rückfrage mit
 * cart = {total, others}; false (Abbruch), "mine", "discard" (Warenkorb vorher
 * verwerfen) oder "all" (die gesehenen fremden Einträge gehen mit ab).
 * onBusy(bool): eine Anfrage läuft. budget/load: nur für Tests ersetzt.
 *
 * @returns {Promise<{kind:"cancelled"} | {kind:"aborted", reason:string, step:"cart"}
 *   | (Ergebnis von placeOrders & {othersInCart:number})>} step "cart": der Warenkorb
 *   war nicht lesbar, gefragt und angefasst wurde nichts.
 */
export async function submitOrder(changes, {
  days, withClient, ask, onBusy = () => {}, schoolDay, budget = budgetFor, load = collect,
}) {
  onBusy(true);
  const cart = await withClient((c) => cartOthers(c, changes.map((x) => x.date))).catch((e) => ({ error: e }));
  onBusy(false);
  if (cart.error) return { kind: "aborted", reason: cart.error.message, step: "cart" };
  const choice = await ask(changes, cart);
  if (!choice) return { kind: "cancelled" };
  const discard = choice === "discard";

  onBusy(true);
  // Neu- wie Abbestellungen (Menge 1 bzw. −1): ein Abbruch legt sie wieder in den Warenkorb.
  const previouslyInCart = discard ? [] : days.flatMap((d) => d.entries.filter((e) => e.quantityInCart !== "" && e.selectable));
  const othersInCart = choice === "all" ? cart.others.length : 0;
  // Mit halb gefülltem Warenkorb darf die Stundenbremse nicht greifen: vorher prüfen, ob alles passt.
  const outcome = await budget(orderCost(changes) + (discard ? DISCARD_COST : 0))
    .then(() => withClient((c) => unmetered(c, () =>
      placeOrders(c, changes, { previouslyInCart, othersInCart, discard, ...loaders(c, schoolDay, load) }))))
    .catch((e) => ({ kind: "aborted", reason: e.message }));
  onBusy(false);
  return { ...outcome, othersInCart };
}

/**
 * Den Warenkorb von IBS5 so, wie der Nutzer ihn gesehen hat (cartOthers), abschicken
 * (send) oder verwerfen, ohne eigene Auswahl. Die Rückfrage stellt der Aufrufer vorher.
 * @returns {Promise<{kind:"done"|"aborted"|"unconfirmed", reason?:string, missing?:string[], network?:boolean}>}
 */
export async function submitCart(send, seen, { withClient, schoolDay, budget = budgetFor, load = collect }) {
  const discard = async (c) => {
    await c.discardCart();
    const left = (await c.cart()).totalItemsInCart;
    return left === 0 ? { kind: "done" }
      : { kind: "aborted", reason: `Danach liegen noch ${left ?? "?"} Einträge im Warenkorb — bitte auf der Bestellseite nachsehen.` };
  };
  return budget(send ? 8 + 2 * seen.others.length : DISCARD_COST)
    .then(() => withClient((c) => unmetered(c, () => (send
      ? submitCartAsSeen(c, seen.others, { reload: loaders(c, schoolDay, load).reload })
      : discard(c)))))
    .catch((e) => ({ kind: "aborted", reason: e.message }));
}

/** Text einer Änderung für die Rückfrage. */
export const describeChange = (c) => {
  const day = De.chip(c.date);
  return { ORDER: `${day} bestellen: ${c.target?.name}`, SWITCH: `${day} umbestellen auf: ${c.target?.name}`,
    CANCEL: `${day} abbestellen: ${c.current?.name}` }[changeKind(c)];
};
