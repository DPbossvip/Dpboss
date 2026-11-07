require("dotenv").config();
const express = require("express");
const session = require("express-session");
const helmet = require("helmet");
const multer = require("multer");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 5000);
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


const { MongoClient } = require("mongodb");
const MONGODB_URI = String(process.env.MONGODB_URI || "").trim();
let mongoDb = null;
let mongoWriteQueue = Promise.resolve();
let cachedStore = null;

function normalizeStore(s) {
  if (!Array.isArray(s.markets)) s.markets = [];
  if (!Array.isArray(s.logs)) s.logs = [];
    s.whatsappPlayLink = String(s.whatsappPlayLink || "");
  if (!Number.isInteger(s.nextId)) s.nextId = 1;
  s.markets.forEach(m => { if (!Array.isArray(m.results)) m.results = []; });
  return s;
}

function readStore() {
  if (cachedStore) return cachedStore;
  try {
    return normalizeStore(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (err) {
    console.error(`Unable to read ${DATA_FILE}. The existing file has been left untouched.`, err.message);
    throw new Error("The saved data file could not be read. Check data/store.json before making changes; the app will not replace it automatically.");
  }
}

function persistStoreToMongo(snapshot) {
  if (!mongoDb) return Promise.resolve();
  const markets = snapshot.markets.map(m => ({
    _id: String(m.id),
    name: m.name,
    openTime: m.openTime,
    closeTime: m.closeTime,
    ...(m.apiSlug ? { apiSlug: m.apiSlug } : {})
  }));
  const results = [];
  for (const m of snapshot.markets) {
    for (const r of (m.results || [])) {
      results.push({ _id: `${m.id}::${r.date}`, marketId: String(m.id), ...r });
    }
  }
  const state = { _id: "main", nextId: snapshot.nextId, logs: snapshot.logs || [], whatsappPlayLink: String(snapshot.whatsappPlayLink || "") };

  const run = async () => {
    const marketCol = mongoDb.collection("markets");
    const resultCol = mongoDb.collection("daily_results");
    const stateCol = mongoDb.collection("app_state");
    if (markets.length) await marketCol.bulkWrite(markets.map(doc => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
    })), { ordered: true });
    if (results.length) await resultCol.bulkWrite(results.map(doc => ({
      replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true }
    })), { ordered: true });
    await stateCol.replaceOne({ _id: "main" }, state, { upsert: true });
    const marketIds = markets.map(x => x._id);
    const resultIds = results.map(x => x._id);
    await marketCol.deleteMany({ _id: { $nin: marketIds } });
    await resultCol.deleteMany({ _id: { $nin: resultIds } });
  };
  mongoWriteQueue = mongoWriteQueue.catch(() => {}).then(run);
  return mongoWriteQueue;
}

async function writeStore(s) {
  const normalized = normalizeStore(s);
  cachedStore = normalized;
  if (mongoDb) {
    try {
      await persistStoreToMongo(JSON.parse(JSON.stringify(normalized)));
      return true;
    } catch (err) {
      console.error("MongoDB persistence failed:", err.message);
      return false;
    }
  }
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  try {
    fs.renameSync(tmp, DATA_FILE);
    return true;
  } catch (err) {
    console.error("Local storage persistence failed:", err.message);
    return false;
  }
}

async function initializeDatabase() {
  if (!MONGODB_URI) {
    cachedStore = readStore();
    console.log("Storage mode: local JSON file (MONGODB_URI not configured).");
    return;
  }
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  mongoDb = client.db(process.env.MONGODB_DATABASE || "dpboss");
  const marketCol = mongoDb.collection("markets");
  const resultCol = mongoDb.collection("daily_results");
  await resultCol.createIndex({ marketId: 1, date: 1 }, { unique: true });
  await resultCol.createIndex({ date: -1 });
  await marketCol.createIndex({ name: 1 });
  // Add missing local markets/results without overwriting existing MongoDB records.
  const legacy = readStore();
  // Include deployable market metadata without shipping local result history.
  const seedPath = path.join(__dirname, "data", "markets-seed.json");
  if (fs.existsSync(seedPath)) {
    const seedMarkets = JSON.parse(fs.readFileSync(seedPath, "utf8"));
    const merged = new Map(legacy.markets.map(m => [String(m.id), m]));
    for (const m of seedMarkets) {
      if (!merged.has(String(m.id))) merged.set(String(m.id), { ...m, results: [] });
    }
    legacy.markets = Array.from(merged.values());
  }
  const existingMarkets = await marketCol.find({}).toArray();
  const byId = new Map(existingMarkets.map(m => [String(m._id), m]));
  const byName = new Map(existingMarkets.map(m => [String(m.name || "").trim().toLowerCase(), m]));

  for (const m of legacy.markets) {
    const localId = String(m.id);
    const nameKey = String(m.name || "").trim().toLowerCase();
    let existing = byId.get(localId) || byName.get(nameKey);
    const targetId = existing ? String(existing._id) : localId;

    if (!existing) {
      const marketDoc = {
        _id: targetId,
        name: m.name,
        openTime: m.openTime,
        closeTime: m.closeTime,
        ...(m.apiSlug ? { apiSlug: m.apiSlug } : {})
      };
      await marketCol.updateOne(
        { _id: targetId },
        { $setOnInsert: marketDoc },
        { upsert: true }
      );
      existing = marketDoc;
      byId.set(targetId, existing);
      byName.set(nameKey, existing);
    }

    for (const r of (m.results || [])) {
      if (!r || typeof r.date !== "string") continue;
      const resultDoc = {
        _id: targetId + "::" + r.date,
        marketId: targetId,
        ...r
      };
      await resultCol.updateOne(
        { marketId: targetId, date: r.date },
        { $setOnInsert: resultDoc },
        { upsert: true }
      );
    }
  }

  const stateCol = mongoDb.collection("app_state");
  const allIds = [
    ...existingMarkets.map(m => String(m._id)),
    ...legacy.markets.map(m => String(m.id))
  ];
  const nextIdFloor = Math.max(
    Number(legacy.nextId) || 1,
    1,
    ...allIds.map(id => {
      const match = /^market-(\d+)$/.exec(id);
      return match ? Number(match[1]) + 1 : 1;
    })
  );

  await stateCol.updateOne(
    { _id: "main" },
    {
      $max: { nextId: nextIdFloor },
      $setOnInsert: { _id: "main", logs: legacy.logs || [] }
    },
    { upsert: true }
  );

  const [marketDocs, resultDocs, state] = await Promise.all([
    marketCol.find({}).toArray(),
    resultCol.find({}).toArray(),
    stateCol.findOne({ _id: "main" })
  ]);

  const byMarket = new Map();
  for (const doc of resultDocs) {
    const item = { ...doc };
    delete item._id;
    delete item.marketId;
    if (!byMarket.has(String(doc.marketId))) byMarket.set(String(doc.marketId), []);
    byMarket.get(String(doc.marketId)).push(item);
  }

  cachedStore = normalizeStore({
    markets: marketDocs.map(doc => ({
      id: String(doc._id),
      name: doc.name,
      openTime: doc.openTime,
      closeTime: doc.closeTime,
      ...(doc.apiSlug ? { apiSlug: doc.apiSlug } : {}),
      results: byMarket.get(String(doc._id)) || []
    })),
    nextId: Number.isInteger(state?.nextId) ? state.nextId : legacy.nextId,
    logs: Array.isArray(state?.logs) ? state.logs : (legacy.logs || []),
    whatsappPlayLink: String(state?.whatsappPlayLink || legacy.whatsappPlayLink || "")
  });

  console.log("MongoDB additive sync complete: " + marketDocs.length + " market(s), " + resultDocs.length + " daily result(s).");
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
const HOME_CSS = String.raw`
body.home-page{background:#ffc994;color:#171717}
body.home-page header{background:#ffd0a1;border:3px solid #ed1b2f;border-radius:18px;margin:8px 10px 10px;padding:17px 8px}
body.home-page .brand{font-size:clamp(38px,10vw,58px);letter-spacing:-2px}
body.home-page .tag{display:none}
body.home-page main{max-width:900px;padding:0 10px 75px;margin:8px auto}
body.home-page .welcome-card,body.home-page .description-card,body.home-page .home-lucky,body.home-page .live-panel,body.home-page .market-toolbar{background:#ffd0a1;border:3px solid #ed1b2f;border-radius:17px;margin:9px 0;padding:14px;box-shadow:0 3px 0 rgba(150,35,35,.12)}
body.home-page .welcome-card{min-height:105px;display:flex;align-items:center;justify-content:center;gap:14px;text-align:center}
body.home-page .welcome-mark{font-size:42px}
body.home-page .welcome-copy{font-size:clamp(17px,4.5vw,25px);font-weight:900;line-height:1.25}
body.home-page .description-card{text-align:center;font-size:clamp(14px,3.7vw,19px);font-weight:700;line-height:1.35}
body.home-page .description-card strong{color:#183d70}
body.home-page .home-lucky{text-align:center}
body.home-page .home-lucky h2,body.home-page .live-panel>div:first-child,body.home-page .market-toolbar h2{background:#f000a0;color:white;border:2px solid white;border-radius:30px;padding:9px 8px;font-size:clamp(18px,5vw,27px);font-weight:900;margin:0 0 10px}
body.home-page .home-date{font-size:12px;font-weight:700}
body.home-page .lucky-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
body.home-page .lucky-column{padding:8px;border-right:2px solid #ed1b2f}
body.home-page .lucky-column:last-child{border:0}
body.home-page .lucky-label{font-size:clamp(17px,4.5vw,24px);font-weight:900;color:#173d78}
body.home-page .lucky-values{font-size:clamp(23px,6vw,34px);font-weight:900;color:#173d78}
body.home-page .lucky-values small{display:block;font-size:10px;color:#4c392e;font-weight:600}
body.home-page .live-panel{border-left:3px solid #ed1b2f;text-align:center}
body.home-page .live-market{font-size:clamp(20px,5vw,28px);color:#173d78}
body.home-page .live-result{font-size:clamp(28px,7vw,40px);color:#85205a}
body.home-page .home-link{display:inline-block;background:#50329b;color:white;border-radius:9px;padding:9px 16px;font-weight:800;text-decoration:none}
body.home-page .market-toolbar{display:block;text-align:center}
body.home-page .market-toolbar h2{margin:0 0 8px}
body.home-page .market-toolbar p{font-weight:700}
body.home-page .market-toolbar input{max-width:100%;width:100%;min-height:45px;border:2px solid #ed1b2f;border-radius:10px;padding:10px}
body.home-page .market-grid{border:3px solid #ed1b2f;border-radius:16px;overflow:hidden;gap:0;background:#ffd0a1}
body.home-page .market-grid .market{border:0;border-bottom:2px solid #ed1b2f;border-radius:0;min-height:125px;padding:15px 65px 12px;background:#ffd0a1}
body.home-page .market-grid .market:first-child,body.home-page .market-grid .market:nth-child(8n){background:#fff500}
body.home-page .market-grid .market h2{font-size:clamp(20px,5vw,27px);color:#173d78}
body.home-page .market-grid .result-line{font-size:clamp(25px,6vw,34px);font-weight:900;color:#84205a}
body.home-page .market-grid .market-action{background:#56329b;color:#fff;border-radius:9px;font-weight:800;padding:8px}
body.home-page .bottom-nav{position:fixed;z-index:99;bottom:5px;left:5px;right:5px;display:flex;gap:5px;padding:4px;background:#ffd0a1}
body.home-page .bottom-nav a,body.home-page .bottom-nav button{flex:1;text-align:center;background:#123f9b;color:#fff;border:2px solid white;border-radius:8px;padding:10px 3px;font-weight:900;font-size:12px;text-decoration:none}
body.home-page .play-matka-float{position:fixed;z-index:120;right:16px;bottom:calc(72px + env(safe-area-inset-bottom));display:flex;align-items:center;justify-content:center;gap:9px;min-height:54px;padding:0 21px;border:3px solid #fff;border-radius:999px;background:linear-gradient(135deg,#16a34a,#08752f);color:#fff;font-size:17px;font-weight:1000;text-decoration:none;box-shadow:0 5px 18px #0006,0 0 0 3px #16a34a}
body.home-page .play-matka-float .play-icon{font-size:23px}
@media(max-width:420px){body.home-page .play-matka-float{right:12px;bottom:calc(68px + env(safe-area-inset-bottom));min-height:51px;padding:0 17px;font-size:16px}}

@media(max-width:420px){body.home-page .welcome-card{padding:10px 6px}body.home-page .market-grid .market{padding-left:53px;padding-right:53px;min-height:112px}}
`;
const ADMIN_CSS = String.raw`
.admin-page{background:#f3f6fb;color:#17243a}
.admin-page main{max-width:1100px;margin:24px auto;padding:0 14px}
.admin-page .panel{background:#fff;border:1px solid #e1e8f0;border-radius:16px;padding:20px;margin:0 0 18px;box-shadow:0 5px 18px rgba(25,45,75,.06)}
.admin-page h2{font-size:22px;color:#172b4d;margin:5px 0 16px}
.admin-page h3{font-size:17px;color:#263d5b}
.admin-page .admin-kicker{font-size:11px;font-weight:800;letter-spacing:1.5px;color:#3478c8;margin-bottom:8px}
.admin-page .admin-overview{background:linear-gradient(120deg,#142c4d,#245b91);color:#fff}
.admin-page .admin-overview h2{color:#fff}
.admin-page .admin-overview .admin-kicker{color:#b9d9ff}
.admin-page .stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.admin-page .stat{background:#f4f7fb;border:1px solid #e4ebf3;border-radius:12px;padding:14px}
.admin-page .admin-overview .stat{background:rgba(255,255,255,.12);border-color:rgba(255,255,255,.18);color:#fff}
.admin-page .admin-overview .stat strong{color:#fff}
.admin-page label{display:block;font-weight:700;color:#354966;margin:12px 0 6px}
.admin-page input,.admin-page select{width:100%;min-height:46px;border:1px solid #ccd7e5;border-radius:10px;padding:10px 12px;background:#fff;color:#17243a}
.admin-page button{min-height:46px;border:0;border-radius:10px;padding:11px 18px;background:#2168ad;color:#fff;font-weight:750;cursor:pointer;margin:6px 5px 6px 0}
.admin-page button:hover{filter:brightness(.94)}
.admin-page button.danger{background:#b93845}
.admin-page .row{gap:12px}
.admin-page .admin-market-card{border-top:4px solid #3478c8}
.admin-page .admin-market-card hr{border-color:#e5ebf2!important}
.admin-page .muted{color:#687b92}
@media(max-width:650px){
 .admin-page main{margin:14px auto;padding:0 10px}
 .admin-page .panel{padding:15px;border-radius:13px}
 .admin-page .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
 .admin-page .row{display:flex;flex-direction:column;gap:4px}
 .admin-page button{width:100%;margin:5px 0}
 .admin-page h2{font-size:20px}
}
`;
function page(title, content, admin = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#17120b"><title>${esc(title)} · DPBOSS VIP</title><style>
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
.chooser-head{background:#fff;border:1px solid #e6d4bc;border-top:4px solid var(--orange);padding:15px;margin-bottom:10px}.chooser-head h2{margin:5px 0}.chooser-head p{font-size:13px;color:var(--muted);margin:4px 0 8px}.chooser-head input{margin:5px 0 0}.market-chooser-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.market-pick{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;padding:12px;background:#fff;border:1px solid #e5c9a7;border-left:4px solid var(--orange);color:#172e52;text-decoration:none}.market-pick strong{font-size:13px;overflow-wrap:anywhere}.market-pick span{flex:none;font-size:10px;font-weight:800;color:#a52a25}.market-pick[hidden]{display:none}
@media(max-width:560px){.market-chooser-grid{grid-template-columns:1fr}.market-pick{padding:11px}.market-pick strong{font-size:12px}}
@media(min-width:640px){.market-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* DPBOSS-inspired responsive result-board refinement */
.home-hero{background:linear-gradient(135deg,#10294f,#1b4776);color:#fff;border:1px solid #0c2343;border-top:5px solid var(--orange);padding:20px 14px;text-align:center;margin:0 0 12px;box-shadow:0 3px 10px #10294f20}
.home-hero h1{font-size:clamp(23px,6vw,34px);line-height:1.15;margin:7px 0;color:#fff;letter-spacing:.3px}.home-hero p{margin:7px 0 14px;color:#e5edf7;font-size:13px}.hero-kicker,.section-kicker{font-size:11px;font-weight:900;letter-spacing:1.5px;color:#ffbd72}.hero-actions{display:flex;gap:7px;justify-content:center;flex-wrap:wrap}.hero-actions a,.home-link{display:inline-block;background:#f58220;color:#fff;text-decoration:none;font-size:11px;font-weight:900;padding:9px 11px;border-radius:3px}
.home-lucky{background:#fff;border:1px solid #e4bd8f;border-top:4px solid #f58220;padding:13px;margin:0 0 12px;text-align:center;box-shadow:0 2px 5px #0000000b}.home-lucky h2{margin:4px 0;color:#182f55}.home-date{font-size:12px;color:#76624d;margin:4px 0 10px}.section-kicker{color:#a52a25}.lucky-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.lucky-chip{display:flex;justify-content:space-between;align-items:center;gap:5px;background:#fff7ed;border:1px solid #efd7b9;padding:8px;font-size:11px;color:#253b5c}.lucky-chip strong{font-size:15px;color:#a51e28;white-space:nowrap}
.live-panel{background:#fff;border:1px solid #e2c7a4;border-left:5px solid #1c8b55;padding:13px;margin-bottom:12px;text-align:center}.live-panel>div:first-child{font-size:11px;color:#24633e;letter-spacing:.6px}.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#1b9b58;box-shadow:0 0 0 3px #1b9b5820}.live-market{font-size:17px;font-weight:900;color:#a51e28;margin-top:7px}.live-result{font-size:25px;font-weight:900;color:#19375f;margin:5px 0}.live-meta{font-size:11px;color:#75634f;margin-bottom:9px}.market-count{font-size:12px;color:#6d5b48;padding:5px 2px 9px}.market-count b{color:#a51e28}.market-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;background:#fff;border:1px solid #e6d4bc;padding:10px;margin:0 0 9px}.market-toolbar h2{font-size:18px;margin:0;color:#1a3155}.market-toolbar p{font-size:11px;color:#76624d;margin:3px 0 0}.market-toolbar input{max-width:48%;margin:0;padding:9px;font-size:12px}.market-grid{display:grid;grid-template-columns:1fr;gap:8px}.market-grid .market{margin:0;min-height:112px;padding-top:13px;padding-bottom:11px;border-left-width:5px}.market-grid .market h2{font-size:20px}.market-grid .market-action{font-size:12px;padding:8px 9px}.market-grid .result-line{font-size:25px}.market-grid .empty-result{font-size:11px}.market-grid .market.highlight{background:#fff9eb}
@media(min-width:640px){main{max-width:980px;padding-left:14px;padding-right:14px}.market-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.lucky-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.market-toolbar input{max-width:280px}}
@media(max-width:390px){.market-toolbar{align-items:stretch;flex-direction:column}.market-toolbar input{max-width:100%}.market-grid .market{padding-left:65px;padding-right:65px}.market-grid .market h2{font-size:17px}.market-grid .market-action{font-size:11px;padding:7px 7px}}


/* Mobile-first fit: keep all public pages inside the actual device width. */
html,body{width:100%;max-width:100%;overflow-x:hidden}
main{width:100%;min-width:0}
.chart-table-wrap,.table-wrap{width:100%;max-width:100%;overflow-x:auto}
@media(max-width:600px){
  header{padding:10px 7px 8px}.brand{font-size:clamp(27px,8vw,38px)}.tag{font-size:9px;letter-spacing:1px}
  nav{width:100%;justify-content:flex-start;flex-wrap:nowrap;overflow-x:auto;overscroll-behavior-x:contain;-webkit-overflow-scrolling:touch}nav a{flex:0 0 auto;padding:10px 9px;font-size:11px}
  main{padding:7px 5px calc(72px + env(safe-area-inset-bottom))}
  .panel,.home-hero,.home-lucky,.live-panel,.chart-section,.chart-hero{padding:9px;margin-bottom:8px}
  .home-hero h1{font-size:22px}.home-hero p{font-size:11px}.hero-actions a,.home-link{padding:8px;font-size:10px}
  .lucky-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:4px}.lucky-chip{padding:6px;font-size:9px}.lucky-chip strong{font-size:12px}
  .market-toolbar{padding:8px;gap:6px}.market-toolbar h2{font-size:16px}.market-toolbar p{font-size:10px}.market-toolbar input{max-width:100%;font-size:12px}
  .market-grid{grid-template-columns:minmax(0,1fr);gap:6px}.market-grid .market{min-height:88px;padding:9px 58px 8px}.market-grid .market h2{font-size:16px}.market-grid .result-line{font-size:clamp(17px,5vw,22px)}.market-grid .market-action{font-size:10px;padding:6px 5px}.market-times{gap:8px;font-size:10px}
  .chart-table{width:100%;min-width:0;table-layout:fixed}.chart-table .date-col{width:48px}.chart-table .day-col{width:auto}.chart-table th{font-size:9px;padding:5px 1px;white-space:nowrap}.chart-table td{font-size:9px;padding:2px 1px}.date-range{font-size:8px;line-height:1.2;overflow-wrap:anywhere}.jodi-cell{font-size:11px;padding:6px 0;border-width:1px}.panel-result{padding:2px 0;gap:0}.panel-result .panna{font-size:8px;line-height:1.1}.panel-result strong{font-size:10px;line-height:1.1}.chart-title{font-size:13px!important;padding:7px}.chart-note{font-size:9px;padding:5px}
  .history-table{min-width:0;width:100%;table-layout:fixed}.history-table th{font-size:8px;padding:5px 1px}.history-table td{font-size:9px;padding:5px 1px;overflow-wrap:anywhere}.history-table .num{font-size:11px}
  .row,.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.stat{padding:9px}.stat strong{font-size:20px}
  .bottom-nav{left:5px;right:5px;bottom:calc(4px + env(safe-area-inset-bottom));gap:4px}.bottom-nav a,.bottom-nav button{font-size:11px;padding:8px 4px}
}
@media(max-width:360px){
  .chart-table .date-col{width:43px}.chart-table th{font-size:8px}.chart-table td{font-size:8px}.jodi-cell{font-size:10px}.panel-result .panna{font-size:7px}.panel-result strong{font-size:9px}
  .history-table th{font-size:7px}.history-table td{font-size:8px}.history-table .num{font-size:10px}
  .market-grid .market{padding-left:52px;padding-right:52px}.market-grid .market-action{font-size:9px;padding:5px 4px}
}


/* Screenshot-matched DPBOSS mobile homepage */
body{background:#ffc994}
header{background:#ffd0a1;border:3px solid #ed1b2f;border-radius:18px;margin:7px 9px 5px;padding:16px 8px 13px;box-shadow:0 2px 0 #a80e1d}
.brand{display:flex;align-items:center;justify-content:center;gap:5px;white-space:nowrap;font-family:Georgia,serif;font-size:clamp(30px,8.5vw,48px);font-weight:900;letter-spacing:-1px;color:#111;text-shadow:none;line-height:1.15}
.brand-dp{font-family:cursive;font-style:italic;color:#ec078d;font-size:1.12em}
.brand-boss{color:#111}
.brand-vip{position:relative;display:inline-block;background:#e21b2b;color:#fff;padding:5px 9px 4px;border-radius:9px;font-size:.72em;font-style:italic;letter-spacing:0}
.brand-vip:before{content:'👑';position:absolute;top:-.8em;right:-.12em;font-size:.58em;line-height:1}
.tag{display:none}
nav{display:none}
main{max-width:760px;padding:4px 9px calc(76px + env(safe-area-inset-bottom))}
.welcome-card,.description-card,.home-lucky,.live-panel,.market-toolbar{border:3px solid #ed1b2f;border-radius:15px;background:#ffd0a1;margin:0 0 7px;box-shadow:0 2px 0 #a80e1d}
.welcome-card{padding:11px 10px;text-align:center;display:flex;align-items:center;justify-content:center;gap:10px;min-height:86px}
.welcome-mark{flex:0 0 76px;height:70px;border-radius:4px;background:linear-gradient(145deg,#ffd56e,#f08c4e);display:grid;place-items:center;font-size:35px;border:1px solid #e5a04e}
.welcome-copy{font-size:clamp(16px,4.5vw,22px);font-weight:900;font-style:italic;line-height:1.2;color:#111}
.description-card{padding:9px 10px;text-align:center;font-size:clamp(14px,4vw,19px);line-height:1.12;font-weight:800;font-style:italic;color:#111}
.description-card strong{color:#142d65}
.home-lucky{padding:7px 7px 9px;text-align:center;border-radius:15px}
.home-lucky h2{background:#f000a5;color:white;border:3px solid white;border-radius:24px;padding:8px 4px;margin:0 0 5px;font-size:clamp(23px,6vw,31px);font-style:italic;text-shadow:1px 2px 2px #6e174f}
.home-lucky .section-kicker{display:none}
.home-date{font-weight:800;color:#162b5a;margin:2px 0 6px}
.lucky-grid{grid-template-columns:1fr 1fr;gap:0}
.lucky-column{padding:3px 5px;min-width:0}
.lucky-column+ .lucky-column{border-left:2px solid #ed1b2f}
.lucky-label{font-size:clamp(16px,4.5vw,22px);font-weight:900;font-style:italic;color:#17407e}
.lucky-values{font-size:clamp(22px,6vw,31px);font-weight:900;color:#172e66;letter-spacing:1px;overflow-wrap:anywhere}
.lucky-values small{display:block;font-size:12px;letter-spacing:0;color:#293d68}
.live-panel{padding:7px;text-align:center;border-radius:15px;border-left:3px solid #ed1b2f}
.live-panel>div:first-child{background:#f000a5;color:#fff;border:3px solid white;border-radius:24px;padding:7px;font-size:clamp(21px,6vw,29px);font-weight:900;font-style:italic;letter-spacing:1px}
.live-dot{background:#ef2635;box-shadow:0 0 0 3px #ffffff70}
.live-market{font-size:clamp(19px,5vw,25px);font-style:italic;color:#122e69;margin-top:8px}
.live-result{font-size:clamp(23px,6vw,31px);color:#86165d;margin:2px 0 5px}
.live-meta{font-weight:700;color:#333}
.live-panel .home-link{background:#5730a0;border:2px solid white;border-radius:12px;font-size:13px;padding:8px 15px}
.market-count{display:none}
.market-toolbar{padding:7px 10px;display:block;text-align:center;margin-bottom:7px}
.market-toolbar h2{background:#f000a5;color:white;border:3px solid white;border-radius:22px;padding:8px;font-size:clamp(18px,5vw,25px);font-style:italic}
.market-toolbar p{font-size:12px;color:#333;font-weight:800}
.market-toolbar input{max-width:100%;border:2px solid #ed1b2f;border-radius:10px;margin:5px 0 0;background:#fff7ed}
.market-grid{display:grid;grid-template-columns:1fr;gap:0;border:3px solid #ed1b2f;border-radius:14px;overflow:hidden;background:#ffd0a1}
.market-grid .market{border:0;border-bottom:2px solid #ed1b2f;border-radius:0;background:#ffd0a1;box-shadow:none;margin:0;min-height:100px;padding:10px 64px 8px}
.market-grid .market:last-child{border-bottom:0}
.market-grid .market:first-child,.market-grid .market:nth-child(8n){background:#fff500}
.market-grid .market h2{font-size:clamp(20px,5.4vw,28px);font-style:italic;color:#122d68;text-shadow:1px 2px 2px #ffffff;margin:0 0 2px}
.market-grid .result-line{font-size:clamp(23px,6vw,31px);color:#74135f;margin:1px 0 3px;letter-spacing:0}
.market-grid .market-times{font-size:clamp(14px,4vw,19px);color:#111;font-style:italic;gap:22px}
.market-grid .market-action{background:#58319c;color:#fff;border:1px solid #fff;border-radius:11px;padding:7px 9px;font-size:12px;font-style:italic;box-shadow:none}
.market-grid .market.highlight{background:#fff500}
.market-grid .empty-result{font-size:12px;color:#6e2b50;font-weight:700}
.bottom-nav{left:7px;right:7px;bottom:calc(5px + env(safe-area-inset-bottom));gap:6px}
.bottom-nav a,.bottom-nav button{background:#073e9c;border:2px solid white;border-radius:9px;padding:9px 6px;font-size:clamp(12px,3.5vw,16px);font-style:italic;box-shadow:0 2px 4px #0003}
.bottom-nav a:nth-child(2){background:#58319c}
footer{display:none}
@media(min-width:640px){main{max-width:760px}.market-grid{grid-template-columns:1fr}.welcome-mark{flex-basis:100px;height:84px}}
@media(max-width:380px){.market-grid .market{padding-left:53px;padding-right:53px}.market-grid .market-action{font-size:10px;padding:6px 5px}.welcome-mark{flex-basis:62px;height:62px}.description-card{font-size:14px}}


/* Jodi chart layout matched to the supplied mobile reference */
.jodi-page{background:#ffc994;border:0}
.jodi-page-title{margin:0 -9px 0;background:#354fbd;color:#fff;text-align:center;font-size:clamp(21px,5.6vw,30px);font-weight:900;padding:12px 5px;border-bottom:3px solid #111}
.jodi-table-wrap{width:calc(100% + 18px);margin:0 -9px;overflow:hidden}
.jodi-table{width:100%;min-width:0;table-layout:fixed;border-collapse:collapse;background:#ffd0a1}
.jodi-table th{background:#ffc400;color:#080808;border:2px solid #111;padding:8px 1px;font-size:clamp(13px,3.8vw,20px);font-weight:900;text-transform:none}
.jodi-table td{background:#ffd0a1;border:2px solid #111;padding:0;text-align:center;height:75px}
.jodi-table .jodi-cell{display:flex;align-items:center;justify-content:center;min-height:73px;height:100%;padding:4px 0;background:transparent;border:0;color:#080808;text-decoration:none;font-size:clamp(21px,6vw,31px);font-weight:900;line-height:1}
.jodi-table .jodi-cell.latest{color:#ed1717;background:transparent}
.jodi-table .blank-day{display:block;color:transparent;font-size:1px}
.jodi-chart-footer{margin:20px -3px 0;background:#ffd0a1;border:3px solid #123e65;padding:0 5px 8px}
.jodi-footer-links{display:flex;flex-direction:column;border:2px solid #123e65}
.jodi-footer-links a{display:block;text-align:center;text-decoration:none;color:#16466f;background:#ffd0a1;border-bottom:2px solid #123e65;padding:9px 3px;font-size:clamp(17px,5.2vw,27px);font-weight:800;line-height:1.2}
.jodi-footer-links a:last-child{border-bottom:0}
.jodi-footer-brand{margin:18px -2px 0;background:#fff;text-align:center;border:4px solid #d000c8;padding:5px 3px;color:#0872df;font-size:clamp(30px,8vw,49px);font-weight:900;text-shadow:2px 3px 0 #ffd000;overflow-wrap:anywhere}
.jodi-footer-copy{background:#fff;text-align:center;color:#e21b16;font-size:clamp(21px,5.8vw,32px);font-weight:900;line-height:1.45;padding:8px 4px;text-shadow:1px 2px 0 #ffd000}
.jodi-footer-copy small{display:block;font-size:clamp(15px,4.2vw,21px);color:#e21b16}
.jodi-chart-note{background:#ffd0a1;text-align:center;color:#333;font-size:11px;padding:7px}
@media(max-width:390px){.jodi-table td{height:64px}.jodi-table .jodi-cell{min-height:62px;font-size:clamp(19px,5.8vw,25px)}.jodi-table th{font-size:12px;padding:7px 0}}


/* Panel chart: weekly 3x3 panna grid matching supplied mobile reference */
.panel-page{background:#ffc994;border:0}
.panel-page-title{margin:0 -9px;background:#354fbd;color:#fff;text-align:center;
  font-size:clamp(20px,5.6vw,29px);font-weight:900;padding:12px 4px;
  border-bottom:3px solid #123e65;line-height:1.15}
.panel-table-wrap{width:calc(100% + 18px);margin:0 -9px;overflow-x:hidden}
.panel-reference-table{width:100%;min-width:0;table-layout:fixed;border-collapse:collapse;
  background:#ffd0a1;border:2px solid #1d7893}
.panel-reference-table col.date-col{width:17.2%}
.panel-reference-table col.day-col{width:11.828%}
.panel-reference-table th{background:#ffc400;color:#080808;border:2px solid #1685a2;
  padding:5px 1px;text-align:center;font-size:clamp(12px,3.4vw,18px);font-weight:900}
.panel-reference-table td{background:#ffd0a1;border:2px solid #1685a2;padding:0;text-align:center;
  height:91px;vertical-align:middle;overflow:hidden}
.panel-reference-table td.date-range{font-size:clamp(10px,2.7vw,14px);font-weight:800;line-height:1.35;
  padding:2px 1px;color:#111;white-space:normal}
.panel-cell{display:grid;grid-template-columns: minmax(7px,1fr) minmax(18px,1.45fr) minmax(7px,1fr);
  grid-template-rows:repeat(3,1fr);align-items:center;justify-items:center;width:100%;height:100%;
  min-height:88px;padding:2px 1px;box-sizing:border-box;text-decoration:none;color:#111;line-height:1}
.panel-cell .left-digit,.panel-cell .right-digit{font-size:clamp(11px,3vw,16px);font-weight:500;align-self:center}
.panel-cell .middle-jodi{grid-column:2;grid-row:1 / 4;font-size:clamp(17px,4.3vw,24px);font-weight:900;white-space:nowrap}
.panel-cell .left-digit:nth-child(1){grid-column:1;grid-row:1}
.panel-cell .left-digit:nth-child(2){grid-column:1;grid-row:2}
.panel-cell .left-digit:nth-child(3){grid-column:1;grid-row:3}
.panel-cell .right-digit:nth-last-child(3){grid-column:3;grid-row:1}
.panel-cell .right-digit:nth-last-child(2){grid-column:3;grid-row:2}
.panel-cell .right-digit:nth-last-child(1){grid-column:3;grid-row:3}
.panel-cell.latest{color:#ed1717}
.panel-cell .missing{color:#ed1717;font-weight:900}
.panel-reference-table .blank-day{display:block;color:transparent;font-size:1px}
.panel-chart-footer{margin:20px -3px 0;background:#ffd0a1;border:3px solid #123e65;padding:0 5px 8px}
.panel-footer-links{display:flex;flex-direction:column;border:2px solid #123e65}
.panel-footer-links a{display:block;text-align:center;text-decoration:none;color:#16466f;background:#ffd0a1;
  border-bottom:2px solid #123e65;padding:9px 3px;font-size:clamp(17px,5.2vw,27px);font-weight:800;line-height:1.2}
.panel-footer-links a:last-child{border-bottom:0}
.panel-footer-brand{margin:18px -2px 0;background:#fff;text-align:center;border:4px solid #d000c8;
  padding:5px 3px;color:#0872df;font-size:clamp(30px,8vw,49px);font-weight:900;
  text-shadow:2px 3px 0 #ffd000;overflow-wrap:anywhere}
.panel-footer-copy{background:#fff;text-align:center;color:#e21b16;font-size:clamp(21px,5.8vw,32px);
  font-weight:900;line-height:1.45;padding:8px 4px;text-shadow:1px 2px 0 #ffd000}
.panel-footer-copy small{display:block;font-size:clamp(15px,4.2vw,21px);color:#e21b16}
@media(max-width:390px){.panel-reference-table td{height:78px}.panel-cell{min-height:75px}
 .panel-cell .left-digit,.panel-cell .right-digit{font-size:11px}.panel-cell .middle-jodi{font-size:16px}
 .panel-reference-table th{font-size:11px}}

</style>${admin ? "<style>" + ADMIN_CSS + "</style>" : title === "Market Result" ? "<style>" + HOME_CSS + "</style>" : ""}<script>
function ank(p){if(!/^\\d{3}$/.test(p))return "—";return String([...p].reduce((a,d)=>a+Number(d),0)%10)}
function updatePreview(form){const o=form.querySelector('[name="openPanna"]').value,c=form.querySelector('[name="closePanna"]').value;const oa=ank(o),ca=ank(c);const open=form.querySelector('[data-preview="open"]'),jodi=form.querySelector('[data-preview="jodi"]'),close=form.querySelector('[data-preview="close"]');if(open)open.textContent="Open Ank: "+oa;if(jodi)jodi.textContent="Jodi: "+(oa!=="—"&&ca!=="—"?oa+ca:"—");if(close)close.textContent="Close Ank: "+ca}
</script></head><body${admin ? ' class="admin-page"' : title === "Market Result" ? ' class="home-page"' : ""}><header><a class="brand-link" href="/" aria-label="DPBOSS VIP Home"><div class="brand"><span class="brand-dp">DP</span><span class="brand-boss">BOSS</span><span class="brand-vip">VIP</span></div><div class="tag">FAST MARKET RESULT & CHART</div></a></header><nav><a href="/">HOME</a>${admin ? '<a href="/admin">Dashboard</a><a href="/admin/api">API Sync</a><a href="/admin/logs">Change Log</a><a href="/admin/backup">Backup</a><a href="/jodi">JODI CHART</a><a href="/panel">PANEL CHART</a><a href="/history">HISTORY</a><form method="post" action="/logout" class="inline"><button style="padding:5px 9px">Logout</button></form>' : '<a href="/jodi">JODI CHART</a><a href="/panel">PANEL CHART</a><a href="/history">HISTORY</a>'}</nav><main>${content}</main><footer>DPBOSS VIP · Market results and charts · <a href="/login" style="color:inherit">Admin Login</a></footer></body></html>`;
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
  return `<section class="market"><h2>${esc(chartMarketName(m.name))}</h2><div class="meta"><span>Open: <b>${esc(m.openTime)}</b></span><span>Close: <b>${esc(m.closeTime)}</b></span></div>${rows.length ? `<div class="table-wrap"><table class="history-table"><thead><tr><th>Date</th><th>Open Panna</th><th>Open Ank</th><th>Jodi</th><th>Close Panna</th><th>Close Ank</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td class="num">${esc(openIsPublished(r) ? r.openPanna : "—")}</td><td class="num">${esc(openIsPublished(r) ? (r.openAnk ?? pannaAnk(r.openPanna)) : "—")}</td><td class="num">${esc(validJodi(String(r.jodi || "")) ? String(r.jodi) : (resultIsComplete(r) ? resultJodi(r) : "—"))}</td><td class="num">${esc(closeIsPublished(r) ? r.closePanna : "—")}</td><td class="num">${esc(closeIsPublished(r) ? (r.closeAnk ?? pannaAnk(r.closePanna)) : "—")}</td></tr>`).join("")}</tbody></table></div>` : '<p class="muted">No matching published results.</p>'}</section>`;
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
  const latest = [...allResults].sort((a,b) => b.date.localeCompare(a.date))[0];
  const dateLabel = new Intl.DateTimeFormat("en-IN", { timeZone:"Asia/Kolkata", day:"2-digit", month:"long", year:"numeric" }).format(new Date());
  const completeToday = todayResults.filter(resultIsComplete);
  const openAnks = [...new Set(completeToday.map(r => pannaAnk(r.openPanna)))];
  const closeAnks = [...new Set(completeToday.map(r => pannaAnk(r.closePanna)))];
  const lucky = `<section class="home-lucky"><h2>✨ Today Lucky Number ✨</h2><p class="home-date">${esc(dateLabel)} · Published results only</p><div class="lucky-grid"><div class="lucky-column"><div class="lucky-label">Golden Ank</div><div class="lucky-values">${openAnks.length ? esc(openAnks.join(" - ")) : "—"}<small>From today's published open results</small></div></div><div class="lucky-column"><div class="lucky-label">Final Ank</div><div class="lucky-values">${closeAnks.length ? esc(closeAnks.join(" - ")) : "—"}<small>From today's published close results</small></div></div></div></section>`;
  const latestBlock = latest ? `<section class="live-panel"><div><span class="live-dot"></span> LIVE RESULT</div><div class="live-market">${esc(chartMarketName(latest.marketName))}</div><div class="live-result">${resultIsComplete(latest) ? `${esc(latest.openPanna)} - ${esc(resultJodi(latest))} - ${esc(latest.closePanna)}` : (openIsPublished(latest) ? `${esc(latest.openPanna)} - ${esc(pannaAnk(latest.openPanna))} - …` : `… - … - ${esc(latest.closePanna)}`)}</div><div class="live-meta">${esc(shortDate(latest.date))} · ${["sattaapi", "matkaapi"].includes(latest.source) ? "API update" : "Published result"}</div><a class="home-link" href="/history?market=${encodeURIComponent(latest.marketId)}&q=${encodeURIComponent(latest.date)}">VIEW HISTORY</a></section>` : `<section class="live-panel"><div>LIVE RESULT</div><div class="live-market">Results will appear here</div><div class="live-meta">No published results available yet</div><a class="home-link" href="/history">VIEW HISTORY</a></section>`;
  const board = s.markets.map(m=>marketCard(m)).join("") || '<section class="panel">No markets available. Sign in to Admin and sync the market list.</section>';
  const search = `<section class="market-toolbar"><h2>WORLD ME SABSE FAST RESULT</h2><p>Market-wise latest published results</p><input id="marketSearch" type="search" placeholder="Search market name..." aria-label="Search market"></section>`;
  const script = `<script>document.addEventListener('DOMContentLoaded',()=>{const input=document.getElementById('marketSearch');if(input)input.addEventListener('input',()=>{const q=input.value.toLowerCase();document.querySelectorAll('.market-grid .market').forEach(card=>{card.style.display=card.innerText.toLowerCase().includes(q)?'':'none';});});});</script>`;
  const welcome = `<section class="welcome-card"><div class="welcome-mark" aria-hidden="true">🏵️</div><div class="welcome-copy">!! Welcome to DPBOSS VIP<br>Fast Market Results !!</div></section>`;
  const intro = `<section class="description-card"><strong>DPBOSS VIP MARKET RESULT</strong><br>Latest market-wise published results, Jodi charts, Panel charts and date-wise history — all in one place.</section>`;
  const count = `<div class="market-count"><b>${s.markets.length}</b> markets listed <span>·</span> <b>${todayResults.length}</b> results published today</div>`;
  let playMatkaHref="";
  try {
    const u = new URL(String(s.whatsappPlayLink || ""));
    const phone = u.hostname === "wa.me" ? u.pathname.replace(/^\/+/, "") : (u.hostname === "api.whatsapp.com" && u.pathname === "/send" ? (u.searchParams.get("phone") || "") : "");
    if (u.protocol === "https:" && /^\d{8,15}$/.test(phone)) {
      u.searchParams.set("text", "Hi, mujhe Matka Play karna hai.");
      playMatkaHref = u.toString();
    }
  } catch {}
  const bottom = '<div class="bottom-nav"><a href="/">HOME</a><button type="button" onclick="location.reload()">REFRESH</button></div>';
  const playMatkaButton = playMatkaHref
    ? '<a class="play-matka-float" href="' + esc(playMatkaHref) + '" target="_blank" rel="noopener" aria-label="Play Matka on WhatsApp"><span class="play-icon">💬</span> PLAY MATKA</a>'
    : '<button class="play-matka-float" type="button" disabled aria-label="Play Matka on WhatsApp"><span class="play-icon">💬</span> PLAY MATKA</button>';
  res.send(page("Market Result", welcome + intro + lucky + latestBlock + search + `<div class="market-grid">${board}</div>` + bottom + playMatkaButton + script));
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
  const title = mode === "jodi" ? "Jodi" : "Panel";
  const cards = s.markets.map(m => `<a class="market-pick" data-market-name="${esc(chartMarketName(m.name).toLowerCase())}" href="/${mode}?market=${encodeURIComponent(m.id)}"><strong>${esc(chartMarketName(m.name))}</strong><span>Open ${title} Chart →</span></a>`).join("");
  return `<section class="chooser-head"><div class="section-kicker">MARKET CHARTS</div><h2>Select Market</h2><p>Search and select a market to open its ${title} chart.</p><input id="chartMarketSearch" type="search" placeholder="Search ${title.toLowerCase()} market..." aria-label="Search market"></section><section class="market-chooser-grid" id="marketChooserGrid">${cards || '<p class="muted">No markets available.</p>'}</section><script>document.addEventListener('DOMContentLoaded',()=>{const i=document.getElementById('chartMarketSearch');if(!i)return;i.addEventListener('input',()=>{const q=i.value.trim().toLowerCase();document.querySelectorAll('.market-pick').forEach(a=>a.hidden=!a.dataset.marketName.includes(q));});});</script>`;
}
function renderJodiChart(m, markets = []) {
  // Seven weekday columns, matching the supplied Jodi chart reference.
  const published = m.results.filter(r => resultIsVisible(r) && validDate(r.date) &&
    (validJodi(String(r.jodi || "")) || resultIsComplete(r))).sort((a,b)=>a.date.localeCompare(b.date));
  const latest = published.length ? published[published.length-1] : null;
  const weeks = groupedWeeks(published);
  const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const resultByDate = new Map(published.map(r=>[r.date,r]));
  const rows = weeks.map(([start]) => {
    const startDate = dateParts(start).date;
    const cells = dayNames.map((_,idx) => {
      const day = new Date(startDate); day.setUTCDate(day.getUTCDate()+idx);
      const date = isoDate(day), r = resultByDate.get(date);
      if (!r) return `<td><span class="blank-day" aria-label="No result">—</span></td>`;
      const value = validJodi(String(r.jodi || "")) ? String(r.jodi) : resultJodi(r);
      const isLatest = latest && r.date === latest.date;
      return `<td><a class="jodi-cell${isLatest ? " latest" : ""}" href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}" title="${shortDate(r.date)}" aria-label="${shortDate(r.date)}: ${esc(value)}">${esc(value)}</a></td>`;
    }).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  const table = rows ? `<div class="jodi-table-wrap"><table class="jodi-table" aria-label="${esc(chartMarketName(m.name))} Jodi chart"><thead><tr>${dayNames.map(d=>`<th scope="col">${d}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="chart-empty">No published results are available for this market yet.</div>`;
  const footerLinks = markets.filter(x=>x.id !== m.id).map(x=>`<a href="/panel?market=${encodeURIComponent(x.id)}">${esc(chartMarketName(x.name))} Panel Chart</a>`).join("");
  const footer = `<section class="jodi-chart-footer" aria-label="More market charts"><div class="jodi-footer-links">${footerLinks || `<a href="/panel">View Panel Charts</a>`}</div><div class="jodi-footer-brand">DPBOSSSS.COM</div><div class="jodi-footer-copy">All Rights Reserved®<br>(1998-2026)<small>Market Results &amp; Charts</small></div></section>`;
  return `<section class="jodi-page"><h1 class="jodi-page-title">${esc(chartMarketName(m.name).toUpperCase())} DAY CHART</h1>${table}<p class="jodi-chart-note">Tap any result to view its saved date-wise details.</p></section>${footer}<div id="chart-bottom"></div>`;
}
function renderPanelChart(m, markets = []) {
  const published = m.results.filter(r => resultIsVisible(r) && validDate(r.date))
    .sort((a,b)=>a.date.localeCompare(b.date));
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
      const open = openIsPublished(r) && validPanna(String(r.openPanna || "")) ? String(r.openPanna) : "";
      const close = closeIsPublished(r) && validPanna(String(r.closePanna || "")) ? String(r.closePanna) : "";
      const jodi = validJodi(String(r.jodi || "")) ? String(r.jodi) : (resultIsComplete(r) ? resultJodi(r) : "");
      const isLatest = latest && r.date === latest.date;
      const openDigits = open ? [...open].map(d=>`<span class="left-digit">${esc(d)}</span>`).join("") : `<span class="left-digit missing">*</span><span class="left-digit missing">*</span><span class="left-digit missing">*</span>`;
      const closeDigits = close ? [...close].map(d=>`<span class="right-digit">${esc(d)}</span>`).join("") : `<span class="right-digit missing">*</span><span class="right-digit missing">*</span><span class="right-digit missing">*</span>`;
      const middle = jodi ? esc(jodi) : "**";
      return `<td><a class="panel-cell${isLatest ? " latest" : ""}" href="/history?market=${encodeURIComponent(m.id)}&q=${encodeURIComponent(r.date)}" title="${shortDate(r.date)} · ${esc(open || "—")}-${middle}-${esc(close || "—")}" aria-label="${shortDate(r.date)} panel result">${openDigits}<strong class="middle-jodi${jodi ? "" : " missing"}">${middle}</strong>${closeDigits}</a></td>`;
    }).join("");
    return `<tr><td class="date-range">${dateLabel}</td>${cells}</tr>`;
  }).join("");
  const table = rows ? `<div class="panel-table-wrap"><table class="panel-reference-table" aria-label="${esc(chartMarketName(m.name))} Panel Chart"><colgroup><col class="date-col">${dayNames.map(()=>'<col class="day-col">').join("")}</colgroup><thead><tr><th scope="col">Date</th>${dayNames.map(d=>`<th scope="col">${d}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="chart-empty">No published results are available for this market yet.</div>`;
  const footerLinks = markets.filter(x=>x.id !== m.id).map(x=>`<a href="/panel?market=${encodeURIComponent(x.id)}">${esc(chartMarketName(x.name))} Panel Chart</a>`).join("");
  const footer = `<section class="panel-chart-footer" aria-label="More panel charts"><div class="panel-footer-links">${footerLinks || `<a href="/panel">View Panel Charts</a>`}</div><div class="panel-footer-brand">DPBOSSSS.COM</div><div class="panel-footer-copy">All Rights Reserved®<br>(1998-2026)<small>Market Results &amp; Charts</small></div></section>`;
  return `<section class="panel-page"><h1 class="panel-page-title">${esc(chartMarketName(m.name).toUpperCase())} DAY PANEL CHART</h1>${table}</section>${footer}<div id="chart-bottom"></div>`;
}
app.get("/jodi", (req,res) => {
  const s = readStore(), marketId = String(req.query.market || "");
  const m = s.markets.find(x=>x.id === marketId);
  if (!m) return res.send(page("Jodi Chart",marketChooser(s,"jodi")));
  res.send(page("Jodi Chart",renderJodiChart(m,s.markets)));
});
app.get("/panel", (req,res) => {
  const s = readStore(), marketId = String(req.query.market || "");
  const m = s.markets.find(x=>x.id === marketId);
  if (!m) return res.send(page("Panel Chart",marketChooser(s,"panel")));
  res.send(page("Panel Chart",renderPanelChart(m,s.markets)));
});

app.get("/five-year-chart", (req,res) => {
  const store = readStore();
  const mode = String(req.query.mode || "jodi") === "panel" ? "panel" : "jodi";
  const marketId = String(req.query.market || "");
  const market = marketId ? store.markets.find(m => m.id === marketId) : null;
  if (market) return res.redirect(`/${mode}?market=${encodeURIComponent(market.id)}`);
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


app.post("/admin/settings/whatsapp",adminOnly,async(req,res)=>{
  const raw=String(req.body.whatsappPlayLink||"").trim();
  let valid=false;
  try {
    const u=new URL(raw);
    const phone=u.hostname==="wa.me"
      ? u.pathname.replace(/^\/+/, "")
      : (u.hostname==="api.whatsapp.com" && u.pathname==="/send" ? (u.searchParams.get("phone")||"") : "");
    valid=u.protocol==="https:" && /^\d{8,15}$/.test(phone);
  } catch {}
  if(!valid) return res.status(400).send(page("Invalid WhatsApp Link",'<section class="panel"><h2>Invalid WhatsApp Link</h2><p>Please enter a valid HTTPS personal WhatsApp link.</p><a href="/admin">Back to Dashboard</a></section>',true));

  const store=readStore();
  store.whatsappPlayLink=raw;
  try {
    if(mongoDb) {
      await mongoDb.collection("app_state").updateOne(
        { _id: "main" },
        { $set: { whatsappPlayLink: raw } },
        { upsert: true }
      );
    } else {
      const saved=await writeStore(store);
      if(!saved) throw new Error("Local storage save failed");
    }
    cachedStore=normalizeStore(store);
  } catch(err) {
    console.error("WhatsApp link save failed:",err.message);
    return res.status(500).send(page("Save Failed",'<section class="panel"><h2>Could not save WhatsApp link</h2><a href="/admin">Back to Dashboard</a></section>',true));
  }
  res.redirect("/admin");
});;

app.get("/admin",adminOnly,(req,res)=>{
 const s=readStore(), personalMarkets=s.markets.filter(m=>["MAHADEV","MAHADEV NIGHT"].includes(String(m.name||"").trim().toUpperCase())), total=personalMarkets.reduce((n,m)=>n+m.results.length,0), published=personalMarkets.reduce((n,m)=>n+m.results.filter(r=>resultIsVisible(r)).length,0), drafts=total-published;
 const add=`<section class="panel admin-add"><div class="admin-kicker">MARKET SETUP</div><h2>Add a Personal Market</h2><form method="post" action="/admin/market/add"><label>Market name</label><input name="name" required maxlength="60" placeholder="e.g. My New Market"><div class="row"><div><label>Open time</label><input type="time" name="openTime" value="15:00" required></div><div><label>Close time</label><input type="time" name="closeTime" value="18:00" required></div><div style="display:flex;align-items:end"><button style="margin-bottom:12px;width:100%">Add Market</button></div></div></form></section>`;
 const whatsappPanel=`<section class="panel"><h2>PLAY MATKA — WhatsApp Link</h2><form method="post" action="/admin/settings/whatsapp"><label>Personal WhatsApp Link</label><input type="url" name="whatsappPlayLink" value="${esc(s.whatsappPlayLink || "")}" placeholder="https://wa.me/919876543210" required><p class="muted">Enter your personal WhatsApp link. The Play Matka button will open WhatsApp with a pre-filled message.</p><button>Save WhatsApp Link</button></form></section>`; const exportPanel=`<section class="panel admin-export"><h2>Download Results</h2><a href="/admin/export/results.csv">Download Excel Sheet (CSV)</a> | <a href="/admin/export/results.pdf" target="_blank">Download PDF</a></section>`; const cards=personalMarkets.map(m=>`<section class="panel admin-market-card"><h2>${esc(chartMarketName(m.name))}</h2><p class="muted">Open ${esc(m.openTime)} · Close ${esc(m.closeTime)} · ${m.results.length} saved result(s)</p><form method="post" action="/admin/market/update"><input type="hidden" name="id" value="${esc(m.id)}"><div class="row"><div><label>Market name</label><input name="name" value="${esc(chartMarketName(m.name))}" required maxlength="60"></div><div><label>Open time</label><input type="time" name="openTime" value="${esc(m.openTime)}" required></div><div><label>Close time</label><input type="time" name="closeTime" value="${esc(m.closeTime)}" required></div></div><button>Save Market Details</button></form><hr style="border:0;border-top:1px solid #eee3cd;margin:18px 0"><h3>Result Management</h3><form method="post" action="/admin/result"><input type="hidden" name="marketId" value="${esc(m.id)}"><label>Result date</label><input type="date" name="date" value="${localDateISO()}" max="${localDateISO()}" required><div class="row"><div><label>Open Panna (any 3 digits)</label><input name="openPanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" placeholder="119" oninput="updatePreview(this.form)"></div><div><label>Close Panna (any 3 digits)</label><input name="closePanna" inputmode="numeric" pattern="[0-9]{3}" maxlength="3" placeholder="169" oninput="updatePreview(this.form)"></div></div><div class="stat" style="margin:8px 0 14px"><span>Result preview</span><strong data-preview="open">Open Ank: —</strong><strong data-preview="jodi">Jodi: —</strong><strong data-preview="close">Close Ank: —</strong><p class="muted">Publish Open after its result is ready, then publish Close later for the same date.</p></div><button name="action" value="publish-open">Publish Open Only</button> <button name="action" value="publish-close">Publish Close Only</button> <button name="action" value="publish">Publish Both</button></form>${adminSavedResults(m)}<form method="post" action="/admin/market/delete" onsubmit="return confirm('Delete this market and all its results?')" style="margin-top:14px"><input type="hidden" name="id" value="${esc(m.id)}"><button class="danger">Delete Market</button></form></section>`).join("");
 res.send(page("Admin Dashboard",`${flash(req)}<section class="panel admin-overview"><div class="admin-kicker">DPBOSS CONTROL CENTER</div><h2>Dashboard Overview</h2><div class="stats"><div class="stat"><span>Markets</span><strong>${personalMarkets.length}</strong></div><div class="stat"><span>Published results</span><strong>${published}</strong></div><div class="stat"><span>Draft / unpublished</span><strong>${drafts}</strong></div></div></section>${add}${whatsappPanel}${exportPanel}${cards}` ,true));
});

app.get("/admin/export/results.csv",adminOnly,(req,res)=>{
 const s=readStore(),q=v=>'"'+String(v??"").replace(/"/g,'""')+'"';
 const rows=[["Market","Date","Open Panna","Open Ank","Jodi","Close Ank","Close Panna","Status"]];
 for(const m of s.markets||[])for(const r of m.results||[])rows.push([m.name,r.date,r.openPanna,r.openAnk,r.jodi,r.closeAnk,r.closePanna,resultIsVisible(r)?"Published":"Draft"]);
 res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",'attachment; filename="dpboss-results.csv"');res.send("\uFEFF"+rows.map(a=>a.map(q).join(",")).join("\r\n"));
});
app.get("/admin/export/results.pdf",adminOnly,(req,res)=>{
 const s=readStore(),h=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
 let rows="";
 for(const m of s.markets||[])for(const r of m.results||[])rows+="<tr>"+[m.name,r.date,r.openPanna,r.openAnk,r.jodi,r.closeAnk,r.closePanna,resultIsVisible(r)?"Published":"Draft"].map(v=>"<td>"+h(v)+"</td>").join("")+"</tr>";
 res.setHeader("Cache-Control","no-store");res.setHeader("Content-Type","text/html; charset=utf-8");
 res.send('<!doctype html><html><head><meta charset="utf-8"><title>DPBOSS Results</title><style>body{font-family:Arial;padding:20px}table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #aaa;padding:6px;text-align:center}th{background:#eee}@media print{button{display:none}}</style></head><body><h2>DPBOSS Results</h2><button onclick="print()">Print / Save as PDF</button><table><thead><tr><th>Market</th><th>Date</th><th>Open Panna</th><th>Open Ank</th><th>Jodi</th><th>Close Ank</th><th>Close Panna</th><th>Status</th></tr></thead><tbody>'+rows+'</tbody></table><script>onload=()=>print()</script></body></html>');
});

app.post("/admin/market/add",adminOnly,async (req,res)=>{const name=String(req.body.name||"").trim(),openTime=String(req.body.openTime||""),closeTime=String(req.body.closeTime||"");if(!name||name.length>60||!validTime(openTime)||!validTime(closeTime)){req.session.flash="Enter a market name and valid times.";return res.redirect("/admin");}const s=readStore(),m={id:"market-"+s.nextId++,name,openTime,closeTime,results:[]};s.markets.push(m);logAction(s,"Market added",name);req.session.flash=await writeStore(s)?"Market added.":"SAVE FAILED: data was not saved. Check server logs.";res.redirect("/admin");});
app.post("/admin/market/update",adminOnly,async (req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.id),name=String(req.body.name||"").trim(),openTime=String(req.body.openTime||""),closeTime=String(req.body.closeTime||"");if(!m||!name||name.length>60||!validTime(openTime)||!validTime(closeTime)){req.session.flash="Could not update market; check the values.";return res.redirect("/admin");}const before=m.name;m.name=name;m.openTime=openTime;m.closeTime=closeTime;logAction(s,"Market updated",`${before} → ${name} (${openTime}-${closeTime})`);req.session.flash=await writeStore(s)?"Market details updated.":"SAVE FAILED: data was not saved. Check server logs.";res.redirect("/admin");});
app.post("/admin/market/delete",adminOnly,async (req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.id);if(m){s.markets=s.markets.filter(x=>x.id!==req.body.id);logAction(s,"Market deleted",m.name);const saved=await writeStore(s);req.session.flash=saved?"Market deleted.":"SAVE FAILED: deletion was not confirmed."; }else{req.session.flash="Market not found.";}res.redirect("/admin");});
app.post("/admin/result",adminOnly,async (req,res)=>{
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
    const saved=await writeStore(s);req.session.flash=saved?(action==="publish-open"?"Open result published. You can publish Close later for the same date.":"Close result published."):"SAVE FAILED: result was not saved. Check server logs.";return res.redirect("/admin");
  }
  if(action==="publish"||action==="draft"){
    const openPanna=String(req.body.openPanna||old?.openPanna||""),closePanna=String(req.body.closePanna||old?.closePanna||"");
    if(!validPanna(openPanna)||!validPanna(closePanna)){req.session.flash="To publish both together, enter valid 3-digit Open and Close Panna.";return res.redirect("/admin");}
    const openAnk=pannaAnk(openPanna),closeAnk=pannaAnk(closePanna),published=action==="publish";
    const entry={date,openPanna,openAnk,jodi:openAnk+closeAnk,closePanna,closeAnk,published,openPublished:published,closePublished:published,updatedAt:new Date().toISOString()};
    const idx=m.results.findIndex(r=>r.date===date);if(idx>=0)m.results[idx]=entry;else m.results.push(entry);
    logAction(s,old?"Result updated":"Result added",`${m.name} · ${date} · ${openPanna}/${entry.jodi}/${closePanna} · ${published?"both published":"draft"}`);
    const saved=await writeStore(s);req.session.flash=saved?(published?"Open and Close results published.":"Draft saved."):"SAVE FAILED: result was not saved. Check server logs.";return res.redirect("/admin");
  }
  req.session.flash="Choose a valid publish action.";res.redirect("/admin");
});
app.post("/admin/result/toggle",adminOnly,async (req,res)=>{const s=readStore(),m=s.markets.find(x=>x.id===req.body.marketId),r=m&&m.results.find(x=>x.date===req.body.date);if(r){r.published=!r.published;r.openPublished=r.published;r.closePublished=r.published;r.updatedAt=new Date().toISOString();logAction(s,r.published?"Result published":"Result unpublished",`${m.name} · ${r.date}`);const saved=await writeStore(s);req.session.flash=saved?(r.published?"Result published.":"Result unpublished."):"SAVE FAILED: change was not saved.";}res.redirect("/admin");});

// SattaAPI integration. Credentials are read only from server environment variables.
const SATTA_API_URL = process.env.SATTA_API_URL || "https://matkaapi.sattaapi.com/wp-json/satta/v1/results";
const SATTA_REFRESH_SETTING = Number(process.env.SATTA_API_REFRESH_MS || 300000);
const SATTA_API_REFRESH_MS = Number.isFinite(SATTA_REFRESH_SETTING) ? Math.max(60000, SATTA_REFRESH_SETTING) : 300000;
function apiSlug(name) { return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
async function sattaApiRequest() {
  const { SATTA_API_KEY, SATTA_DOMAIN_KEY, SATTA_API_DOMAIN } = process.env;
  if (!SATTA_API_KEY || !SATTA_DOMAIN_KEY || !SATTA_API_DOMAIN) {
    throw new Error("SattaAPI credentials are not configured. Set SATTA_API_KEY, SATTA_DOMAIN_KEY and SATTA_API_DOMAIN in Render Environment.");
  }
  const response = await fetch(SATTA_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ api_key: SATTA_API_KEY, domain_key: SATTA_DOMAIN_KEY, domain: SATTA_API_DOMAIN }),
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  if (!response.ok) {
    const detail = body?.message || body?.error || body?.results?.message || raw.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`SattaAPI HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!body || body?.results?.status !== true || !Array.isArray(body?.results?.data)) {
    throw new Error(body?.results?.message || body?.message || "SattaAPI response format is invalid (expected results.data array).");
  }
  return body;
}
function parseSattaResult(row) {
  const date = String(row.date || "").slice(0, 10);
  if (!validDate(date) || date > localDateISO()) return null;
  const openPanna = String(row.open || "").trim();
  const closePanna = String(row.close || "").trim();
  const rawJodi = String(row.jodi || "").trim();
  if (!validPanna(openPanna) || !/^\d{1,2}$/.test(rawJodi)) return null;
  const jodi = rawJodi.padStart(2, "0");
  const hasClose = validPanna(closePanna);
  return {
    date, openPanna, openAnk: pannaAnk(openPanna), jodi,
    closePanna: hasClose ? closePanna : "", closeAnk: hasClose ? pannaAnk(closePanna) : "",
    published: hasClose, openPublished: true, closePublished: hasClose,
    source: "sattaapi", updatedAt: new Date().toISOString()
  };
}
function toSattaMinutes(value) {
  const m = String(value || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return "";
  let h = Number(m[1]) % 12;
  if ((m[3] || "").toUpperCase() === "PM") h += 12;
  const result = `${String(h).padStart(2, "0")}:${m[2]}`;
  return validTime(result) ? result : "";
}
function syncSattaRows(store, rows) {
  let addedMarkets = 0, saved = 0, skipped = 0;
  for (const row of rows) {
    const name = String(row.name || "").trim(), slug = apiSlug(name);
    if (!name || !slug) { skipped++; continue; }
    let market = store.markets.find(m => m.apiSlug === slug || apiSlug(m.name) === slug);
    if (!market) {
      market = { id: `api-${slug}`, apiSlug: slug, name,
        openTime: toSattaMinutes(row.open_time) || "15:00",
        closeTime: toSattaMinutes(row.close_time) || "18:00", results: [] };
      store.markets.push(market); addedMarkets++;
    } else {
      // Preserve existing admin-configured market name and timings.
      market.apiSlug = slug;
    }
    const entry = parseSattaResult(row);
    if (!entry) { skipped++; continue; }
    const idx = market.results.findIndex(r => r.date === entry.date);
    if (idx >= 0 && !["sattaapi", "matkaapi"].includes(market.results[idx].source)) { skipped++; continue; }
    if (idx >= 0) {
      const old = market.results[idx];
      // Keep a previously received close result if the provider temporarily returns it blank.
      if (!entry.closePublished && old.closePublished) {
        entry.closePanna = old.closePanna; entry.closeAnk = old.closeAnk;
        entry.closePublished = true; entry.published = true;
      }
      market.results[idx] = { ...old, ...entry, source: "sattaapi" };
    } else market.results.push(entry);
    saved++;
  }
  return { addedMarkets, saved, skipped };
}
app.get("/admin/api", adminOnly, (req,res) => {
  const configured = Boolean(process.env.SATTA_API_KEY && process.env.SATTA_DOMAIN_KEY && process.env.SATTA_API_DOMAIN);
  res.send(page("SattaAPI Integration", `${flash(req)}<section class="panel"><h2>Live Result API Integration</h2><p>${configured ? "SattaAPI credentials are configured on the server." : "SattaAPI credentials are not configured yet."}</p><p class="muted">Fetches the provider market list and results securely. Existing manual admin editing remains available. API credentials are never shown here.</p><form method="post" action="/admin/api/sync"><button>Fetch / Update Results Now</button></form></section>`, true));
});
app.post("/admin/api/sync", adminOnly, async (req,res) => {
  try {
    const body=await sattaApiRequest();
    const store=readStore();
    const counts=syncSattaRows(store,body.results.data);
    logAction(store,"SattaAPI sync",`${counts.saved} result(s) saved; ${counts.addedMarkets} market(s) added; ${counts.skipped} row(s) skipped`);
    writeStore(store);
    req.session.flash=`SattaAPI sync complete: ${counts.saved} result(s) saved, ${counts.addedMarkets} market(s) added, ${counts.skipped} row(s) skipped. Subscription expiry: ${body.expiry||"not provided"}.`;
    res.redirect("/admin/api");
  } catch(e) {
    req.session.flash=`SattaAPI sync failed: ${e.message}`;
    res.redirect("/admin/api");
  }
});

// Automatic read-only result refresh every 60 seconds.
let apiAutoSyncRunning = false;
async function autoSyncMarketApi() {
  if (apiAutoSyncRunning || !process.env.SATTA_API_KEY || !process.env.SATTA_DOMAIN_KEY || !process.env.SATTA_API_DOMAIN) return;
  apiAutoSyncRunning = true;
  try {
    const body=await sattaApiRequest();
    const store=readStore();
    const counts=syncSattaRows(store,body.results.data);
    logAction(store,"Automatic SattaAPI refresh",`${counts.saved} result(s) refreshed`);
    writeStore(store);
    console.log(`SattaAPI automatic refresh: ${counts.saved} result(s), ${counts.addedMarkets} market(s) added`);
  } catch(e) {
    console.error(`SattaAPI automatic refresh failed: ${e.message}`);
  } finally {
    apiAutoSyncRunning=false;
  }
}

app.get("/admin/logs",adminOnly,(req,res)=>{const s=readStore();const rows=s.logs.slice(0,200);res.send(page("Change Log",`<section class="panel"><h2>Recent Admin Changes</h2><p class="muted">Latest 200 actions; log is stored locally with the result data.</p>${rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Details</th></tr></thead><tbody>${rows.map(x=>`<tr><td>${esc(x.at.replace("T"," ").slice(0,19))}</td><td>${esc(x.action)}</td><td>${esc(x.detail)}</td></tr>`).join("")}</tbody></table></div>`:'<p>No changes logged yet.</p>'}</section>`,true));});
app.get("/admin/backup",adminOnly,(req,res)=>{res.send(page("Backup & Restore",`${flash(req)}<section class="panel"><h2>Backup & Restore</h2><p>Download a copy of your markets, results and change log. Keep the file private.</p><a class="btn" href="/admin/backup/download">Download JSON Backup</a><hr style="border:0;border-top:1px solid #eee3cd;margin:20px 0"><h3>Restore from backup</h3><p class="muted">Restore replaces current local data. Download a backup first. Only restore a JSON backup created by this app.</p><form method="post" action="/admin/backup/restore" enctype="multipart/form-data"><label>Select backup JSON file (max 2 MB)</label><input type="file" name="backup" accept=".json,application/json" required><button class="danger">Restore Backup</button></form></section>`,true));});
app.get("/admin/backup/download",adminOnly,(req,res)=>{res.setHeader("Content-Type","application/json");res.setHeader("Content-Disposition",`attachment; filename="dpboss-backup-${new Date().toISOString().slice(0,10)}.json"`);res.send(JSON.stringify(readStore(),null,2));});
app.post("/admin/backup/restore",adminOnly,upload.single("backup"),async (req,res)=>{try{if(!req.file)throw Error("Choose a backup file.");const s=JSON.parse(req.file.buffer.toString("utf8"));if(!s||!Array.isArray(s.markets)||!Number.isInteger(s.nextId)||!Array.isArray(s.logs))throw Error("File is not a valid DPBOSS backup.");for(const m of s.markets){if(!m.id||!m.name||!validTime(m.openTime)||!validTime(m.closeTime)||!Array.isArray(m.results))throw Error("Backup market data is invalid.");for(const r of m.results){if(!validDate(r.date)||!validPanna(r.openPanna)||!validPanna(r.closePanna)||typeof r.published!=="boolean")throw Error("Backup result data is invalid.");}}logAction(s,"Backup restored","Data restored from uploaded JSON backup");if(!await writeStore(s))throw Error("Database save failed; restore was not confirmed.");req.session.flash="Backup restored successfully.";res.redirect("/admin/backup");}catch(e){req.session.flash="Restore failed: "+e.message;res.redirect("/admin/backup");}});
app.use((err,req,res,next)=>{if(err instanceof multer.MulterError){req.session.flash="Upload failed: file must be under 2 MB.";return res.redirect("/admin/backup");}console.error(err);res.status(500).send("Server error. Check the Termux terminal.");});
initializeDatabase().then(() => {
  app.listen(PORT,"0.0.0.0",()=>{ console.log(`DPBOSS listening on port ${PORT}`); if (process.env.SATTA_API_KEY && process.env.SATTA_DOMAIN_KEY && process.env.SATTA_API_DOMAIN) { autoSyncMarketApi(); setInterval(autoSyncMarketApi, SATTA_API_REFRESH_MS); } });
}).catch(err => {
  console.error("Database initialization failed:", err.message);
  process.exit(1);
});
