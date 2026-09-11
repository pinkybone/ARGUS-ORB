// utils/liveTickers.js
// Central registry for LIVE Robinhood trading symbols.
// Discord/paper channels are separate and may include more tickers.
//
// Current live: SPY, IWM, SPX (SPX mirrors SPY ORB — no SPX webhook)
// Next phase: QQQ

var LIVE_TICKERS = ["SPY", "IWM", "SPX"];

// Planned / gated — enable one-by-one after RH option chain + sizing verified.
var NEXT_LIVE_TICKERS = ["QQQ"];

// Map alert/signal ticker → RH option chain symbol to trade.
// SPX live mirrors SPY signals; RH index weeklies use SPX chain (SPXW aliases to SPX).
var LIVE_TRADE_SYMBOL = {
  SPY: "SPY",
  IWM: "IWM",
  QQQ: "QQQ",
  SPX: "SPX",
  SPXW: "SPX"
};

function liveTickers() {
  var extra = (process.env.LIVE_TICKERS || "")
    .split(",")
    .map(function(s) { return s.trim().toUpperCase(); })
    .filter(Boolean);
  if (!extra.length) return LIVE_TICKERS.slice();
  var out = LIVE_TICKERS.slice();
  extra.forEach(function(t) {
    if (NEXT_LIVE_TICKERS.indexOf(t) !== -1 && out.indexOf(t) === -1) out.push(t);
    if (LIVE_TICKERS.indexOf(t) !== -1 && out.indexOf(t) === -1) out.push(t);
  });
  return out;
}

function isLiveTicker(ticker) {
  return liveTickers().indexOf(String(ticker || "").toUpperCase()) !== -1;
}


function chainSymbolsFor(ticker) {
  var t = String(ticker || "").toUpperCase();
  if (t === "SPX" || t === "SPXW") return ["SPX", "SPXW"];
  return [t];
}

function matchesChainSymbol(chainSymbol, ticker) {
  return chainSymbolsFor(ticker).indexOf(String(chainSymbol || "").toUpperCase()) !== -1;
}

function tradeSymbolFor(ticker) {
  var t = String(ticker || "").toUpperCase();
  return LIVE_TRADE_SYMBOL[t] || t;
}

function emptyPositionMap() {
  var m = {};
  liveTickers().forEach(function(t) { m[t] = null; });
  return m;
}

function defaultContracts() {
  var m = {};
  liveTickers().forEach(function(t) { m[t] = 1; });
  return m;
}

module.exports = {
  LIVE_TICKERS: LIVE_TICKERS,
  NEXT_LIVE_TICKERS: NEXT_LIVE_TICKERS,
  liveTickers: liveTickers,
  isLiveTicker: isLiveTicker,
  tradeSymbolFor: tradeSymbolFor,
  chainSymbolsFor: chainSymbolsFor,
  matchesChainSymbol: matchesChainSymbol,
  emptyPositionMap: emptyPositionMap,
  defaultContracts: defaultContracts
};
