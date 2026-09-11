// utils/technicals.js — daily close, 21 EMA, 55 SMA from Yahoo history.

var yahoo = require("./yahoo");

function emaSeries(values, period) {
  if (!values.length) return [];
  var k = 2 / (period + 1);
  var out = [values[0]];
  for (var i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function sma(values, period) {
  if (values.length < period) return null;
  var slice = values.slice(-period);
  var sum = 0;
  for (var i = 0; i < slice.length; i++) sum += slice[i];
  return sum / period;
}

function pctDist(price, level) {
  if (!price || !level) return 0;
  return ((price - level) / level) * 100;
}

function parseDailyCloses(chartJson) {
  try {
    var result = chartJson.chart && chartJson.chart.result && chartJson.chart.result[0];
    if (!result) return null;
    var quotes = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!quotes || !quotes.close) return null;
    var closes = [];
    for (var i = 0; i < quotes.close.length; i++) {
      var c = quotes.close[i];
      if (c !== null && c !== undefined && c > 0) closes.push(parseFloat(c));
    }
    if (closes.length < 56) return null;
    return closes;
  } catch (e) {
    return null;
  }
}

function analyzeSnapshot(ticker, closes) {
  var close = closes[closes.length - 1];
  var prev = closes[closes.length - 2];
  var emaArr = emaSeries(closes, 21);
  var ema21 = emaArr[emaArr.length - 1];
  var ema21Prev = emaArr[emaArr.length - 2];
  var sma55 = sma(closes, 55);
  var changePct = prev > 0 ? ((close - prev) / prev) * 100 : 0;
  var distEma = pctDist(close, ema21);
  var distSma = pctDist(close, sma55);
  var prevAboveEma = prev >= ema21Prev;
  var nowAboveEma = close >= ema21;
  var emaCross = prevAboveEma !== nowAboveEma;

  var reasons = [];
  if (Math.abs(changePct) >= 1.25) reasons.push("big day");
  if (Math.abs(distEma) <= 0.75) reasons.push("near 21 EMA");
  if (Math.abs(distSma) <= 0.75) reasons.push("near 55 SMA");
  if (emaCross) reasons.push("21 EMA cross");

  var aboveBoth = close >= ema21 && close >= sma55;
  var belowBoth = close <= ema21 && close <= sma55;
  var trend = aboveBoth ? "above both" : belowBoth ? "below both" : "mixed";

  return {
    ticker: ticker,
    close: close,
    prevClose: prev,
    changePct: changePct,
    ema21: ema21,
    sma55: sma55,
    distEma21Pct: distEma,
    distSma55Pct: distSma,
    emaCross: emaCross,
    trend: trend,
    notable: reasons.length > 0,
    notableReasons: reasons
  };
}

function getSnapshot(ticker) {
  var display = yahoo.displaySymbol(ticker);
  return yahoo.getDailyCloses(ticker).then(function(closes) {
    if (!closes) return null;
    var snap = analyzeSnapshot(display, closes);
    snap.ticker = ticker;
    snap.display = display;
    return snap;
  });
}

function getSnapshots(tickers) {
  var list = tickers || [];
  var out = [];
  var chain = Promise.resolve();
  list.forEach(function(t) {
    chain = chain.then(function() {
      return getSnapshot(t).then(function(s) {
        if (s) out.push(s);
        return new Promise(function(r) { setTimeout(r, 120); });
      });
    });
  });
  return chain.then(function() { return out; });
}

function formatCompact(s) {
  if (!s) return "";
  var chg = (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(2) + "%";
  var emaD = (s.distEma21Pct >= 0 ? "+" : "") + s.distEma21Pct.toFixed(2) + "%";
  var smaD = (s.distSma55Pct >= 0 ? "+" : "") + s.distSma55Pct.toFixed(2) + "%";
  var flag = s.notable ? " ⚡" : "";
  return "**" + s.display + "** $" + s.close.toFixed(2) + " (" + chg + ")\n"
    + "21 EMA $" + s.ema21.toFixed(2) + " (" + emaD + ") · "
    + "55 SMA $" + s.sma55.toFixed(2) + " (" + smaD + ")\n"
    + "Trend: " + s.trend + flag;
}

function formatOneLine(s) {
  if (!s) return "";
  var chg = (s.changePct >= 0 ? "+" : "") + s.changePct.toFixed(2) + "%";
  return s.display + " $" + s.close.toFixed(2) + " " + chg
    + " | EMA21 $" + s.ema21.toFixed(2)
    + " | SMA55 $" + s.sma55.toFixed(2)
    + (s.notable ? " ⚡" : "");
}

module.exports = {
  getSnapshot: getSnapshot,
  getSnapshots: getSnapshots,
  formatCompact: formatCompact,
  formatOneLine: formatOneLine
};
