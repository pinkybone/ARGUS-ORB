// utils/killswitch.js — halt live entries and flatten open positions.

var settings = require("./settings");
var stateModule = require("./state");
var trayd = require("./trayd");
var rh = require("./robinhood");

async function flattenTicker(ticker, reason) {
  var pos = stateModule.getPosition(ticker);
  var closed = [];
  if (pos && !pos.stopped && pos.contracts > 0) {
    var qty = pos.contracts;
    var ok = await trayd.closeAllLegs(ticker, reason);
    if (ok) {
      stateModule.closePosition(ticker, reason);
      closed.push({ ticker: ticker, contracts: qty, source: "state", ok: true });
    } else {
      closed.push({ ticker: ticker, contracts: qty, source: "state", ok: false });
    }
  }

  try {
    var open = await rh.getOpenOptionPositions();
    var matching = (open || []).filter(function(p) {
      return p.chain_symbol === ticker && rh.optionPositionQty(p) > 0;
    });
    for (var i = 0; i < matching.length; i++) {
      var p = matching[i];
      var q = Math.floor(rh.optionPositionQty(p));
      if (q < 1) continue;
      var res = await trayd.closePartialPosition({
        ticker: ticker,
        contracts: q,
        reason: reason,
        match: {
          side: (p.option_type || p.type || "").toLowerCase(),
          strike: p.strike_price,
          expiry: p.expiration_date,
          instrumentUrl: p.option
        }
      });
      var ok2 = !!(res && res.ok !== false);
      closed.push({ ticker: ticker, contracts: q, source: "rh", ok: ok2 });
      if (ok2 && pos && !pos.stopped) stateModule.closePosition(ticker, reason);
    }
  } catch (e) {
    stateModule.logEvent("KILL_SWITCH", ticker + " RH flatten scan failed: " + e.message);
  }

  return closed;
}

async function flattenAll(reason) {
  reason = reason || "Kill switch flatten";
  settings.setTradingEnabled(false);
  stateModule.logEvent("KILL_SWITCH", "Flatten all — live entries disabled");
  var out = [];
  var tickers = require("./liveTickers").liveTickers();
  for (var i = 0; i < tickers.length; i++) {
    var rows = await flattenTicker(tickers[i], reason);
    out = out.concat(rows);
  }
  return { ok: true, trading_enabled: false, closed: out };
}

function halt() {
  settings.setTradingEnabled(false);
  stateModule.logEvent("KILL_SWITCH", "Live trading halted — entries blocked");
  return { ok: true, trading_enabled: false };
}

function resume() {
  settings.setTradingEnabled(true);
  stateModule.logEvent("KILL_SWITCH", "Live trading resumed");
  return { ok: true, trading_enabled: true };
}

module.exports = { flattenAll: flattenAll, halt: halt, resume: resume };
