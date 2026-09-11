// utils/orb.js
// Server-side Opening Range capture (5-min bar, 9:30–9:35 ET per strategy spec).
// Yahoo fallback when orb_set webhook omits orb_high/orb_low.

var yahoo = require("./yahoo");
var stateModule = require("./state");
var exitlogic = require("./exitlogic");

var discord = null;
try { discord = require("./discord"); } catch (e) { discord = null; }

var ORB_INTERVAL = process.env.ORB_INTERVAL || "5m";
var ORB_POLL_MS = 60000;
var ORB_OPEN_MIN = 9 * 60 + 30;   // 9:30 AM ET bar start
var ORB_READY_MIN = 9 * 60 + 35;  // wait for 5m bar to close

function etDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

function barStartMinutesET(unixSec) {
  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit"
  }).formatToParts(new Date(unixSec * 1000));
  var hour = 0;
  var minute = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === "hour") hour = parseInt(parts[i].value, 10);
    if (parts[i].type === "minute") minute = parseInt(parts[i].value, 10);
  }
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

function isValidRange(high, low) {
  var h = parseFloat(high);
  var l = parseFloat(low);
  if (!isFinite(h) || !isFinite(l) || h <= 0 || l <= 0) return false;
  return h > l;
}

function fetchOpeningRange(ticker) {
  if (!exitlogic.isTradingDayET()) return Promise.resolve(null);
  if (exitlogic.etMinutesOfDay() < ORB_READY_MIN) {
    return Promise.resolve(null);
  }
  return yahoo.getChart(ticker, ORB_INTERVAL, "1d").then(function(parsed) {
    try {
      if (!parsed) return null;
      var result = parsed.chart && parsed.chart.result && parsed.chart.result[0];
      if (!result) return null;
      var ts = result.timestamp || [];
      var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
      if (!q) return null;
      var regStart = result.meta && result.meta.currentTradingPeriod &&
                     result.meta.currentTradingPeriod.regular &&
                     result.meta.currentTradingPeriod.regular.start;

      // Prefer the 9:30–9:35 ET opening bar once it has a real range.
      for (var i = 0; i < ts.length; i++) {
        if (regStart && ts[i] < regStart) continue;
        if (barStartMinutesET(ts[i]) !== ORB_OPEN_MIN) continue;
        if (isValidRange(q.high[i], q.low[i])) {
          return { high: q.high[i], low: q.low[i] };
        }
      }

      // Fallback: first regular-session bar with high > low (still rejects flat bars).
      for (var j = 0; j < ts.length; j++) {
        if (regStart && ts[j] < regStart) continue;
        if (isValidRange(q.high[j], q.low[j])) {
          return { high: q.high[j], low: q.low[j] };
        }
      }
      return null;
    } catch (e) { return null; }
  });
}

async function announceOrb(ticker, high, low, source) {
  try {
    if (discord && typeof discord.onOrbSet === "function") {
      await discord.onOrbSet(ticker, high, low, (high + low) / 2, source);
    }
  } catch (e) {
    console.log("[DISCORD_ORB_ERROR] " + ticker + ": " + e.message);
  }
}

async function populateTicker(ticker, force) {
  var s = stateModule.getState();
  var today = etDate();
  var orb = s.orb && s.orb[ticker];
  if (!force && orb && orb.set && orb.date === today) {
    return { ticker: ticker, set: true, skipped: true };
  }
  var range = await fetchOpeningRange(ticker);
  if (range && isValidRange(range.high, range.low)) {
    stateModule.setORB(ticker, range.high, range.low, "yahoo");
    await announceOrb(ticker, range.high, range.low, "yahoo");
    return { ticker: ticker, set: true, high: range.high, low: range.low, source: "yahoo" };
  }
  return { ticker: ticker, set: false, reason: "opening-range data not available yet" };
}

async function populateIfNeeded(force) {
  return [
    await populateTicker("SPY", force),
    await populateTicker("IWM", force),
    await populateTicker("QQQ", force),
    await populateTicker("SPX", force)
  ];
}

function scheduleORBCapture() {
  stateModule.logEvent("ORB", "Opening-range auto-capture started (" + ORB_INTERVAL + " Yahoo fallback)");
  function run() {
    populateIfNeeded(false).then(function(results) {
      results.forEach(function(r) {
        if (r.set && !r.skipped) {
          stateModule.logEvent("ORB", r.ticker + " ORB captured via Yahoo High=" + r.high + " Low=" + r.low);
        }
      });
    }).catch(function(e) {
      stateModule.logEvent("ORB_ERROR", "Capture poll failed: " + e.message);
    }).finally(function() {
      setTimeout(run, ORB_POLL_MS);
    });
  }
  setTimeout(run, 10000);
}

async function ensureOrbForTicker(ticker) {
  var s = stateModule.getState();
  var today = etDate();
  var orb = s.orb && s.orb[ticker];
  if (orb && orb.set && orb.high && orb.low && orb.date === today) {
    return { high: orb.high, low: orb.low, source: orb.source || "cached" };
  }
  var result = await populateTicker(ticker, false);
  s = stateModule.getState();
  orb = s.orb && s.orb[ticker];
  if (result.set && orb && orb.high && orb.low) {
    return { high: orb.high, low: orb.low, source: result.source || orb.source || "yahoo" };
  }
  return null;
}

module.exports = {
  fetchOpeningRange: fetchOpeningRange,
  populateIfNeeded: populateIfNeeded,
  scheduleORBCapture: scheduleORBCapture,
  ensureOrbForTicker: ensureOrbForTicker,
  isValidRange: isValidRange,
  barStartMinutesET: barStartMinutesET
};
