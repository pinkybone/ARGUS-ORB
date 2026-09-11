// utils/settings.js
// App settings persisted to durable storage (survives redeploys when a Railway
// volume is attached). Currently holds per-ticker DTE, set from the dashboard.

var fs = require("fs");
var persist = require("./persist");
var FILE = persist.filePath("orb-settings.json");

var DEFAULTS = {
  dte: { SPY: 1, IWM: 0 },
  trading_enabled: true,
  dual_leg_live: false,
  cross_entry_enabled: true,
  // Per-ticker live buys (entries/adds). Stops/exits still run when off.
  buy_enabled: { SPY: true, IWM: true, SPX: true }
};

function deepDefault() { return JSON.parse(JSON.stringify(DEFAULTS)); }

function normalizeBuyEnabled(map) {
  map = map || {};
  return {
    SPY: map.SPY !== false,
    IWM: map.IWM !== false,
    SPX: map.SPX !== false
  };
}

function normalize(s) {
  s = s || {};
  s.dte = s.dte || {};
  if (typeof s.dte.SPY !== "number") s.dte.SPY = DEFAULTS.dte.SPY;
  if (typeof s.dte.IWM !== "number") s.dte.IWM = DEFAULTS.dte.IWM;
  if (typeof s.trading_enabled !== "boolean") s.trading_enabled = DEFAULTS.trading_enabled;
  if (typeof s.dual_leg_live !== "boolean") s.dual_leg_live = DEFAULTS.dual_leg_live;
  if (typeof s.cross_entry_enabled !== "boolean") s.cross_entry_enabled = DEFAULTS.cross_entry_enabled;
  s.buy_enabled = normalizeBuyEnabled(s.buy_enabled);
  return s;
}

function load() {
  try {
    if (fs.existsSync(FILE)) return normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (e) { console.log("[SETTINGS] load failed: " + e.message); }
  return deepDefault();
}

var settings = load();

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(settings)); }
  catch (e) { console.log("[SETTINGS] save failed: " + e.message); }
}

function getDTE(ticker) {
  var t = String(ticker || "").toUpperCase();
  if (t === "SPX" || t === "SPXW") t = "SPY";
  var v = settings.dte[t];
  return typeof v === "number" ? v : (t === "SPY" ? 1 : 0);
}

function setDTE(ticker, val) {
  var n = parseInt(val, 10);
  if (isNaN(n) || n < 0 || n > 5) return getDTE(ticker);
  settings.dte[ticker] = n;
  save();
  return n;
}

function getAll() {
  return {
    dte: { SPY: getDTE("SPY"), IWM: getDTE("IWM") },
    trading_enabled: isTradingEnabled(),
    dual_leg_live: isDualLegLive(),
    cross_entry_enabled: isCrossEntryEnabled(),
    buy_enabled: getBuyEnabled(),
    durable: persist.isDurable()
  };
}

function isTradingEnabled() {
  return settings.trading_enabled !== false;
}

function setTradingEnabled(on) {
  settings.trading_enabled = !!on;
  save();
  return settings.trading_enabled;
}

function isDualLegLive() {
  return settings.dual_leg_live === true;
}

function setDualLegLive(on) {
  settings.dual_leg_live = !!on;
  save();
  return settings.dual_leg_live;
}

function isCrossEntryEnabled() {
  return settings.cross_entry_enabled !== false;
}

function setCrossEntryEnabled(on) {
  settings.cross_entry_enabled = !!on;
  save();
  return settings.cross_entry_enabled;
}

function buyTickerKey(ticker) {
  var t = String(ticker || "").toUpperCase();
  if (t === "SPXW") t = "SPX";
  if (t === "SPY" || t === "IWM" || t === "SPX") return t;
  return null;
}

function getBuyEnabled() {
  return normalizeBuyEnabled(settings.buy_enabled);
}

function isBuyEnabled(ticker) {
  var key = buyTickerKey(ticker);
  if (!key) return true;
  var map = getBuyEnabled();
  return map[key] !== false;
}

function setBuyEnabled(ticker, on) {
  var key = buyTickerKey(ticker);
  if (!key) return getBuyEnabled();
  settings.buy_enabled = normalizeBuyEnabled(settings.buy_enabled);
  settings.buy_enabled[key] = !!on;
  save();
  return getBuyEnabled();
}

function setBuyEnabledMap(map) {
  var cur = getBuyEnabled();
  if (!map || typeof map !== "object") return cur;
  ["SPY", "IWM", "SPX"].forEach(function(t) {
    if (map[t] !== undefined) cur[t] = !!map[t];
  });
  settings.buy_enabled = normalizeBuyEnabled(cur);
  save();
  return getBuyEnabled();
}

module.exports = {
  getDTE: getDTE,
  setDTE: setDTE,
  getAll: getAll,
  isTradingEnabled: isTradingEnabled,
  setTradingEnabled: setTradingEnabled,
  isDualLegLive: isDualLegLive,
  setDualLegLive: setDualLegLive,
  isCrossEntryEnabled: isCrossEntryEnabled,
  setCrossEntryEnabled: setCrossEntryEnabled,
  getBuyEnabled: getBuyEnabled,
  isBuyEnabled: isBuyEnabled,
  setBuyEnabled: setBuyEnabled,
  setBuyEnabledMap: setBuyEnabledMap,
  FILE: FILE
};
