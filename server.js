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
    { id: "mahadev", name: "KALYAN", openTime: "11:00", closeTime: "18:00", results: [] },
    { id: "main-bazar", name: "MAIN BAZAR", openTime: "21:00", closeTime: "22:00", results: [] }
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
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#17120b"><title>${esc(title)} · DPBOSS</title><style>
:root{--bg:#fff7e9;--ink:#171717;--navy:#132d56;--orange:#f58220;--red:#b71922;--line:#e5a24a;--muted:#66584b;--paper:#fffdf8;--green:#176b3a}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;max-width:100%;overflow-x:hidden;background:var(--bg);color:var(--ink);font-family:Arial,Helvetica,sans-serif}
header{background:#fff;color:var(--red);text-align:center;padding:14px 10px 10px;border-bottom:3px solid var(--orange)}.brand-link{display:block;color:inherit;text-decoration:none}.brand{font:900 clamp(30px,7vw,46px)/1 Arial,sans-serif;letter-spacing:1px}.tag{font-size:11px;color:#444;margin-top:6px;font-weight:700;letter-spacing:1.5px}
nav{display:flex;justify-content:center;align-items:center;gap:0;flex-wrap:wrap;background:var(--navy);padding:0 5px}nav a{color:#fff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 11px;border-right:1px solid #ffffff30}nav a:hover{background:#234978}
main{width:100%;max-width:900px;margin:0 auto;padding:10px 8px calc(90px + env(safe-area-inset-bottom))}.panel{background:var(--paper);border:1px solid #e7d4b9;border-radius:4px;padding:14px;margin-bottom:12px;box-shadow:0 1px 4px #5c351014}
.market{position:relative;background:#fff;border:1px solid #e1a75e;border-left:4px solid var(--orange);border-radius:3px;padding:10px 78px;margin:0 0 7px;min-height:98px;text-align:center;box-shadow:0 1px 2px #0000000a}.market h2,h2{font:800 clamp(18px,4.7vw,25px)/1.15 Arial,sans-serif;color:var(--red);margin:0 0 5px;text-shadow:none}.market .meta{display:none}.result-line{font:900 clamp(22px,5.5vw,31px)/1.15 Arial,sans-serif;color:#1c3158;margin:3px 0 6px;white-space:nowrap;letter-spacing:1px}.market-times{display:flex;justify-content:center;gap:22px;font:bold 13px Arial,sans-serif;color:#333;white-space:nowrap}.market-action{position:absolute;top:50%;transform:translateY(-50%);background:var(--navy);color:#fff;border:0;border-radius:3px;padding:8px 10px;font:bold 13px Arial,sans-serif;text-decoration:none;box-shadow:none}.market-action.left{left:7px}.market-action.right{right:7px}.market.highlight{background:#fff4d9;border-left-color:#198754}.empty-result{font-size:12px;color:#8b5a24;margin:6px 0}
h3{margin:14px 0 8px;font-size:16px}.meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:12px}.meta b{color:var(--ink)}.table-wrap{width:100%;max-width:100%;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}table{width:100%;border-collapse:collapse;table-layout:fixed}.history-table{min-width:560px}th,td{padding:9px 5px;text-align:center;border:1px solid #e9d8c3;overflow-wrap:anywhere}th{background:#f8e5cb;color:#7d251d;font-size:12px;text-transform:uppercase}td{font-weight:650;font-size:14px;background:#fff}.num{color:#173c68;font-size:19px}
input,select{width:100%;padding:10px;border:1px solid #cbbd9f;border-radius:4px;background:white;margin:5px 0 12px;font:inherit}label{font-size:13px;font-weight:700}button,.btn{display:inline-block;background:var(--navy);color:white;border:0;border-radius:4px;padding:10px 14px;text-decoration:none;font-weight:700;cursor:pointer;font:inherit}button:hover,.btn:hover{background:#234978}.danger{background:#8c2525}.row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.stat{background:#fff4e4;border:1px solid #e7c79f;padding:14px;border-radius:4px}.stat strong{display:block;font-size:26px;color:var(--red)}.flash{padding:10px;background:#fff2cf;border:1px solid #e8cb7b;border-radius:4px;margin-bottom:12px}.muted{font-size:13px;color:var(--muted)}.status{display:inline-block;border-radius:3px;background:#e7dfcb;padding:4px 9px;font-size:11px;color:#5c4619}.inline{display:inline-block;margin:0}
.bottom-nav{position:fixed;z-index:10;bottom:calc(7px + env(safe-area-inset-bottom));left:7px;right:7px;display:flex;justify-content:center;gap:6px;pointer-events:none}.bottom-nav a,.bottom-nav button{flex:1;text-align:center;white-space:nowrap;pointer-events:auto;background:var(--navy);color:#fff;border:1px solid #fff;border-radius:4px;padding:10px 8px;font-weight:800;text-decoration:none;font-size:14px;box-shadow:0 2px 5px #0003}
footer{text-align:center;padding:18px;color:#756a58;font-size:12px;border-top:1px solid #ead8c0;background:#fff}.chart-hero{background:#fff;border:1px solid #e1a75e;border-top:4px solid var(--orange);border-radius:3px;padding:12px;text-align:center;margin:0 0 10px}.chart-hero h2{font-size:clamp(20px,5vw,28px)!important}.chart-hero .chart-latest{display:block;color:#173c68;font-size:clamp(22px,6vw,30px);margin:4px 0 8px;font-weight:900}.chart-subtitle{font-size:12px;font-weight:800;color:#8c261e;letter-spacing:1px}.chart-actions{display:flex;justify-content:center;gap:8px;flex-wrap:wrap}.chart-actions a{background:var(--navy);color:white;text-decoration:none;padding:8px 12px;border-radius:3px;font-size:12px;font-weight:700}.chart-section{background:#fff;border:1px solid #e2c9a8;margin-bottom:12px;padding:8px}.chart-title{text-align:center;background:#f7e3c8;color:#8a211b;padding:9px;font-size:16px!important;margin:0 0 8px!important}.chart-table-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}.chart-table{min-width:590px;border-collapse:collapse;table-layout:fixed}.chart-table th{background:#f4d7b4;color:#6e211c;padding:7px 2px}.chart-table td{padding:4px 2px;background:#fff;text-align:center}.chart-table .date-col{width:76px}.chart-table .day-col{width:auto}.date-range{font-size:10px;font-weight:800;color:#5c3525;background:#fff0dc!important;line-height:1.35}.jodi-cell{display:block;background:#fff0a6;color:#111;border:1px solid #d8b54a;padding:7px 1px;text-decoration:none;font-size:14px;font-weight:900}.panel-result{display:flex;flex-direction:column;align-items:center;gap:1px;background:#fff0a6;color:#111;border:1px solid #d8b54a;padding:3px 1px;text-decoration:none;font-weight:900}.panel-result .panna{font-size:10px}.panel-result strong{font-size:14px}.jodi-cell.latest,.panel-result.latest{background:#ffe08a;border-color:#a66a13}.blank-day{color:#b5a99a;font-size:12px}.chart-note{font-size:11px;color:#66584b;padding:8px}.chart-empty{text-align:center;padding:24px 10px;color:#6b6258}.sunday-list{font-size:12px;padding:8px}.sunday-list a{color:#153d6c;margin:0 4px}
@media(max-width:560px){nav{justify-content:flex-start;overflow-x:auto;flex-wrap:nowrap}nav a{white-space:nowrap;padding:11px 9px;font-size:12px}main{padding-left:6px;padding-right:6px}.row,.stats{grid-template-columns:1fr}th,td{padding:7px 3px;font-size:11px}td.num{font-size:15px}.panel{padding:10px}.market{padding:9px 58px;min-height:92px}.result-line{font-size:clamp(18px,5.7vw,26px);letter-spacing:0}.market-action{font-size:11px;padding:7px 5px}.market-times{gap:10px;font-size:11px}.bottom-nav a,.bottom-nav button{padding:9px 5px;font-size:12px}.history-table{min-width:560px}.chart-table{min-width:560px}}
@media(max-width:360px){.market{padding-left:51px;padding-right:51px}.market-action{font-size:10px;padding:6px 4px}.market h2{font-size:18px}.result-line{font-size:17px}.market-times{gap:6px;font-size:10px}.bottom-nav{gap:4px}.bottom-nav a,.bottom-nav button{font-size:11px;padding:8px 3px}}

/* DPBOSS-inspired responsive result-board refinement */
.home-hero{background:linear-gradient(135deg,#10294f,#1b4776);color:#fff;border:1px solid #0c2343;border-top:5px solid var(--orange);padding:20px 14px;text-align:center;margin:0 0 12px;box-shadow:0 3px 10px #10294f20}
.home-hero h1{font-size:clamp(23px,6vw,34px);line-height:1.15;margin:7px 0;color:#fff;letter-spacing:.3px}.home-hero p{margin:7px 0 14px;color:#e5edf7;font-size:13px}.hero-kicker,.section-kicker{font-size:11px;font-weight:900;letter-spacing:1.5px;color:#ffbd72}.hero-actions{display:flex;gap:7px;justify-content:center;flex-wrap:wrap}.hero-actions a,.home-link{display:inline-block;background:#f58220;color:#fff;text-decoration:none;font-size:11px;font-weight:900;padding:9px 11px;border-radius:3px}
.home-lucky{background:#fff;border:1px solid #e4bd8f;border-top:4px solid #f58220;padding:13px;margin:0 0 12px;text-align:center;box-shadow:0 2px 5px #0000000b}.home-lucky h2{margin:4px 0;color:#182f55}.home-date{font-size:12px;color:#76624d;margin:4px 0 10px}.section-kicker{color:#a52a25}.lucky-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.lucky-chip{display:flex;justify-content:space-between;align-items:center;gap:5px;background:#fff7ed;border:1px solid #efd7b9;padding:8px;font-size:11px;color:#253b5c}.lucky-chip strong{font-size:15px;color:#a51e28;white-space:nowrap}
.live-panel{background:#fff;border:1px solid #e2c7a4;border-left:5px solid #1c8b55;padding:13px;margin-bottom:12px;text-align:center}.live-panel>div:first-child{font-size:11px;color:#24633e;letter-spacing:.6px}.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#1b9b58;box-shadow:0 0 0 3px #1b9b5820}.live-market{font-size:17px;font-weight:900;color:#a51e28;margin-top:7px}.live-result{font-size:25px;font-weight:900;color:#19375f;margin:5px 0}.live-meta{font-size:11px;color:#75634f;margin-bottom:9px}.market-count{font-size:12px;color:#6d5b48;padding:5px 2px 9px}.market-count b{color:#a51e28}.market-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border:1px solid #e6d4bc;padding:10px;margin:0 0 9px}.market-toolbar h2{font-size:18px;margin:0;color:#1a3155}.market-toolbar p{font-size:11px;color:#76624d;margin:3px 0 0}.market-toolbar input{max-width:48%;margin:0;padding:9px;font-size:12px}.market-grid{display:grid;grid-template-columns:1fr;gap:8px}.market-grid .market{margin:0;min-height:112px;padding-top:13px;padding-bottom:11px;border-left-width:5px}.market-grid .market h2{font-size:20px}.market-grid .market-action{font-size:12px;padding:8px 9px}.market-grid .result-line{font-size:25px}.market-grid .empty-result{font-size:11px}.market-grid .market.highlight{background:#fff9eb}
@media(min-width:640px){main{max-width:980px;padding-left:14px;padding-right:14px}.market-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.lucky-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.market-toolbar input{max-width:280px}}
@media(max-width:390px){.market-toolbar{align-items:stretch;flex-direction:column}.market-toolbar input{max-width:100%}.market-grid .market{padding-left:65px;padding-right:65px}.market-grid .market h2{font-size:17px}.market-grid .market-action{font-size:11px;padding:7px 7px}}

</style><script>
function ank(p){if(!/^\\d{3}$/.test(p))return "—";return String([...p].reduce((a,d)=>a+Number(d),0)%10)}
function updatePreview(form){const o=form.querySelector('[name="openPanna"]').value,c=form.querySelector('[name="closePanna"]').value;const oa=ank(o),ca=ank(c);const open=form.querySelector('[data-preview="open"]'),jodi=form.querySelector('[data-preview="jodi"]'),close=form.querySelector('[data-preview="close"]');if(open)open.textContent="Open Ank: "+oa;if(jodi)jodi.textContent="Jodi: "+(oa!=="—"&&ca!=="—"?oa+ca:"—");if(close)close.textContent="Close Ank: "+ca}
</script></head><body><header><a class="brand-link" href="/login" aria-label="Admin Login"><div class="brand">DPBOSS</div><div class="tag">FAST MARKET RESULT & CHART</div></a></header><nav><a href="/">HOME</a>${admin ? '<a href="/admin">Dashboard</a><a href="/admin/api">API Sync</a><a href="/admin/logs">Change Log</a><a href="/admin/backup">Backup</a><a href="/jodi">JODI CHART</a><a href="/panel">PANEL CHART</a><a href="/history">HISTORY</a><form method="post" action="/logout" class="inline"><button style="padding:5px 9px">Logout</button></form>' : '<a href="/jodi">JODI CHART</a><a href="/panel">PANEL CHART</a><a href="/history">HISTORY</a>'}</nav><main>${content}</main><footer>DPBOSS · Market results and charts</footer></body></html>`;
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
    return `<section class="market ${isHighlight ? "highlight" : ""}"><a class="market-action left" href="/five-year-chart?mode=jodi&market=${encodeURIComponent(m.id)}">Jodi</a><a class="market-action right" href="/five-year-chart?mode=panel&market=${encodeURIComponent(m.id)}">Panel</a><h2>${esc(chartMarketName(m.name))}</h2><div class="result-line">${esc(result)}</div><div class="market-times"><span>${esc(formatTime(m.openTime))}</span><span>${esc(formatTime(m.closeTime))}</span></div>${latest ? `<div class="muted" style="font-size:10px;margin-top:3px">${esc(latest.date)}</div>` : `<div class="empty-result">Result will be available soon</div>`}</section>`;
  }
  return `<section class="market"><h2>${esc(chartMarketName(m.name))}</h2><div class="meta"><span>Open: <b>${esc(m.openTime)}</b></span><span>Close: <b>${esc(m.closeTime)}</b></span></div>${rows.length ? `<div class="table-wrap"><table class="history-table"><thead><tr><th>Date</th><th>Open Panna</th><th>Open Ank</th><th>Jodi</th><th>Close Panna</th><th>Close Ank</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td class="num">${esc(openIsPublished(r) ? r.openPanna : "—")}</td><td class="num">${esc(openIsPublished(r) ? (r.openAnk ?? pannaAnk(r.openPanna)) : "—")}</td><td class="num">${esc(resultIsComplete(r) ? resultJodi(r) : "—")}</td><td class="num">${esc(closeIsPublished(r) ? r.closePanna : "—")}</td><td class="num">${esc(closeIsPublished(r) ? (r.closeAnk ?? pannaAnk(r.closePanna)) : "—")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No matching published results.</p>'}</section>`;
}
function formatTime(value) { const [h,m] = String(value || "00:00").split(":").map(Number); const suffix = h >= 12 ? "PM" : "AM"; const hour = h % 12 || 12; return `${hour}:${String(m).padStart(2,"0")} ${suffix}`; }

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.urlencoded({ extended: false, limit: "3mb" }));
app.use(session({ name:"dpboss.sid", secret:process.env.SESSION_SECRET, resave:false, saveUninitialized:false,
  cookie:{ httpOnly:true, sameSite:"strict", secure: process.env.NODE_ENV === "production", maxAge:2*60*60*1000 } }));

app.get("/", (req,res) => {
  const s = readStore();
  const today = localDateISO();
  const allResults = s.markets.flatMap(m => m.results.filter(r => resultIsVisible(r) && validDate(r.date) && r.date <= today).map(r => ({...r, marketName:m.name, marketId:m.id})));
  const todayResults = allResults.filter(r => r.date === today).sort((a,b) => a.marketName.localeCompare(b.marketName));
  const latest = allResults.sort((a,b) => b.date.localeCompare(a.date))[0];
  const dateLabel = new Intl.DateTimeFormat("en-IN", { timeZone:"Asia/Kolkata", day:"2-digit", month:"long", year:"numeric" }).format(new Date());
  const finalAnks = todayResults.filter(resultIsComplete).map(r => `<span class="lucky-chip"><b>${esc(chartMarketName(r.marketName))}</b><strong>${esc(pannaAnk(r.openPanna))} · ${esc(pannaAnk(r.closePanna))}</strong></span>`).join("");
  const lucky = `<section class="home-lucky"><div class="section-kicker">TODAY'S PUBLISHED RESULTS</div><h2>Today Lucky Number</h2><p class="home-date">${esc(dateLabel)}</p>${finalAnks ? `<div class="lucky-grid">${finalAnks}</div>` : `<p class="muted">No complete results have been published for today yet.</p>`}</section>`;
  const latestBlock = latest ? `<section class="live-panel"><div><span class="live-dot"></span><b> LATEST PUBLISHED RESULT</b></div><div class="live-market">${esc(chartMarketName(latest.marketName))}</div><div class="live-result">${resultIsComplete(latest) ? `${esc(latest.openPanna)} - ${esc(resultJodi(latest))} - ${esc(latest.closePanna)}` : "Partially published"}</div><div class="live-meta">${esc(shortDate(latest.date))} · ${latest.source === "matkaapi" ? "API update" : "Admin published"}</div><a class="home-link" href="/history?market=${encodeURIComponent(latest.marketId)}&q=${encodeURIComponent(latest.date)}">VIEW RESULT HISTORY</a></section>` : `<section class="live-panel"><div class="section-kicker">LATEST RESULT</div><h2>Results will appear here</h2><p class="muted">No published result is available yet. Connect the market API or publish a verified result from Admin.</p></section>`;
  const board = s.markets.map(m=>marketCard(m)).join("") || '<section class="panel">No markets available. Sign in to Admin and sync the market list.</section>';
  const search = `<section class="market-toolbar"><div><h2>Market Results</h2><p>Market-wise latest published results and charts</p></div><input id="marketSearch" type="search" placeholder="Search market name..." aria-label="Search market"></section>`;
  const script = `<script>document.addEventListener('DOMContentLoaded',()=>{const input=document.getElementById('marketSearch');if(input)input.addEventListener('input',()=>{const q=input.value.toLowerCase();document.querySelectorAll('.market').forEach(card=>{card.style.display=card.innerText.toLowerCase().includes(q)?'':'none';});});});</script>`;
  const intro = `<section class="home-hero"><div class="hero-kicker">FAST MARKET RESULT & CHART</div><h1>DPBOSS MARKET RESULT</h1><p>Latest market updates · Jodi chart · Panel chart · Date-wise history</p><div class="hero-actions"><a href="/jodi">JODI CHART</a><a href="/panel">PANEL CHART</a><a href="/history">RESULT HISTORY</a></div></section>`;
  const count = `<div class="market-count"><b>${s.markets.length}</b> markets listed <span>·</span> <b>${todayResults.length}</b> results published today</div>`;
  res.send(page("Market Result", intro + lucky + latestBlock + count + search + `<div class="market-grid">${board}</div>` + '<div class="bottom-nav"><a href="/history">HISTORY</a><button type="button" onclick="location.reload()">REFRESH</button></div>' + script));
});

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
    const endDate = new Date(startDate); endDate.setUTCDate(endDate.getUTCDate()+5);
    const dateLabel = `${shortDate(start)} – ${shortDate(isoDate(endDate))}`;
    const cells = dayNames.map((_,idx) => {
      const day = new Date(startDate); day.setUTCDate(day.getUTCDate()+idx);
      const date = isoDate(day), r = resultByDate.get(date);
      if (!r) return `<td><span class="blank-day">—</span></td>`;
      const value = resultJodi(r), isLatest = latest && r.date === latest.date;
      return `<td><a class="jodi-cell${isLatest ? " latest" : ""}" href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}" title="${shortDate(r.date)}">${esc(value)}</a></td>`;
    }).join("");
    return `<tr><td class="date-range">${dateLabel}</td>${cells}</tr>`;
  }).join("");
  const sunday = published.filter(r => dateParts(r.date).date.getUTCDay() === 0);
  const sundayBlock = sunday.length ? `<div class="sunday-list"><strong>Sunday results:</strong> ${sunday.map(r=>`<a href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}">${shortDate(r.date)} · ${esc(resultJodi(r))}</a>`).join(" · ")}</div>` : "";
  const body = rows ? `<div class="chart-table-wrap"><table class="chart-table jodi-table"><colgroup><col class="date-col">${dayNames.map(()=>'<col class="day-col">').join("")}</colgroup><thead><tr><th>Date</th>${dayNames.map(d=>`<th>${d}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>${sundayBlock}<p class="chart-note">Only saved, published results are shown. Tap a number to open its result details.</p>` : `<div class="chart-empty">No published results are available for this market yet.</div>`;
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

app.get("/five-year-chart", (req,res) => {
  const store = readStore();
  const mode = String(req.query.mode || "jodi") === "panel" ? "panel" : "jodi";
  res.send(page("Market Charts", marketChooser(store, mode)));
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

function adminSavedResults(m) {
 const results=[...m.results].filter(r=>validDate(r.date)).sort((a,b)=>b.date.localeCompare(a.date));
 if(!results.length) return '<p class="muted">No saved results for this market yet.</p>';
 return `<h3>Saved Results — Edit Any Date</h3><p class="muted">Change the date’s Open/Close Panna, then press Update Result. The Jodi is recalculated automatically.</p>${results.map(r=>`<form method="post" action="/admin/result" class="panel" style="padding:12px;margin:10px 0;background:#fff9ed"><input type="hidden" name="marketId" value="${esc(m.id)}"><label>Date</label><input type="date" name="date" value="${esc(r.date)}" max="${localDateISO()}" required><div class="row"><div><label>Open Panna</label><input name="openPanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" value="${esc(r.openPanna||'')}" required></div><div><label>Close Panna</label><input name="closePanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" value="${esc(r.closePanna||'')}" required></div></div><p class="muted">Current: ${esc(r.openPanna||'—')} · ${esc(r.jodi||'—')} · ${esc(r.closePanna||'—')} · ${resultIsVisible(r)?'Published':'Unpublished'}</p><button name="action" value="publish">Update Result</button></form>`).join('')}`;
}

app.get("/admin",adminOnly,(req,res)=>{
 const s=readStore(), total=s.markets.reduce((n,m)=>n+m.results.length,0), published=s.markets.reduce((n,m)=>n+m.results.filter(r=>resultIsVisible(r)).length,0), drafts=total-published;
 const add=`<section class="panel"><h2>Add Your Own Market</h2><form method="post" action="/admin/market/add"><label>Market name</label><input name="name" required maxlength="60" placeholder="e.g. My New Market"><div class="row"><div><label>Open time</label><input type="time" name="openTime" value="15:00" required></div><div><label>Close time</label><input type="time" name="closeTime" value="18:00" required></div><div style="display:flex;align-items:end"><button style="margin-bottom:12px;width:100%">Add Market</button></div></div></form></section>`;
 const cards=s.markets.map(m=>`<section class="panel"><h2>${esc(chartMarketName(m.name))}</h2><p class="muted">Open ${esc(m.openTime)} · Close ${esc(m.closeTime)} · ${m.results.length} saved result(s)</p><form method="post" action="/admin/market/update"><input type="hidden" name="id" value="${esc(m.id)}"><div class="row"><div><label>Market name</label><input name="name" value="${esc(chartMarketName(m.name))}" required maxlength="60"></div><div><label>Open time</label><input type="time" name="openTime" value="${esc(m.openTime)}" required></div><div><label>Close time</label><input type="time" name="closeTime" value="${esc(m.closeTime)}" required></div></div><button>Save Market Details</button></form><hr style="border:0;border-top:1px solid #eee3cd;margin:18px 0"><h3>Result Management</h3><form method="post" action="/admin/result"><input type="hidden" name="marketId" value="${esc(m.id)}"><label>Result date</label><input type="date" name="date" value="${localDateISO()}" max="${localDateISO()}" required><div class="row"><div><label>Open Panna (any 3 digits)</label><input name="openPanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" placeholder="119" oninput="updatePreview(this.form)"></div><div><label>Close Panna (any 3 digits)</label><input name="closePanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" placeholder="169" oninput="updatePreview(this.form)"></div></div><div class="stat" style="margin:8px 0 14px"><span>Result preview</span><strong data-preview="open">Open Ank: —</strong><strong data-preview="jodi">Jodi: —</strong><strong data-preview="close">Close Ank: —</strong><p class="muted">Publish Open after its result is ready, then publish Close later for the same date.</p></div><button name="action" value="publish-open">Publish Open Only</button> <button name="action" value="publish-close">Publish Close Only</button> <button name="action" value="publish">Publish Both</button></form>${adminSavedResults(m)}<form method="post" action="/admin/market/delete" onsubmit="return confirm('Delete this market and all its results?')" style="margin-top:14px"><input type="hidden" name="id" value="${esc(m.id)}"><button class="danger">Delete Market</button></form></section>`).join("");
 res.send(page("Admin Dashboard",`${flash(req)}<section class="panel"><h2>Admin Dashboard</h2><div class="stats"><div class="stat"><span>Markets</span><strong>${s.markets.length}</strong></div><div class="stat"><span>Published results</span><strong>${published}</strong></div><div class="stat"><span>Draft / unpublished</span><strong>${drafts}</strong></div></div></section>${add}${cards}` ,true));
});
app.post("/admin/market/add",adminOnly,(req,res)=>{const name=String(req.body.name||"").trim(),openTime=String(req.body.openTime||""),closeTime=String(req.body.closeTime||"");if(!name||name.length>60||!validTime(openTime)||!validTime(closeTime)){req.session.flash="Enter a market name and valid times.";return res.redirect("/admin");}const s=readStore(),m={id:"market-"+s.nextId++,name,openTime,closeTime,results:[]};s.markets.push(m);logAction(s,"Market added",name);writeStore(s);req.session.flash="Market added.";res.redirect("/admin");});
app.post("/admin/market/update",adminOnly,(req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.id),name=String(req.body.name||"").trim(),openTime=String(req.body.openTime||""),closeTime=String(req.body.closeTime||"");if(!m||!name||name.length>60||!validTime(openTime)||!validTime(closeTime)){req.session.flash="Could not update market; check the values.";return res.redirect("/admin");}const before=m.name;m.name=name;m.openTime=openTime;m.closeTime=closeTime;logAction(s,"Market updated",`${before} → ${name} (${openTime}-${closeTime})`);writeStore(s);req.session.flash="Market details updated.";res.redirect("/admin");});
app.post("/admin/market/delete",adminOnly,(req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.id);if(m){s.markets=s.markets.filter(x=>x.id!==req.body.id);logAction(s,"Market deleted",m.name);writeStore(s);}req.session.flash="Market deleted.";res.redirect("/admin");});
app.post("/admin/result",adminOnly,(req,res)=>{
  const s=readStore(),m=s.markets.find(x=>x.id===req.body.marketId),date=String(req.body.date||""),action=String(req.body.action||"");
  const old=m&&m.results.find(r=>r.date===date);
  if(!m||!validDate(date)){req.session.flash="Choose a valid market and date.";return res.redirect("/admin");}
  if(date>localDateISO()){req.session.flash="Future-dated results are not allowed. Choose today or an earlier date.";return res.redirect("/admin");}
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

// MatkaAPI integration: credentials stay server-side in environment variables.
const MAPI_BASE = "https://www.matkaapi.com/mapi/market_api.php";
function apiSlug(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
async function matkaApi(params) {
  if (!process.env.MATKA_API_KEY || !process.env.MATKA_API_DOMAIN) throw new Error("MatkaAPI settings are missing. Configure MATKA_API_KEY and MATKA_API_DOMAIN in the server environment.");
  const url = new URL(MAPI_BASE);
  for (const [k,v] of Object.entries({...params, domain_key:process.env.MATKA_API_KEY, domain:process.env.MATKA_API_DOMAIN})) url.searchParams.set(k, String(v));
  const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === false) throw new Error(body.message || `MatkaAPI request failed (${response.status})`);
  return body;
}
function parseApiResult(row, date) {
  const raw = String(row.result || "").trim();
  const match = raw.match(/^(\d{3})\s*[-–]\s*\d{2}\s*[-–]\s*(\d{3})$/);
  if (!match) return null;
  const openPanna = match[1], closePanna = match[2];
  const openAnk = pannaAnk(openPanna), closeAnk = pannaAnk(closePanna);
  return { date, openPanna, openAnk, jodi: openAnk + closeAnk, closePanna, closeAnk, published:true, openPublished:true, closePublished:true, source:"matkaapi", updatedAt:new Date().toISOString() };
}
app.get("/admin/api", adminOnly, (req,res) => {
  const configured = Boolean(process.env.MATKA_API_KEY && process.env.MATKA_API_DOMAIN);
  res.send(page("MatkaAPI Integration", `${flash(req)}<section class="panel"><h2>Market API Integration</h2><p>${configured ? "API credentials are configured on the server." : "API credentials are not configured yet."}</p><p class="muted">Market list and today's results are fetched securely from the server. Existing manual admin editing remains available.</p><form method="post" action="/admin/api/sync"><button>Fetch / Update Market List</button></form><hr style="border:0;border-top:1px solid #eee3cd;margin:18px 0"><h3>Fetch one market result</h3><form method="post" action="/admin/api/result"><label>Market API slug (example: mainbazar)</label><input name="market" required maxlength="80" placeholder="mainbazar"><button>Fetch Today’s Result</button></form></section>`, true));
});
app.post("/admin/api/sync", adminOnly, async (req,res) => {
  try {
    const list = await matkaApi({ market_list: 1 });
    const rows = Array.isArray(list.data) ? list.data : [];
    if (!rows.length) throw new Error(list.message || "API returned an empty market list.");
    const store = readStore(); let imported = 0, updated = 0, skipped = 0;
    for (const item of rows) {
      const name = String(item.name || "").trim(); if (!name) { skipped++; continue; }
      const slug = apiSlug(name);
      let market = store.markets.find(m => m.apiSlug === slug || apiSlug(m.name) === slug);
      if (!market) {
        const toMinutes = value => { const m=String(value||"").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if(!m)return "15:00"; let h=Number(m[1])%12; if((m[3]||"").toUpperCase()==="PM")h+=12; return `${String(h).padStart(2,"0")}:${m[2]}`; };
        market = { id: `api-${slug}`, apiSlug:slug, name, openTime:toMinutes(item.open_time), closeTime:toMinutes(item.close_time), results:[] };
        store.markets.push(market); imported++;
      } else { market.apiSlug=slug; market.name=name; updated++; }
      if (validTime(toMinutesSafe(item.open_time))) market.openTime=toMinutesSafe(item.open_time);
      if (validTime(toMinutesSafe(item.close_time))) market.closeTime=toMinutesSafe(item.close_time);
    }
    logAction(store,"MatkaAPI sync",`${imported} market(s) added, ${updated} updated, ${skipped} row(s) skipped`);
    writeStore(store); req.session.flash=`API sync complete: ${imported} market(s) added, ${updated} updated. Check results on the board.`;
    res.redirect("/admin/api");
  } catch (e) { req.session.flash=`API sync failed: ${e.message}`; res.redirect("/admin/api"); }
});
function toMinutesSafe(value) { const m=String(value||"").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if(!m)return ""; let h=Number(m[1])%12; if((m[3]||"").toUpperCase()==="PM")h+=12; return `${String(h).padStart(2,"0")}:${m[2]}`; }

app.post("/admin/api/result", adminOnly, async (req,res) => {
  try {
    const slug=String(req.body.market||"").trim().toLowerCase();
    if(!/^[a-z0-9_-]{2,80}$/.test(slug)) throw new Error("Enter a valid market API slug.");
    const body=await matkaApi({market:slug}); const rows=Array.isArray(body.data)?body.data:[];
    const store=readStore(); let saved=0;
    for(const row of rows){
      const date=String(row.date||body.date||localDateISO()); if(!validDate(date)||date>localDateISO()) continue;
      const entry=parseApiResult(row,date); if(!entry) continue;
      const name=String(row.name||body.market||slug).trim();
      let market=store.markets.find(m=>m.apiSlug===slug||apiSlug(m.name)===slug);
      if(!market){market={id:`api-${slug}`,apiSlug:slug,name,openTime:"15:00",closeTime:"18:00",results:[]};store.markets.push(market);}
      const idx=market.results.findIndex(r=>r.date===date); if(idx>=0)market.results[idx]=entry;else market.results.push(entry); saved++;
    }
    if(!saved) throw new Error("API returned no complete result in Open-Jodi-Close format for today.");
    logAction(store,"MatkaAPI result imported",`${slug} · ${saved} result(s)`);writeStore(store);
    req.session.flash=`Imported ${saved} result(s) for ${slug}.`;res.redirect("/admin/api");
  }catch(e){req.session.flash=`Result fetch failed: ${e.message}`;res.redirect("/admin/api");}
});

// Automatic read-only result refresh. Provider docs specify a 10-second minimum
// gap for identical requests; poll at 60-second intervals to stay conservative.
let apiAutoSyncRunning = false;
async function autoSyncMarketApi() {
  if (apiAutoSyncRunning || !process.env.MATKA_API_KEY || !process.env.MATKA_API_DOMAIN) return;
  apiAutoSyncRunning = true;
  try {
    const list = await matkaApi({ market_list: 1 });
    const marketRows = Array.isArray(list.data) ? list.data : [];
    const store = readStore();
    for (const item of marketRows) {
      const name = String(item.name || "").trim();
      if (!name) continue;
      const slug = apiSlug(name);
      let market = store.markets.find(m => m.apiSlug === slug || apiSlug(m.name) === slug);
      if (!market) {
        market = { id: `api-${slug}`, apiSlug: slug, name,
          openTime: toMinutesSafe(item.open_time) || "15:00",
          closeTime: toMinutesSafe(item.close_time) || "18:00", results: [] };
        store.markets.push(market);
      } else {
        market.apiSlug = slug;
        if (toMinutesSafe(item.open_time)) market.openTime = toMinutesSafe(item.open_time);
        if (toMinutesSafe(item.close_time)) market.closeTime = toMinutesSafe(item.close_time);
      }
    }
    const all = await matkaApi({ market: "all" });
    const rows = Array.isArray(all.data) ? all.data : [];
    let saved = 0;
    for (const row of rows) {
      const slug = apiSlug(row.name || row.market || "");
      const date = String(row.date || all.date || localDateISO());
      if (!slug || !validDate(date) || date > localDateISO()) continue;
      const entry = parseApiResult(row, date);
      if (!entry) continue;
      let market = store.markets.find(m => m.apiSlug === slug || apiSlug(m.name) === slug);
      if (!market) {
        market = { id: `api-${slug}`, apiSlug: slug, name: String(row.name || slug), openTime: "15:00", closeTime: "18:00", results: [] };
        store.markets.push(market);
      }
      const idx = market.results.findIndex(r => r.date === date);
      // Preserve admin-entered data; only refresh records originally imported from the API.
      if (idx >= 0 && market.results[idx].source !== "matkaapi") continue;
      if (idx >= 0) market.results[idx] = entry; else market.results.push(entry);
      saved++;
    }
    logAction(store, "Automatic MatkaAPI refresh", `${saved} API result(s) updated`);
    writeStore(store);
    console.log(`MatkaAPI automatic refresh complete: ${saved} result(s)`);
  } catch (e) {
    console.error(`MatkaAPI automatic refresh failed: ${e.message}`);
  } finally {
    apiAutoSyncRunning = false;
  }
}

app.get("/admin/logs",adminOnly,(req,res)=>{const s=readStore();const rows=s.logs.slice(0,200);res.send(page("Change Log",`<section class="panel"><h2>Recent Admin Changes</h2><p class="muted">Latest 200 actions; log is stored locally with the result data.</p>${rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.at.replace("T"," ").slice(0,19))}</td><td>${esc(x.action)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div>`:'<p>No changes logged yet.</p>'}</section>`,true));});
app.get("/admin/backup",adminOnly,(req,res)=>{res.send(page("Backup & Restore",`${flash(req)}<section class="panel"><h2>Backup & Restore</h2><p>Download a copy of your markets, results and change log. Keep the file private.</p><a class="btn" href="/admin/backup/download">Download JSON Backup</a><hr style="border:0;border-top:1px solid #eee3cd;margin:20px 0"><h3>Restore from backup</h3><p class="muted">Restore replaces current local data. Download a backup first. Only restore a JSON backup created by this app.</p><form method="post" action="/admin/backup/restore" enctype="multipart/form-data"><label>Select backup JSON file (max 2 MB)</label><input type="file" name="backup" accept=".json,application/json" required><button class="danger">Restore Backup</button></form></section>`,true));});
app.get("/admin/backup/download",adminOnly,(req,res)=>{res.setHeader("Content-Type","application/json");res.setHeader("Content-Disposition",`attachment; filename="dpboss-backup-${new Date().toISOString().slice(0,10)}.json"`);res.send(JSON.stringify(readStore(),null,2));});
app.post("/admin/backup/restore",adminOnly,upload.single("backup"),(req,res)=>{try{if(!req.file)throw Error("Choose a backup file.");const s=JSON.parse(req.file.buffer.toString("utf8"));if(!s||!Array.isArray(s.markets)||!Number.isInteger(s.nextId)||!Array.isArray(s.logs))throw Error("File is not a valid DPBOSS backup.");for(const m of s.markets){if(!m.id||!m.name||!validTime(m.openTime)||!validTime(m.closeTime)||!Array.isArray(m.results))throw Error("Backup market data is invalid.");for(const r of m.results){if(!validDate(r.date)||!validPanna(r.openPanna)||!validPanna(r.closePanna)||typeof r.published!=="boolean")throw Error("Backup result data is invalid.");}}logAction(s,"Backup restored","Data restored from uploaded JSON backup");writeStore(s);req.session.flash="Backup restored successfully.";res.redirect("/admin/backup");}catch(e){req.session.flash="Restore failed: "+e.message;res.redirect("/admin/backup");}});
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError){req.session.flash="Upload failed: file must be under 2 MB.";return res.redirect("/admin/backup");}console.error(err);res.status(500).send("Server error. Check the Termux terminal.");});
app.listen(PORT,"0.0.0.0",()=>{ console.log(`DPBOSS listening on port ${PORT}`); if (process.env.MATKA_API_KEY && process.env.MATKA_API_DOMAIN) { autoSyncMarketApi(); setInterval(autoSyncMarketApi, 60000); } });
