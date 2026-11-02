// Abo der Erinnerung beim Server. Seite (Selbstheilung beim Öffnen, „Jetzt testen“,
// „Erinnerung reparieren“) und Service Worker (pushsubscriptionchange) nutzen es gemeinsam.

/**
 * Neue Abo-Adresse dem Server melden. Kennt der Server das Abo nicht mehr (404),
 * wird es mit den gespeicherten Einstellungen neu angelegt und Kennung samt
 * Geheimnis ersetzt. Wirft, wenn das nicht gelingt.
 */
export async function renewPush(push, subscription, { fetch: f = fetch, weekdays } = {}) {
  const put = await f(`/api/subscriptions/${push.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${push.secret}` },
    body: JSON.stringify({ subscription }),
  });
  if (put.ok) return push;
  if (put.status !== 404) throw new Error(`Server: HTTP ${put.status}`);
  const post = await f("/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription, time: push.time, morning_time: push.morning || null, weekdays, tz: "Europe/Berlin" }),
  });
  if (!post.ok) throw new Error(`Server: HTTP ${post.status}`);
  const { id, secret } = await post.json();
  if (!id || !secret) throw new Error("Server: Antwort ohne Kennung");
  return { ...push, id, secret };
}

/**
 * Wie viele fällige Erinnerungen seit since ausblieben: je gewähltem Wochentag die Uhrzeit
 * plus 30 min Spielraum (so weit verschiebt der Server höchstens), sofern sie zwischen since
 * und now liegt. weekdays: 1 = Montag … 5 = Freitag.
 */
export function missedSlots(since, time, weekdays, now = Date.now()) {
  if (!since || !/^\d{2}:\d{2}$/.test(time || "")) return 0;
  const [h, m] = time.split(":").map(Number);
  const day = new Date(since);
  day.setHours(0, 0, 0, 0);
  let n = 0;
  for (; day.getTime() < now; day.setDate(day.getDate() + 1)) {
    const slot = new Date(day);
    slot.setHours(h, m + 30, 0, 0);
    const wd = ((day.getDay() + 6) % 7) + 1;
    if (weekdays.includes(wd) && slot.getTime() > since && slot.getTime() < now) n++;
  }
  return n;
}
