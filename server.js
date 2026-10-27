require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3002);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

if (!process.env.SESSION_SECRET || !process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
  console.error("Missing .env settings. Copy .env.example to .env and configure credentials.");
  process.exit(1);
}
if (process.env.ADMIN_PASSWORD.length < 12 || process.env.SESSION_SECRET.length < 32) {
  console.error("Security check: ADMIN_PASSWORD must be at least 12 characters and SESSION_SECRET at least 32 characters.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({
  markets: [
    { id: "mahadev", name: "Mahadev", openTime: "15:00", closeTime: "18:00", results: [] },
    { id: "mahadev-night", name: "Mahadev Night", openTime: "19:00", closeTime: "22:00", results: [] }
  ], nextId: 1, logs: []
}, null, 2), { mode: 0o600 });

function readStore() {
  try {
    const s = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(s.markets)) s.markets = [];
    if (!Array.isArray(s.logs)) s.logs = [];
    if (!Number.isInteger(s.nextId)) s.nextId = 1;
    s.markets.forEach(m => { if (!Array.isArray(m.results)) m.results = []; });
    return s;
  } catch (err) {
    console.error(`Unable to read ${DATA_FILE}. The existing file has been left untouched.`, err.message);
    throw new Error("The saved data file could not be read. Check data/store.json before making changes; the app will not replace it automatically.");
  }
}
function writeStore(s) {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DATA_FILE);
}
function logAction(s, action, detail) {
  s.logs.unshift({ at: new Date().toISOString(), action, detail });
  s.logs = s.logs.slice(0, 500);
}
function esc(v = "") {
  return String(v).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function validDate(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [year, month, day] = v.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function validTime(v) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(v); }
function validPanna(v) { return typeof v === "string" && /^\d{3}$/.test(v); }
function openIsPublished(r) { return r.openPublished === true || r.published === true; }
function closeIsPublished(r) { return r.closePublished === true || r.published === true; }
function resultIsVisible(r) { return openIsPublished(r) || closeIsPublished(r); }
function resultIsComplete(r) { return openIsPublished(r) && closeIsPublished(r) && validPanna(r.openPanna) && validPanna(r.closePanna); }
function pannaAnk(v) { return String([...v].reduce((sum, digit) => sum + Number(digit), 0) % 10); }
function validJodi(v) { return typeof v === "string" && /^\d{2}$/.test(v); }
function localDateISO(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function adminOnly(req, res, next) { if (!req.session.admin) return res.redirect("/login"); next(); }
function flash(req) { const m = req.session.flash; delete req.session.flash; return m ? `<div class="flash">${esc(m)}</div>` : ""; }
function page(title, content, admin = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#17120b"><title>${esc(title)} · MAHADEV</title><style>
:root{--bg:#ffd09f;--ink:#061b5b;--gold:#ffef00;--dark:#17120b;--line:#ff3b22;--muted:#30251c}*{box-sizing:border-box}body{margin:0;max-width:100%;overflow-x:hidden;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}header{background:var(--dark);color:#f7e2a6;text-align:center;padding:16px 12px;border-bottom:4px solid #ff00c8}.brand{font:800 clamp(27px,6vw,38px) Georgia,serif;letter-spacing:2px}.tag{font-size:11px;color:#d7c69c;margin-top:5px;letter-spacing:2px}nav{display:flex;justify-content:center;align-items:center;gap:13px;flex-wrap:wrap;padding:12px;background:#282014}nav a{color:#f8e5b0;text-decoration:none;font-size:14px}main{width:100%;max-width:760px;margin:0 auto;padding:0 10px calc(110px + env(safe-area-inset-bottom))}.panel{background:#fffdf8;border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px;box-shadow:0 3px 14px #3b2a1010}.market{position:relative;background:#ffcf9d;border:2px solid #ff00c8;border-bottom:2px solid #ff3b22;border-radius:0;padding:8px 66px 9px;margin:0;min-height:104px;text-align:center;box-shadow:none}.market h2,h2{font:italic 900 clamp(22px,5.2vw,34px)/1.1 Arial,sans-serif;color:#061b5b;text-shadow:1px 2px 1px #fff;margin:0 0 5px}.market .meta{display:none}.result-line{font:italic 900 clamp(25px,5.7vw,36px)/1.1 Arial,sans-serif;color:#501080;margin:2px 0 5px;white-space:nowrap}.market-times{display:flex;justify-content:center;gap:22px;font:bold italic clamp(15px,4vw,24px)/1.1 Arial,sans-serif;color:#111;white-space:nowrap}.market-action{position:absolute;top:50%;transform:translateY(-50%);background:#542c91;color:white;border:2px solid #e5d7ff;border-radius:14px;padding:7px 9px;font:bold italic 16px Arial,sans-serif;text-decoration:none;box-shadow:0 1px 2px #0003}.market-action.left{left:7px}.market-action.right{right:7px}.market.highlight{background:#fff500}.empty-result{font-size:14px;color:#5d4935;margin:7px 0}h3{margin:14px 0 8px;font-size:16px}.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:12px}.meta b{color:var(--ink)}.table-wrap{width:100%;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}table{width:100%;border-collapse:collapse;table-layout:fixed}.history-table{min-width:560px}th,td{padding:11px 5px;text-align:center;border-bottom:1px solid #eee3cd;overflow-wrap:anywhere}th{background:#f6ecd4;font-size:12px;text-transform:uppercase}td{font-weight:650;font-size:14px}.num{color:#7a4c00;font-size:20px}input,select{width:100%;padding:10px;border:1px solid #cbbd9f;border-radius:7px;background:white;margin:5px 0 12px;font:inherit}label{font-size:13px;font-weight:700}button,.btn{display:inline-block;background:#8a5c0a;color:white;border:0;border-radius:7px;padding:10px 14px;text-decoration:none;font-weight:700;cursor:pointer;font:inherit}button:hover,.btn:hover{background:#684506}.danger{background:#8c2525}.row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stat{background:#f6ecd4;border:1px solid var(--line);padding:14px;border-radius:9px}.stat strong{display:block;font-size:26px;color:#754d08}.flash{padding:10px;background:#fff2cf;border:1px solid #e8cb7b;border-radius:8px;margin-bottom:12px}.muted{font-size:13px;color:var(--muted)}.status{display:inline-block;border-radius:99px;background:#e7dfcb;padding:4px 9px;font-size:11px;color:#5c4619}.inline{display:inline-block;margin:0}.bottom-nav{position:fixed;z-index:10;bottom:calc(8px + env(safe-area-inset-bottom));left:7px;right:7px;display:flex;justify-content:center;flex-wrap:wrap;gap:6px;pointer-events:none}.bottom-nav a,.bottom-nav button{flex:1 1 auto;min-width:0;text-align:center;white-space:nowrap;pointer-events:auto;background:linear-gradient(90deg,#061b5b,#007b91);color:#fff;border:2px solid #fff;border-radius:9px;padding:9px 12px;font-weight:800;font-style:italic;text-decoration:none;font-size:clamp(13px,3.5vw,19px);box-shadow:0 2px 5px #0004}footer{text-align:center;padding:25px;color:#756a58;font-size:12px}@media(max-width:560px){nav{gap:10px;padding:10px 8px}nav a{font-size:13px}main{padding-left:7px;padding-right:7px}.row,.stats{grid-template-columns:1fr}th,td{padding:8px 3px;font-size:12px}td.num{font-size:16px}.panel{padding:12px}.market{padding:8px 56px 9px;min-height:100px}.result-line{font-size:clamp(18px,6.2vw,29px);letter-spacing:-.5px}.market-action{font-size:13px;padding:6px 6px}.market-times{gap:9px;font-size:clamp(13px,4vw,18px)}.bottom-nav a,.bottom-nav button{padding:8px 6px;font-size:clamp(12px,3.4vw,15px)}button,.btn{max-width:100%}.panel{min-width:0}.history-table{min-width:560px}}@media(max-width:360px){.market{padding-left:50px;padding-right:50px}.market-action{font-size:12px;padding:5px 5px}.market h2{font-size:21px}.result-line{font-size:18px}.market-times{gap:6px;font-size:12px}.bottom-nav{gap:4px}.bottom-nav a,.bottom-nav button{font-size:11px;padding:7px 4px}}

.chart-hero{background:#ffd09f;border:2px solid #202020;border-radius:0;padding:10px 12px 12px;text-align:center;margin:0 0 10px;box-shadow:0 5px 14px #39220e20}
.chart-hero h2{font-style:normal!important;font-size:clamp(21px,5.8vw,31px)!important;margin:0 0 5px!important;overflow-wrap:anywhere}
.chart-hero .chart-latest{display:block;color:#82165b;font-size:clamp(22px,6vw,30px);line-height:1.15;margin:3px 0 8px;font-weight:900;overflow-wrap:anywhere}
.chart-subtitle{margin:4px 0 9px;color:#312319;font-size:12px;font-weight:700;letter-spacing:.25px}
.chart-actions{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}
.chart-actions a{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 12px;background:#a6d9ff;color:#06205e;border:2px solid #658aaa;text-decoration:none;font-weight:800;text-align:center;box-shadow:0 2px 4px #0002;flex:1 1 120px;max-width:220px}
.chart-section{margin:8px 0 16px;border:2px solid #1b2555;background:#ffd09f;box-shadow:0 2px 8px #3a210f18}
.chart-title{margin:0!important;padding:8px 6px;background:#3e51ad;color:#fff!important;text-align:center;font:bold clamp(14px,4vw,22px)/1.2 Arial,sans-serif!important;text-shadow:none!important;font-style:normal!important;overflow-wrap:anywhere}
.chart-table-wrap{width:100%;max-width:100%;overflow:visible}
.chart-table{width:100%;table-layout:fixed;border-collapse:collapse;background:#ffd09f}
.chart-table th,.chart-table td{border:1px solid #1d1d1d;text-align:center;vertical-align:middle;padding:0;overflow:hidden;overflow-wrap:anywhere}
.chart-table th{background:#ffd000;color:#080808;text-transform:none;font-size:clamp(10px,2.8vw,17px);line-height:1.1;padding:6px 1px;font-weight:900}
.chart-table td{font-weight:800;color:#090909}
.jodi-table td{height:48px;font-size:clamp(16px,5.3vw,29px)}
.jodi-cell{display:flex;align-items:center;justify-content:center;width:100%;min-height:46px;color:#080808;text-decoration:none;font-weight:900;line-height:1}
.jodi-cell.latest{color:#e21c22}
.jodi-cell:focus-visible,.panel-result:focus-visible{outline:3px solid #005fcc;outline-offset:-3px}
.blank-day{color:#8b765d;font-size:13px;font-weight:500}
.panel-table col.date-col{width:17%}.panel-table col.day-col{width:11.857%}
.panel-table th{font-size:clamp(9px,2.5vw,14px);padding:5px 0}
.panel-table .date-range{font-size:clamp(8px,2.2vw,11px);font-weight:800;line-height:1.2;padding:3px 1px}
.panel-table td{height:68px}
.panel-result{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:1px;width:100%;min-height:66px;text-decoration:none;color:#080808;padding:2px 0;line-height:1.05}
.panel-result .panna{font-size:clamp(7px,1.9vw,10px);font-weight:700;letter-spacing:-.4px;white-space:nowrap}
.panel-result strong{font-size:clamp(11px,3.4vw,17px);font-weight:900;line-height:1.1;color:#090909}
.panel-result.latest strong{color:#e21c22}
.panel-result.empty{color:#9b8165;font-size:10px;font-weight:500}
.chart-note{padding:8px 7px;margin:0;font-size:11px;line-height:1.35;color:#493828;background:#fff3de;border-top:1px solid #d5a979;text-align:center}
.sunday-list{padding:8px;background:#fff3de;border-top:1px solid #d5a979;font-size:12px;line-height:1.6}
.sunday-list a{color:#081e68;font-weight:800}
.chart-empty{padding:20px 10px;text-align:center;background:#fff3de;color:#4d3926;font-size:14px}
@media(max-width:390px){main{padding-left:5px;padding-right:5px}nav{gap:8px;padding:8px 5px}nav a{font-size:12px}.chart-hero{padding:8px 7px}.chart-actions a{min-height:36px;padding:7px 8px;font-size:13px}.chart-title{padding:7px 3px}.jodi-table td{height:42px}.jodi-cell{min-height:40px}.panel-table col.date-col{width:18%}.panel-table col.day-col{width:11.714%}.panel-table td{height:62px}.panel-result{min-height:60px}.panel-result .panna{font-size:7px;letter-spacing:-.6px}.panel-result strong{font-size:11px}.panel-table .date-range{font-size:8px}}

</style><script>
function ank(p){if(!/^\\d{3}$/.test(p))return "—";return String([...p].reduce((a,d)=>a+Number(d),0)%10)}
function updatePreview(form){const o=form.querySelector('[name="openPanna"]').value,c=form.querySelector('[name="closePanna"]').value;const oa=ank(o),ca=ank(c);const open=form.querySelector('[data-preview="open"]'),jodi=form.querySelector('[data-preview="jodi"]'),close=form.querySelector('[data-preview="close"]');if(open)open.textContent="Open Ank: "+oa;if(jodi)jodi.textContent="Jodi: "+(oa!=="—"&&ca!=="—"?oa+ca:"—");if(close)close.textContent="Close Ank: "+ca}
</script></head><body><header><div class="brand">🔱 MAHADEV</div><div class="tag">MARKET RESULT BOARD</div></header><nav><a href="/">Result Board</a>${admin ? '<a href="/admin">Dashboard</a><a href="/admin/logs">Change Log</a><a href="/admin/backup">Backup</a><form method="post" action="/logout" class="inline"><button style="padding:5px 9px">Logout</button></form>' : '<a href="/login">Admin Login</a>'}</nav><main>${content}</main><footer>Market results and timings</footer></body></html>`;
}
function resultTable(r) {
  const openAnk = r.openAnk ?? pannaAnk(r.openPanna);
  const closeAnk = r.closeAnk ?? pannaAnk(r.closePanna);
  const jodi = r.jodi ?? `${openAnk}${closeAnk}`;
  return `<table><thead><tr><th>Open Panna</th><th>Open Ank</th><th>Jodi</th><th>Close Panna</th><th>Close Ank</th></tr></thead><tbody><tr><td class="num">${esc(r.openPanna)}</td><td class="num">${esc(openAnk)}</td><td class="num">${esc(jodi)}</td><td class="num">${esc(r.closePanna)}</td><td class="num">${esc(closeAnk)}</td></tr></tbody></table>`;
}
function marketCard(m, history = false, query = "") {
  const q = query.toLowerCase();
  const rows = m.results.filter(r => resultIsVisible(r) && (!q || [m.name, r.date, r.openPanna, r.jodi, r.closePanna].some(v => String(v).toLowerCase().includes(q)))).sort((a,b)=>b.date.localeCompare(a.date));
  const latest = rows[0];
  if (!history) {
    const isHighlight = /karnataka|rajan morning/i.test(m.name);
    const result = latest ? (resultIsComplete(latest) ? `${latest.openPanna}-${resultJodi(latest)}-${latest.closePanna}` : (openIsPublished(latest) ? `${latest.openPanna}-${pannaAnk(latest.openPanna)}-…` : `…-…-${latest.closePanna}`)) : "Result Pending";
    return `<section class="market ${isHighlight ? "highlight" : ""}"><a class="market-action left" href="/jodi?market=${encodeURIComponent(m.id)}">Jodi</a><a class="market-action right" href="/panel?market=${encodeURIComponent(m.id)}">Panel</a><h2>${esc(chartMarketName(m.name))}</h2><div class="result-line">${esc(result)}</div><div class="market-times"><span>${esc(formatTime(m.openTime))}</span><span>${esc(formatTime(m.closeTime))}</span></div>${latest ? `<div class="muted" style="font-size:10px;margin-top:3px">${esc(latest.date)}</div>` : `<div class="empty-result">Result will be available soon</div>`}</section>`;
  }
  return `<section class="market"><h2>${esc(chartMarketName(m.name))}</h2><div class="meta"><span>Open: <b>${esc(m.openTime)}</b></span><span>Close: <b>${esc(m.closeTime)}</b></span></div>${rows.length ? `<div class="table-wrap"><table class="history-table"><thead><tr><th>Date</th><th>Open Panna</th><th>Open Ank</th><th>Jodi</th><th>Close Panna</th><th>Close Ank</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td class="num">${esc(openIsPublished(r) ? r.openPanna : "—")}</td><td class="num">${esc(openIsPublished(r) ? (r.openAnk ?? pannaAnk(r.openPanna)) : "—")}</td><td class="num">${esc(resultIsComplete(r) ? resultJodi(r) : "—")}</td><td class="num">${esc(closeIsPublished(r) ? r.closePanna : "—")}</td><td class="num">${esc(closeIsPublished(r) ? (r.closeAnk ?? pannaAnk(r.closePanna)) : "—")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No matching published results.</p>'}</section>`;
}
function formatTime(value) { const [h,m] = String(value || "00:00").split(":").map(Number); const suffix = h >= 12 ? "PM" : "AM"; const hour = h % 12 || 12; return `${hour}:${String(m).padStart(2,"0")} ${suffix}`; }

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "3mb" }));
app.use(session({ name:"mahadev.sid", secret:process.env.SESSION_SECRET, resave:false, saveUninitialized:false,
  cookie:{ httpOnly:true, sameSite:"strict", secure: process.env.NODE_ENV === "production", maxAge:2*60*60*1000 } }));

app.get("/", (req,res) => { const s=readStore(); const board=s.markets.map(m=>marketCard(m)).join("") || '<section class="panel">No markets yet.</section>'; res.send(page("Result Board", board + '<div class="bottom-nav"><a href="/login">VIP Zone</a><button type="button" onclick="location.reload()">REFRESH</button></div>')); });

function chartMarketName(name) {
  return String(name || "").replace(/\bmatka\b/ig, "").replace(/\s{2,}/g, " ").trim();
}
function resultJodi(r) {
  return String(r.jodi ?? `${pannaAnk(r.openPanna)}${pannaAnk(r.closePanna)}`).padStart(2, "0");
}
function dateParts(iso) {
  const [y,m,d] = String(iso).split("-").map(Number);
  return { y, m, d, date: new Date(Date.UTC(y, m - 1, d, 12)) };
}
function isoDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}-${String(date.getUTCDate()).padStart(2,"0")}`;
}
function shortDate(iso) {
  const p = dateParts(iso);
  return `${String(p.d).padStart(2,"0")}/${String(p.m).padStart(2,"0")}/${p.y}`;
}
function dateWeekStart(iso) {
  const d = dateParts(iso).date;
  const mondayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - mondayOffset);
  return isoDate(d);
}
function groupedWeeks(results) {
  const byWeek = new Map();
  for (const r of results) {
    const start = dateWeekStart(r.date);
    if (!byWeek.has(start)) byWeek.set(start, new Map());
    byWeek.get(start).set(r.date, r);
  }
  if (!results.length) return [];
  const starts = [...byWeek.keys()].sort((a,b) => a.localeCompare(b));
  const cursor = dateParts(starts[0]).date;
  const last = starts[starts.length - 1];
  const weeks = [];
  while (isoDate(cursor) <= last) {
    const key = isoDate(cursor);
    weeks.push([key, byWeek.get(key) || new Map()]);
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return weeks;
}
function chartHero(m, latest, mode) {
  const name = chartMarketName(m.name) || "Market";
  const latestText = latest ? (resultIsComplete(latest) ? `${latest.openPanna}-${resultJodi(latest)}-${latest.closePanna}` : (openIsPublished(latest) ? `${latest.openPanna}-${pannaAnk(latest.openPanna)}-…` : `…-…-${latest.closePanna}`)) : "No published results yet";
  const alternate = mode === "jodi" ? "Panel Chart" : "Jodi Chart";
  const alternateHref = `/${mode === "jodi" ? "panel" : "jodi"}?market=${encodeURIComponent(m.id)}`;
  return `<section class="chart-hero"><h2>${esc(name)}</h2><strong class="chart-latest">${esc(latestText)}</strong><p class="chart-subtitle">${mode === "jodi" ? "JODI RESULT CHART" : "PANEL RESULT CHART"}</p><div class="chart-actions"><a href="#chart-bottom">Go to Bottom</a><a href="${alternateHref}">${alternate}</a></div></section>`;
}
function marketChooser(s, mode) {
  return `<section class="panel"><h2>Select Market</h2><p>Choose a market to open its ${mode === "jodi" ? "Jodi" : "Panel"} chart.</p>${s.markets.map(m=>`<p><a class="btn" href="/${mode}?market=${encodeURIComponent(m.id)}">${esc(chartMarketName(m.name))}</a></p>`).join("") || '<p class="muted">No markets available.</p>'}</section>`;
}
function renderJodiChart(m) {
  const published = m.results.filter(r => resultIsComplete(r) && validDate(r.date)).sort((a,b)=>a.date.localeCompare(b.date));
  const latest = published.length ? published[published.length-1] : null;
  const weeks = groupedWeeks(published);
  const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat"];
  const resultByDate = new Map(published.map(r=>[r.date,r]));
  const rows = weeks.map(([start]) => {
    const startDate = dateParts(start).date;
    const cells = dayNames.map((_,idx) => {
      const day = new Date(startDate); day.setUTCDate(day.getUTCDate()+idx);
      const date = isoDate(day), r = resultByDate.get(date);
      if (!r) return `<td><span class="blank-day">—</span></td>`;
      const value = resultJodi(r), isLatest = latest && r.date === latest.date;
      return `<td><a class="jodi-cell${isLatest ? " latest" : ""}" href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}" title="${shortDate(r.date)}">${esc(value)}</a></td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  const sunday = published.filter(r => dateParts(r.date).date.getUTCDay() === 0);
  const sundayBlock = sunday.length ? `<div class="sunday-list"><strong>Sunday results:</strong> ${sunday.map(r=>`<a href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}">${shortDate(r.date)} · ${esc(resultJodi(r))}</a>`).join(" · ")}</div>` : "";
  const body = rows ? `<div class="chart-table-wrap"><table class="chart-table jodi-table"><thead><tr>${dayNames.map(d=>`<th>${d}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>${sundayBlock}<p class="chart-note">Only saved, published results are shown. Tap a number to open its result details.</p>` : `<div class="chart-empty">No published results are available for this market yet.</div>`;
  return `${chartHero(m,latest,"jodi")}<section class="chart-section" id="chart"><h2 class="chart-title">${esc(chartMarketName(m.name).toUpperCase())} JODI RECORD</h2>${body}</section><div id="chart-bottom"></div>`;
}
function renderPanelChart(m) {
  const published = m.results.filter(r => resultIsVisible(r) && validDate(r.date)).sort((a,b)=>a.date.localeCompare(b.date));
  const latest = published.length ? published[published.length-1] : null;
  const weeks = groupedWeeks(published);
  const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const resultByDate = new Map(published.map(r=>[r.date,r]));
  const rows = weeks.map(([start]) => {
    const startDate = dateParts(start).date;
    const endDate = new Date(startDate); endDate.setUTCDate(endDate.getUTCDate()+6);
    const dateLabel = `${shortDate(start)}<br>to<br>${shortDate(isoDate(endDate))}`;
    const cells = dayNames.map((_,idx) => {
      const day = new Date(startDate); day.setUTCDate(day.getUTCDate()+idx);
      const date = isoDate(day), r = resultByDate.get(date);
      if (!r) return `<td><span class="blank-day">—</span></td>`;
      const isLatest = latest && r.date === latest.date;
      const openText = openIsPublished(r) ? r.openPanna : "—"; const closeText = closeIsPublished(r) ? r.closePanna : "—"; const jodiText = resultIsComplete(r) ? resultJodi(r) : "—";
      return `<td><a class="panel-result${isLatest ? " latest" : ""}" href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}" title="${shortDate(r.date)} · ${esc(openText)}-${esc(jodiText)}-${esc(closeText)}"><span class="panna">${esc(openText)}</span><strong>${esc(jodiText)}</strong><span class="panna">${esc(closeText)}</span></a></td>`;
    }).join("");
    return `<tr><td class="date-range">${dateLabel}</td>${cells}</tr>`;
  }).join("");
  const body = rows ? `<div class="chart-table-wrap"><table class="chart-table panel-table"><colgroup><col class="date-col">${dayNames.map(()=>'<col class="day-col">').join("")}</colgroup><thead><tr><th>Date</th>${dayNames.map(d=>`<th>${d}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div><p class="chart-note">Each cell shows Open Panna, Jodi and Close Panna. Only saved, published results are shown.</p>` : `<div class="chart-empty">No published results are available for this market yet.</div>`;
  return `${chartHero(m,latest,"panel")}<section class="chart-section" id="chart"><h2 class="chart-title">${esc(chartMarketName(m.name).toUpperCase())} PANEL RECORD</h2>${body}</section><div id="chart-bottom"></div>`;
}
app.get("/jodi", (req,res) => {
  const s = readStore(), marketId = String(req.query.market || "");
  const m = s.markets.find(x=>x.id === marketId);
  if (!m) return res.send(page("Jodi Chart",marketChooser(s,"jodi")));
  res.send(page("Jodi Chart",renderJodiChart(m)));
});
app.get("/panel", (req,res) => {
  const s = readStore(), marketId = String(req.query.market || "");
  const m = s.markets.find(x=>x.id === marketId);
  if (!m) return res.send(page("Panel Chart",marketChooser(s,"panel")));
  res.send(page("Panel Chart",renderPanelChart(m)));
});

app.get("/history", (req,res) => {
  const s=readStore(), q=String(req.query.q||"").slice(0,80), marketId=String(req.query.market||"");
  const markets=s.markets.filter(m=>!marketId||m.id===marketId);
  const form=`<section class="panel"><h2>Result History</h2><form method="get" action="/history"><div class="row"><div><label>Market</label><select name="market"><option value="">All markets</option>${s.markets.map(m=>`<option value="${esc(m.id)}" ${m.id===marketId?'selected':''}>${esc(chartMarketName(m.name))}</option>`).join("")}</select></div><div><label>Search date / number / market</label><input name="q" value="${esc(q)}" placeholder="Search history"></div><div style="display:flex;align-items:end"><button style="margin-bottom:12px;width:100%">Filter History</button></div></div></form></section>`;
  res.send(page("Result History",form+markets.map(m=>marketCard(m,true,q)).join("")||'<section class="panel">No markets.</section>'));
});
app.get("/login",(req,res)=>{if(req.session.admin)return res.redirect("/admin");res.send(page("Admin Login",`${flash(req)}<section class="panel" style="max-width:440px;margin:auto"><h2>Admin Login</h2><form method="post" action="/login"><label>Username</label><input name="username" autocomplete="username" required maxlength="80"><label>Password</label><input type="password" name="password" autocomplete="current-password" required maxlength="200"><button>Login</button></form></section>`));});
app.post("/login",(req,res)=>{const ok=String(req.body.username||"")===process.env.ADMIN_USERNAME&&String(req.body.password||"")===process.env.ADMIN_PASSWORD;if(!ok){req.session.flash="Login details did not match.";return res.redirect("/login");}req.session.regenerate(err=>{if(err)return res.status(500).send("Could not start session.");req.session.admin=true;res.redirect("/admin");});});
function adminOnly(req,res,next){if(!req.session.admin)return res.redirect("/login");next();}
app.post("/logout",adminOnly,(req,res)=>req.session.destroy(()=>res.redirect("/")));

app.get("/admin",adminOnly,(req,res)=>{
 const s=readStore(), total=s.markets.reduce((n,m)=>n+m.results.length,0), published=s.markets.reduce((n,m)=>n+m.results.filter(r=>resultIsVisible(r)).length,0), drafts=total-published;
 const add=`<section class="panel"><h2>Add Your Own Market</h2><form method="post" action="/admin/market/add"><label>Market name</label><input name="name" required maxlength="60" placeholder="e.g. My New Market"><div class="row"><div><label>Open time</label><input type="time" name="openTime" value="15:00" required></div><div><label>Close time</label><input type="time" name="closeTime" value="18:00" required></div><div style="display:flex;align-items:end"><button style="margin-bottom:12px;width:100%">Add Market</button></div></div></form></section>`;
 const cards=s.markets.map(m=>`<section class="panel"><h2>${esc(chartMarketName(m.name))}</h2><p class="muted">Open ${esc(m.openTime)} · Close ${esc(m.closeTime)} · ${m.results.length} saved result(s)</p><form method="post" action="/admin/market/update"><input type="hidden" name="id" value="${esc(m.id)}"><div class="row"><div><label>Market name</label><input name="name" value="${esc(chartMarketName(m.name))}" required maxlength="60"></div><div><label>Open time</label><input type="time" name="openTime" value="${esc(m.openTime)}" required></div><div><label>Close time</label><input type="time" name="closeTime" value="${esc(m.closeTime)}" required></div></div><button>Save Market Details</button></form><hr style="border:0;border-top:1px solid #eee3cd;margin:18px 0"><h3>Result Management</h3><form method="post" action="/admin/result"><input type="hidden" name="marketId" value="${esc(m.id)}"><label>Result date</label><input type="date" name="date" value="${localDateISO()}" required><div class="row"><div><label>Open Panna (any 3 digits)</label><input name="openPanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" placeholder="119" oninput="updatePreview(this.form)"></div><div><label>Close Panna (any 3 digits)</label><input name="closePanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" placeholder="169" oninput="updatePreview(this.form)"></div></div><div class="stat" style="margin:8px 0 14px"><span>Result preview</span><strong data-preview="open">Open Ank: —</strong><strong data-preview="jodi">Jodi: —</strong><strong data-preview="close">Close Ank: —</strong><p class="muted">Publish Open after its result is ready, then publish Close later for the same date.</p></div><button name="action" value="publish-open">Publish Open Only</button> <button name="action" value="publish-close">Publish Close Only</button> <button name="action" value="publish">Publish Both</button></form><form method="post" action="/admin/market/delete" onsubmit="return confirm('Delete this market and all its results?')" style="margin-top:14px"><input type="hidden" name="id" value="${esc(m.id)}"><button class="danger">Delete Market</button></form></section>`).join("");
 res.send(page("Admin Dashboard",`${flash(req)}<section class="panel"><h2>Admin Dashboard</h2><div class="stats"><div class="stat"><span>Markets</span><strong>${s.markets.length}</strong></div><div class="stat"><span>Published results</span><strong>${published}</strong></div><div class="stat"><span>Draft / unpublished</span><strong>${drafts}</strong></div></div></section>${add}${cards}` ,true));
});
app.post("/admin/market/add",adminOnly,(req,res)=>{const name=String(req.body.name||"").trim(),openTime=String(req.body.openTime||""),closeTime=String(req.body.closeTime||"");if(!name||name.length>60||!validTime(openTime)||!validTime(closeTime)){req.session.flash="Enter a market name and valid times.";return res.redirect("/admin");}const s=readStore(),m={id:"market-"+s.nextId++,name,openTime,closeTime,results:[]};s.markets.push(m);logAction(s,"Market added",name);writeStore(s);req.session.flash="Market added.";res.redirect("/admin");});
app.post("/admin/market/update",adminOnly,(req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.id),name=String(req.body.name||"").trim(),openTime=String(req.body.openTime||""),closeTime=String(req.body.closeTime||"");if(!m||!name||name.length>60||!validTime(openTime)||!validTime(closeTime)){req.session.flash="Could not update market; check the values.";return res.redirect("/admin");}const before=m.name;m.name=name;m.openTime=openTime;m.closeTime=closeTime;logAction(s,"Market updated",`${before} → ${name} (${openTime}-${closeTime})`);writeStore(s);req.session.flash="Market details updated.";res.redirect("/admin");});
app.post("/admin/market/delete",adminOnly,(req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.id);if(m){s.markets=s.markets.filter(x=>x.id!==req.body.id);logAction(s,"Market deleted",m.name);writeStore(s);}req.session.flash="Market deleted.";res.redirect("/admin");});
app.post("/admin/result",adminOnly,(req,res)=>{
  const s=readStore(),m=s.markets.find(x=>x.id===req.body.marketId),date=String(req.body.date||""),action=String(req.body.action||"");
  const old=m&&m.results.find(r=>r.date===date);
  if(!m||!validDate(date)){req.session.flash="Choose a valid market and date.";return res.redirect("/admin");}
  if(action==="publish-open"||action==="publish-close"){
    const field=action==="publish-open"?"openPanna":"closePanna",value=String(req.body[field]||"");
    if(!validPanna(value)){req.session.flash=`${action==="publish-open"?"Open":"Close"} Panna must contain exactly 3 digits.`;return res.redirect("/admin");}
    const entry=old||{date,openPanna:"",openAnk:"",jodi:"",closePanna:"",closeAnk:"",published:false,openPublished:false,closePublished:false};
    if(action==="publish-open"){entry.openPanna=value;entry.openAnk=pannaAnk(value);entry.openPublished=true;}
    else {entry.closePanna=value;entry.closeAnk=pannaAnk(value);entry.closePublished=true;}
    entry.published=entry.openPublished===true&&entry.closePublished===true;
    if(entry.published) entry.jodi=String(entry.openAnk)+String(entry.closeAnk);
    entry.updatedAt=new Date().toISOString();
    if(old){m.results[m.results.findIndex(r=>r.date===date)]=entry;}else{m.results.push(entry);}
    logAction(s,old?"Result updated":"Result added",`${m.name} · ${date} · ${action==="publish-open"?"Open":"Close"} published`);
    writeStore(s);req.session.flash=action==="publish-open"?"Open result published. You can publish Close later for the same date.":"Close result published.";return res.redirect("/admin");
  }
  if(action==="publish"||action==="draft"){
    const openPanna=String(req.body.openPanna||old?.openPanna||""),closePanna=String(req.body.closePanna||old?.closePanna||"");
    if(!validPanna(openPanna)||!validPanna(closePanna)){req.session.flash="To publish both together, enter valid 3-digit Open and Close Panna.";return res.redirect("/admin");}
    const openAnk=pannaAnk(openPanna),closeAnk=pannaAnk(closePanna),published=action==="publish";
    const entry={date,openPanna,openAnk,jodi:openAnk+closeAnk,closePanna,closeAnk,published,openPublished:published,closePublished:published,updatedAt:new Date().toISOString()};
    const idx=m.results.findIndex(r=>r.date===date);if(idx>=0)m.results[idx]=entry;else m.results.push(entry);
    logAction(s,old?"Result updated":"Result added",`${m.name} · ${date} · ${openPanna}/${entry.jodi}/${closePanna} · ${published?"both published":"draft"}`);
    writeStore(s);req.session.flash=published?"Open and Close results published.":"Draft saved.";return res.redirect("/admin");
  }
  req.session.flash="Choose a valid publish action.";res.redirect("/admin");
});
app.post("/admin/result/toggle",adminOnly,(req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.marketId),r=m&&m.results.find(x=>x.date===req.body.date);if(r){r.published=!r.published;r.openPublished=r.published;r.closePublished=r.published;r.updatedAt=new Date().toISOString();logAction(s,r.published?"Result published":"Result unpublished",`${m.name} · ${r.date}`);writeStore(s);req.session.flash=r.published?"Result published.":"Result unpublished.";}res.redirect("/admin");});
app.get("/admin/logs",adminOnly,(req,res)=>{const s=readStore();const rows=s.logs.slice(0,200);res.send(page("Change Log",`<section class="panel"><h2>Recent Admin Changes</h2><p class="muted">Latest 200 actions; log is stored locally with the result data.</p>${rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.at.replace("T"," ").slice(0,19))}</td><td>${esc(x.action)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div>`:'<p>No changes logged yet.</p>'}</section>`,true));});
app.get("/admin/backup",adminOnly,(req,res)=>{res.send(page("Backup & Restore",`${flash(req)}<section class="panel"><h2>Backup & Restore</h2><p>Download a copy of your markets, results and change log. Keep the file private.</p><a class="btn" href="/admin/backup/download">Download JSON Backup</a><hr style="border:0;border-top:1px solid #eee3cd;margin:20px 0"><h3>Restore from backup</h3><p class="muted">Restore replaces current local data. Download a backup first. Only restore a JSON backup created by this app.</p><form method="post" action="/admin/backup/restore" enctype="multipart/form-data"><label>Select backup JSON file (max 2 MB)</label><input type="file" name="backup" accept=".json,application/json" required><button class="danger">Restore Backup</button></form></section>`,true));});
app.get("/admin/backup/download",adminOnly,(req,res)=>{res.setHeader("Content-Type","application/json");res.setHeader("Content-Disposition",`attachment; filename="mahadev-backup-${new Date().toISOString().slice(0,10)}.json"`);res.send(JSON.stringify(readStore(),null,2));});
app.post("/admin/backup/restore",adminOnly,upload.single("backup"),(req,res)=>{try{if(!req.file)throw Error("Choose a backup file.");const s=JSON.parse(req.file.buffer.toString("utf8"));if(!s||!Array.isArray(s.markets)||!Number.isInteger(s.nextId)||!Array.isArray(s.logs))throw Error("File is not a valid MAHADEV backup.");for(const m of s.markets){if(!m.id||!m.name||!validTime(m.openTime)||!validTime(m.closeTime)||!Array.isArray(m.results))throw Error("Backup market data is invalid.");for(const r of m.results){if(!validDate(r.date)||!validPanna(r.openPanna)||!validPanna(r.closePanna)||typeof r.published!=="boolean")throw Error("Backup result data is invalid.");}}logAction(s,"Backup restored","Data restored from uploaded JSON backup");writeStore(s);req.session.flash="Backup restored successfully.";res.redirect("/admin/backup");}catch(e){req.session.flash="Restore failed: "+e.message;res.redirect("/admin/backup");}});
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError){req.session.flash="Upload failed: file must be under 2 MB.";return res.redirect("/admin/backup");}console.error(err);res.status(500).send("Server error. Check the Termux terminal.");});
app.listen(PORT,"0.0.0.0",()=>console.log(`MAHADEV listening on port ${PORT}`));
