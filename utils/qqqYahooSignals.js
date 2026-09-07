// Yahoo Finance ORB breakout monitor — QQQ paper Discord channel only.
// Fires the same events TradingView would until QQQ TV alerts are wired.
// Disable with QQQ_YAHOO_SIGNALS=0 in Railway once TradingView is set up.

var fs = require("fs");
var yahoo = require("./yahoo");
var orbUtil = require("./orb");
var exitlogic = require("./exitlogic");
var stateModule = require("./state");
var persist = require("./persist");
var paperLegs = require("./paperLegs");

var TICKER = "QQQ";
var BAR_SEC = 5 * 60;
var POLL_MS = 10000;
var ORB_READY_MIN = 9 * 60 + 35;
var STATE_FILE = persist.filePath("qqq-yahoo-signals.json");

var busy = false;
var _state = { lastBarTs: null, date: null };

function enabled() {
  return process.env.QQQ_YAHOO_SIGNALS !== "0";
}

function etDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var d = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (d && typeof d === "object") _state = d;
    }
  } catch (e) {}
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state));
  } catch (e) {
    console.log("[QQQ_YAHOO] state save failed: " + e.message);
  }
}

function resetStateIfNewDay() {
  var today = etDate();
  if (_state.date !== today) {
    _state = { lastBarTs: null, date: today };
    saveState();
  }
}

// Pure signal logic — mirrors TV ORB: stop at mid, breakout at range bounds.
function pickSignalEvent(close, orbHigh, orbLow, paperSide) {
  var c = parseFloat(close);
  var h = parseFloat(orbHigh);
  var l = parseFloat(orbLow);
  if (!isFinite(c) || !isFinite(h) || !isFinite(l) || h <= l) return null;
  var mid = (h + l) / 2;
  if (paperSide === "call" && c < mid) return "stop_long";
  if (paperSide === "put" && c > mid) return "stop_short";
  if (c > h) return "breakout_long";
  if (c < l) return "breakout_short";
  return null;
}

function getLatestClosedBar(chartData, nowSec) {
  if (!chartData || !chartData.chart || !chartData.chart.result || !chartData.chart.result[0]) return null;
  var result = chartData.chart.result[0];
  var ts = result.timestamp || [];
  var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!q || !ts.length) return null;
  var regStart = result.meta && result.meta.currentTradingPeriod &&
    result.meta.currentTradingPeriod.regular &&
    result.meta.currentTradingPeriod.regular.start;
  nowSec = nowSec != null ? nowSec : Date.now() / 1000;
  var closed = null;
  for (var i = 0; i < ts.length; i++) {
    if (regStart && ts[i] < regStart) continue;
    if (q.close[i] == null || isNaN(parseFloat(q.close[i]))) continue;
    if (ts[i] + BAR_SEC > nowSec) continue;
    closed = {
      ts: ts[i],
      close: parseFloat(q.close[i]),
      high: q.high[i] != null ? parseFloat(q.high[i]) : null,
      low: q.low[i] != null ? parseFloat(q.low[i]) : null
    };
  }
  return closed;
}

function getQqqPaperSide() {
  try {
    var discord = require("./discord");
    if (typeof discord.getChannels !== "function") return null;
    var chans = discord.getChannels();
    for (var i = 0; i < chans.length; i++) {
      if (chans[i].cfg.id !== "qqq") continue;
      var keys = paperLegs.listLegsForTrade(chans[i].account.positions, TICKER);
      if (!keys.length) return null;
      var pos = chans[i].account.positions[keys[0]];
      return pos && pos.contracts > 0 ? pos.side : null;
    }
  } catch (e) {}
  return null;
}

async function evaluateBar(bar) {
  if (!bar || !bar.ts) return null;
  resetStateIfNewDay();
  if (_state.lastBarTs === bar.ts) return null;

  var levels = await orbUtil.ensureOrbForTicker(TICKER);
  if (!levels || !(levels.high > 0) || !(levels.low > 0)) return null;

  var paperSide = getQqqPaperSide();
  var event = pickSignalEvent(bar.close, levels.high, levels.low, paperSide);
  if (!event) return null;

  _state.lastBarTs = bar.ts;
  _state.date = etDate();
  saveState();

  var payload = {
    ticker: TICKER,
    event: event,
    close: bar.close,
    orb_high: levels.high,
    orb_low: levels.low
  };

  stateModule.logEvent("QQQ_YAHOO", event + " @ $" + bar.close.toFixed(2) +
    " (Yahoo 5m bar) ORB $" + levels.low.toFixed(2) + "-$" + levels.high.toFixed(2));

  var handleAlert = require("../routes/alert").handleAlert;
  var result = await handleAlert(payload);
  console.log("[QQQ_YAHOO]", event, JSON.stringify(result));
  return { event: event, result: result, bar: bar };
}

async function poll() {
  if (!enabled()) return null;
  if (!exitlogic.isRegularMarketHours()) return null;
  if (exitlogic.etMinutesOfDay() < ORB_READY_MIN) return null;
  if (busy) return null;
  busy = true;
  try {
    var chart = await yahoo.getChart(TICKER, "5m", "1d");
    var bar = getLatestClosedBar(chart);
    if (!bar) return null;
    return await evaluateBar(bar);
  } catch (e) {
    console.log("[QQQ_YAHOO_ERROR]", e.message);
    return null;
  } finally {
    busy = false;
  }
}

function startQqqYahooSignals() {
  loadState();
  resetStateIfNewDay();
  if (!enabled()) {
    console.log("[QQQ_YAHOO] disabled — set QQQ_YAHOO_SIGNALS=0 only after TradingView QQQ alerts are live");
    return;
  }
  console.log("[QQQ_YAHOO] QQQ paper signals via Yahoo 5m ORB (poll " + (POLL_MS / 1000) + "s) — disable with QQQ_YAHOO_SIGNALS=0 when TV is wired");
  setInterval(poll, POLL_MS);
  setTimeout(poll, 20000);
}

module.exports = {
  enabled: enabled,
  startQqqYahooSignals: startQqqYahooSignals,
  poll: poll,
  pickSignalEvent: pickSignalEvent,
  getLatestClosedBar: getLatestClosedBar,
  evaluateBar: evaluateBar
};
