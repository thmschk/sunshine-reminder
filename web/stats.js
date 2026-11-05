// Statistikseite: liest die Summen aus /api/stats und zeichnet sie ohne Fremdbibliothek.
const SERVICES = {
  apple: "Apple (iPhone, iPad, Mac)",
  google: "Google (Chrome, Android)",
  mozilla: "Mozilla (Firefox)",
  microsoft: "Microsoft (Edge)",
  andere: "andere",
};
const SVG = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const fmtDay = (iso) => new Date(iso + "T12:00").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

// Linie der Gerätezahl je Tag; jeder Punkt trägt einen Tooltip (<title>).
function lineChart(box, daily) {
  if (daily.length < 2) {
    box.textContent = "Der Verlauf füllt sich ab heute Tag für Tag.";
    box.classList.add("stats-note");
    return;
  }
  const W = 600, H = 180, L = 32, R = 8, T = 10, B = 24;
  const max = Math.max(1, ...daily.map((d) => d.subs));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * Math.ceil(max / step);
  const x = (i) => L + (i * (W - L - R)) / (daily.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Geräte mit Erinnerung je Tag" });
  for (let v = 0; v <= top; v += step) {
    svg.append(el("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }));
    svg.append(el("text", { x: L - 6, y: y(v) + 4, class: "axis", "text-anchor": "end" }, v));
  }
  for (const i of [0, daily.length - 1]) {
    svg.append(el("text", { x: x(i), y: H - 6, class: "axis", "text-anchor": i ? "end" : "start" }, fmtDay(daily[i].day)));
  }
  svg.append(el("path", { d: daily.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.subs)}`).join(""), class: "line" }));
  daily.forEach((d, i) => {
    const g = el("g", { class: "pt" });
    g.append(el("title", {}, `${fmtDay(d.day)}: ${d.subs} Geräte, davon ${d.apple} Apple`));
    g.append(el("rect", { x: x(i) - (W - L - R) / daily.length / 2, y: T, width: (W - L - R) / daily.length, height: H - T - B, class: "hit" }));
    g.append(el("circle", { cx: x(i), cy: y(d.subs), r: 4, class: "dot" }));
    svg.append(g);
  });
  const last = daily[daily.length - 1];
  svg.append(el("text", { x: x(daily.length - 1) - 8, y: y(last.subs) - 8, class: "label", "text-anchor": "end" }, last.subs));
  box.append(svg);
}

function services(table, s, total) {
  for (const [key, name] of Object.entries(SERVICES)) {
    if (!s[key] && key === "andere") continue;
    const tr = table.insertRow();
    tr.insertCell().textContent = name;
    const c = tr.insertCell();
    c.textContent = s[key];
    c.className = "num";
    const p = tr.insertCell();
    p.textContent = total ? `${Math.round((100 * s[key]) / total)} %` : "–";
    p.className = "num";
  }
}

async function main() {
  let d;
  try {
    const r = await fetch("/api/stats", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    d = await r.json();
  } catch {
    $("st-error").hidden = false;
    return;
  }
  $("st-date").textContent = `Stand ${new Date(d.date + "T12:00").toLocaleDateString("de-DE")}.`;
  $("st-subs").textContent = d.subs;
  $("st-new7").textContent = d.new_7d;
  $("st-new30").textContent = d.new_30d;
  $("st-morning").textContent = d.morning;
  lineChart($("st-chart"), d.daily);
  services($("st-services"), d.services, d.subs);
  $("st-body").hidden = false;
}

main();
