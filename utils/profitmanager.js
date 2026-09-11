// Profit Manager — polls open option positions every 10 seconds during market hours.
// Handles: cross-entry ORB level stops, breakeven, +20% scale-outs, EOD 50%, trailing stops.
// Dual-leg (0DTE+1DTE) positions are managed per leg via instrument URL.

var stateModule = require("./state");
var exitlogic = require("./exitlogic");
var trayd = require("./trayd");
var rh = require("./robinhood");
var yahoo = require("./yahoo");
var pnlUtil = require("./pnl");
var reconcile = require("./reconcile");
var liveTickers = require("./liveTickers");

var lastReconcileMs = 0;
var RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function checkCrossEntryStop(ticker, pos, s) {
  if (!pos.crossEntry || !pos.stopMode || pos.stopMode === "mid") return false;
  var orb = s.orb[ticker];
  if (!orb || !orb.set) return false;
  var und = await yahoo.getUnderlyingPrice(ticker);
  if (!und || und <= 0) return false;

  var hit = false;
  var reason = "";
  if (pos.side === "call" && pos.stopMode === "orb_low" && und < orb.low) {
    hit = true;
    reason = "Cross-entry stop — SPY closed below ORB low $" + orb.low.toFixed(2);
  }
  if (pos.side === "put" && pos.stopMode === "orb_high" && und > orb.high) {
    hit = true;
    reason = "Cross-entry stop — SPY closed above ORB high $" + orb.high.toFixed(2);
  }
  if (!hit) return false;

  stateModule.logEvent("STOP_OUT", ticker + " " + reason + " (underlying $" + und.toFixed(2) + ")");
  var rhPositions = await rh.getOpenOptionPositions();
  if (pos.legs && pos.legs.length) {
    for (var i = 0; i < pos.legs.length; i++) {
      var leg = pos.legs[i];
      if (!leg || leg.contracts < 1) continue;
      var match = {
        side: leg.side || pos.side,
        strike: leg.strike,
        expiry: leg.expiry,
        instrumentUrl: leg.instrumentUrl
      };
      var rhLeg = reconcile.findRhPosition(rhPositions, ticker, match);
      var exitPx = 0;
      var url = (rhLeg && rhLeg.option) || leg.instrumentUrl;
      if (url) exitPx = await rh.getOptionMarkByUrl(url) || 0;
      if (exitPx > 0) pnlUtil.logTradePnL(ticker, pos.side, leg.entryPrice, exitPx, leg.contracts);
    }
  } else {
    var rhPos = reconcile.findRhPosition(rhPositions, ticker, pos);
    var exitPrice = 0;
    if (rhPos) exitPrice = await rh.getOptionMarkByUrl(rhPos.option) || 0;
    else if (pos.instrumentUrl) exitPrice = await rh.getOptionMarkByUrl(pos.instrumentUrl) || 0;
    if (exitPrice > 0) {
      pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, exitPrice, pos.contracts);
    } else if (rhPos || pos.instrumentUrl) {
      stateModule.logEvent("PNL_WARN", ticker + " cross-entry stop — no exit mark, P&L skipped");
    }
  }
  var closed = await trayd.closeAllLegs(ticker, reason);
  if (!closed) return false;
  stateModule.closePosition(ticker, reason);
  return true;
}

async function manageOneLeg(ticker, pos, legIndex, rhPositions) {
  var leg = pos.legs[legIndex];
  if (!leg || leg.contracts < 1) return;
  if (!(leg.entryPrice > 0)) {
    console.log("[PROFIT_MGR] " + ticker + " DTE" + leg.dteTag + " waiting for entry price");
    return;
  }

  var match = {
    side: leg.side || pos.side,
    strike: leg.strike,
    expiry: leg.expiry,
    instrumentUrl: leg.instrumentUrl
  };
  var rhPos = reconcile.findRhPosition(rhPositions, ticker, match);
  var instrumentUrl = (rhPos && rhPos.option) || leg.instrumentUrl || null;
  if (!instrumentUrl) {
    console.log("[PROFIT_MGR] No instrument for " + ticker + " DTE" + leg.dteTag);
    return;
  }

  if (rhPos) {
    var qty = Math.floor(rh.optionPositionQty(rhPos));
    if (qty !== leg.contracts) {
      leg.contracts = Math.max(0, qty);
      if (rhPos.option) leg.instrumentUrl = rhPos.option;
      if (rhPos.strike_price) leg.strike = Math.round(parseFloat(rhPos.strike_price));
      if (rhPos.expiration_date) leg.expiry = rhPos.expiration_date;
      stateModule.setPositionLegs(ticker, pos.legs);
      pos = stateModule.getPosition(ticker) || pos;
      leg = pos.legs[legIndex];
      if (!leg || leg.contracts < 1) return;
    }
  }

  var optionPrice = await rh.getOptionMarkByUrl(instrumentUrl);
  if (!optionPrice || optionPrice <= 0) {
    console.log("[PROFIT_MGR] Could not get mark for " + ticker + " DTE" + leg.dteTag);
    return;
  }

  var entryPrice = leg.entryPrice;
  var contracts = leg.contracts;
  var decision = exitlogic.evaluate(leg, optionPrice);
  var gainPct = decision.gain;
  var tag = ticker + " DTE" + leg.dteTag;

  console.log("[PROFIT_MGR] " + tag + " entry=$" + entryPrice.toFixed(2) +
    " current=$" + optionPrice.toFixed(2) + " gain=" + gainPct.toFixed(1) +
    "% tier=" + (leg.lastProfitTier || 0) + " stop=" + decision.newStopPct + "%");

  leg.stopPct = decision.newStopPct;

  if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
    var eodQty = Math.max(1, Math.floor(contracts * exitlogic.EOD_SELL_FRAC));
    stateModule.logEvent("EOD_SELL", tag + " 3:45 ET — selling 50% (" + eodQty + "c)");
    if (!await trayd.closeLiveOrLog(ticker, eodQty, "EOD 50% (15m before close)", match)) return;
    pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, eodQty);
    stateModule.reduceLegContracts(ticker, legIndex, eodQty);
    pos = stateModule.getPosition(ticker);
    if (!pos || pos.contracts <= 0) {
      stateModule.closePosition(ticker, "EOD flat");
      return;
    }
    leg = pos.legs[legIndex];
    if (!leg || leg.contracts < 1) return;
    contracts = leg.contracts;
  }

  if (decision.activateBreakeven) {
    stateModule.setLegBreakEven(ticker, legIndex);
  }

  if (decision.stopOut) {
    var reason = leg.breakEvenActivated || decision.activateBreakeven
      ? "Trailing stop " + decision.newStopPct + "%"
      : "Initial stop -15%";
    stateModule.logEvent("STOP_OUT", tag + " " + reason + " @ $" + optionPrice.toFixed(2)
      + " (gain " + gainPct.toFixed(1) + "%)");
    if (!await trayd.closeLiveOrLog(ticker, contracts, reason, match)) return;
    pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, contracts);
    stateModule.reduceLegContracts(ticker, legIndex, contracts);
    pos = stateModule.getPosition(ticker);
    if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, reason);
    return;
  }

  if (decision.scaleOut) {
    var sellQty = Math.max(1, Math.floor(contracts * decision.sellFraction));
    stateModule.logEvent("PROFIT_TIER", tag + " +" + gainPct.toFixed(1) +
      "% — selling " + Math.round(decision.sellFraction * 100) + "% (" + sellQty + "c) @ $"
      + optionPrice.toFixed(2));
    if (!await trayd.closeLiveOrLog(ticker, sellQty, "+" + Math.floor(gainPct) + "% scale-out", match)) return;
    pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, sellQty);
    stateModule.markLegProfitTier(ticker, legIndex, decision.newTier);
    stateModule.reduceLegContracts(ticker, legIndex, sellQty);
    pos = stateModule.getPosition(ticker);
    if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, "scaled out");
  }
}

async function manageDualLegPosition(ticker, pos, rhPositions) {
  for (var i = 0; i < pos.legs.length; i++) {
    pos = stateModule.getPosition(ticker);
    if (!pos || pos.stopped || !pos.legs) return;
    await manageOneLeg(ticker, pos, i, rhPositions);
  }
  if (exitlogic.isEndOfDayWindow()) {
    pos = stateModule.getPosition(ticker);
    if (pos && !pos.stopped && pos.eodSold !== exitlogic.etDateKey()) {
      // Mark once after all legs had a chance to take the EOD trim this poll.
      var anyLive = (pos.legs || []).some(function(l) { return l && l.contracts > 0; });
      if (anyLive) stateModule.markEodSold(ticker, exitlogic.etDateKey());
    }
  }
}

async function checkProfitTiers() {
  if (!exitlogic.isRegularMarketHours()) return;
  if (!rh.getToken()) return;
  var auth = await rh.checkAuthStatus();
  if (!auth.ok) return;

  var now = Date.now();
  if (now - lastReconcileMs >= RECONCILE_INTERVAL_MS) {
    lastReconcileMs = now;
    try {
      var recon = await reconcile.reconcileRhPositions();
      if (recon.ok && recon.synced && recon.synced.length) {
        stateModule.logEvent("RECONCILE", "mid-session sync: " + recon.synced.join(", "));
      }
    } catch (e) {
      console.log("[RECONCILE_ERROR]", e.message);
    }
  }

  var s = stateModule.getState();
  var tickers = liveTickers.liveTickers();
  var fetched = await rh.fetchOpenOptionPositions();
  var rhPositions = fetched.ok ? (fetched.positions || []) : [];
  if (!fetched.ok) {
    console.log("[PROFIT_MGR] RH positions fetch failed (" + (fetched.error || "unknown")
      + ") — continuing with instrumentUrl marks");
  }

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var pos = stateModule.getPosition(ticker);
    if (!pos || pos.stopped) continue;

    if (await checkCrossEntryStop(ticker, pos, s)) continue;

    if (pos.legs && pos.legs.length) {
      await manageDualLegPosition(ticker, pos, rhPositions);
      continue;
    }

    pos = await reconcile.backfillEntryFromRh(ticker, pos, rhPositions);
    if (!pos || pos.entryPrice <= 0) {
      console.log("[PROFIT_MGR] " + ticker + " waiting for entry price backfill");
      continue;
    }

    var rhPos = reconcile.findRhPosition(rhPositions, ticker, pos);
    var instrumentUrl = (rhPos && rhPos.option) || pos.instrumentUrl || null;

    if (!rhPos && !instrumentUrl) {
      console.log("[PROFIT_MGR] No RH position or instrumentUrl for " + ticker + " " + pos.side);
      continue;
    }

    if (!rhPos && instrumentUrl) {
      console.log("[PROFIT_MGR] " + ticker + " RH list miss — managing via instrumentUrl mark");
    }

    if (rhPos && Math.floor(rh.optionPositionQty(rhPos)) !== pos.contracts) {
      stateModule.syncPositionQty(ticker, Math.floor(rh.optionPositionQty(rhPos)));
      stateModule.applyOrderFill(ticker, {
        instrumentUrl: rhPos.option,
        strike: rhPos.strike_price,
        expiry: rhPos.expiration_date
      });
      pos = stateModule.getPosition(ticker) || pos;
    }

    var optionPrice = await rh.getOptionMarkByUrl(instrumentUrl);
    if (!optionPrice || optionPrice <= 0) {
      console.log("[PROFIT_MGR] Could not get option price for " + ticker);
      continue;
    }

    var entryPrice = pos.entryPrice;
    var contracts = pos.contracts;
    var decision = exitlogic.evaluate(pos, optionPrice);
    var gainPct = decision.gain;

    console.log("[PROFIT_MGR] " + ticker + " entry=$" + entryPrice.toFixed(2) +
      " current=$" + optionPrice.toFixed(2) + " gain=" + gainPct.toFixed(1) +
      "% tier=" + (pos.lastProfitTier || 0) + " stop=" + decision.newStopPct + "%");

    pos.stopPct = decision.newStopPct;

    if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
      var eodQty = Math.max(1, Math.floor(contracts * exitlogic.EOD_SELL_FRAC));
      stateModule.logEvent("EOD_SELL", ticker + " 3:45 ET — selling 50% (" + eodQty + "c)");
      if (!await trayd.closeLiveOrLog(ticker, eodQty, "EOD 50% (15m before close)")) continue;
      pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, eodQty);
      stateModule.markEodSold(ticker, exitlogic.etDateKey());
      stateModule.reduceContracts(ticker, eodQty);
      if (pos.contracts <= 0) { stateModule.closePosition(ticker, "EOD flat"); continue; }
      contracts = pos.contracts;
    }

    if (decision.activateBreakeven) {
      stateModule.setBreakEven(ticker);
      stateModule.logEvent("BREAKEVEN", ticker + " +30% — stop moved to breakeven $" + entryPrice.toFixed(2));
    }

    if (decision.stopOut && !pos.stopped) {
      var reason = pos.breakEvenActivated
        ? "Trailing stop " + decision.newStopPct + "%"
        : "Initial stop -15%";
      stateModule.logEvent("STOP_OUT", ticker + " " + reason + " @ $" + optionPrice.toFixed(2)
        + " (gain " + gainPct.toFixed(1) + "%)");
      if (!await trayd.closeLiveOrLog(ticker, contracts, reason)) continue;
      pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, contracts);
      stateModule.closePosition(ticker, reason);
      continue;
    }

    if (decision.scaleOut) {
      var sellQty = Math.max(1, Math.floor(contracts * decision.sellFraction));
      stateModule.logEvent("PROFIT_TIER", ticker + " +" + gainPct.toFixed(1) +
        "% — selling " + Math.round(decision.sellFraction * 100) + "% (" + sellQty + "c) @ $"
        + optionPrice.toFixed(2));
      if (!await trayd.closeLiveOrLog(ticker, sellQty, "+" + Math.floor(gainPct) + "% scale-out")) continue;
      pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, sellQty);
      stateModule.markProfitTier(ticker, decision.newTier);
      stateModule.reduceContracts(ticker, sellQty);
      pos = stateModule.getPosition(ticker);
      if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, "scaled out");
    }
  }
}

var profitBusy = false;

function startProfitManager() {
  console.log("[PROFIT_MGR] Starting — checks every 10s during market hours (ET)");
  setInterval(async function() {
    if (profitBusy) return;
    profitBusy = true;
    try {
      await checkProfitTiers();
    } catch (e) {
      console.log("[PROFIT_MGR_ERROR]", e.message);
    } finally {
      profitBusy = false;
    }
  }, 10 * 1000);
}

module.exports = { startProfitManager: startProfitManager, checkProfitTiers: checkProfitTiers };
