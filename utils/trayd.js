var rh = require("./robinhood");
var yahoo = require("./yahoo");
var stateModule = require("./state");
var expiryUtil = require("./expiry");
var paperLegs = require("./paperLegs");

function getExpiry(ticker) {
  return expiryUtil.getExpiry(ticker);
}

async function resolveUnderlying(ticker) {
  var price = await rh.getQuote(ticker);
  if (price && price > 0) return price;
  var y = await yahoo.getUnderlyingPrice(ticker);
  if (y && y > 0) {
    console.log("[ORDER] " + ticker + " RH quote unavailable — Yahoo underlying $" + y.toFixed(2));
    return y;
  }
  return 0;
}

async function resolveEntryPrice(instrumentUrl, limitPrice) {
  if (instrumentUrl) {
    try {
      var mark = await rh.getOptionMarkByUrl(instrumentUrl);
      if (mark && mark > 0) return mark;
    } catch (e) {}
  }
  var lp = parseFloat(limitPrice);
  return lp > 0 ? lp : 0;
}

async function placeOrder(opts) {
  var expiry = opts.expiry || getExpiry(opts.ticker);
  var price = await resolveUnderlying(opts.ticker);
  var strike = opts.strike != null ? Math.round(parseFloat(opts.strike)) : Math.round(price);
  if (strike <= 0) throw new Error("Could not resolve underlying price for " + opts.ticker + " — check RH_TOKEN");
  console.log("[ORDER] " + opts.ticker + " " + opts.side + " x" + opts.contracts +
    " strike=" + strike + " expiry=" + expiry + (opts.dteTag != null ? (" dte=" + opts.dteTag) : ""));
  var result = await rh.placeOptionOrder(opts.ticker, opts.side, opts.contracts, expiry, strike, opts.side);
  var entryPrice = 0;
  if (result.order_id) {
    entryPrice = await rh.waitForFillPrice(result.order_id, result.instrumentUrl);
  }
  if (!entryPrice) entryPrice = await resolveEntryPrice(result.instrumentUrl, result.price);
  return {
    ticker: opts.ticker,
    side: opts.side,
    strike: result.strike || strike,
    expiry: result.expiry || expiry,
    contracts: opts.contracts,
    entryPrice: entryPrice,
    instrumentUrl: result.instrumentUrl || null,
    dteTag: opts.dteTag != null ? opts.dteTag : null,
    result: result
  };
}

async function placeDualLegEntry(ticker, side, contractsPerLeg) {
  var qty = Math.max(1, Math.floor(parseFloat(contractsPerLeg) || 1));
  var und = await resolveUnderlying(ticker);
  if (!(und > 0)) throw new Error("No underlying for dual-leg " + ticker);
  var moves = await paperLegs.getEntryMoveTargets(ticker);
  var strike0 = paperLegs.strikeForLegTicker(ticker, side, 0, und, moves);
  var strike1 = paperLegs.strikeForLegTicker(ticker, side, 1, und, moves);
  var exp0 = expiryUtil.getExpiryForDTE(0);
  var exp1 = expiryUtil.getExpiryForDTE(1);

  var leg0 = await placeOrder({
    ticker: ticker, side: side, contracts: qty,
    expiry: exp0, strike: strike0, dteTag: 0
  });
  var leg1 = null;
  try {
    leg1 = await placeOrder({
      ticker: ticker, side: side, contracts: qty,
      expiry: exp1, strike: strike1, dteTag: 1
    });
  } catch (e) {
    console.log("[ORDER] " + ticker + " 1DTE leg failed after 0DTE filled: " + e.message);
    return {
      dual: true,
      partial: true,
      legs: [leg0],
      order: leg0,
      error: e.message
    };
  }
  return { dual: true, partial: false, legs: [leg0, leg1], order: leg0 };
}

async function placeDualLegAdd(ticker, side, contractsPerLeg, existingLegs) {
  var qty = Math.max(1, Math.floor(parseFloat(contractsPerLeg) || 1));
  var legs = existingLegs || [];
  if (!legs.length) return placeDualLegEntry(ticker, side, qty);
  var out = [];
  for (var i = 0; i < legs.length; i++) {
    var src = legs[i];
    if (!src || src.strike == null) continue;
    var filled = await placeOrder({
      ticker: ticker,
      side: side,
      contracts: qty,
      expiry: src.expiry || expiryUtil.getExpiryForDTE(src.dteTag != null ? src.dteTag : 0),
      strike: src.strike,
      dteTag: src.dteTag != null ? src.dteTag : i
    });
    out.push(filled);
  }
  if (!out.length) throw new Error("No dual-leg contracts to add for " + ticker);
  return { dual: true, partial: out.length < legs.length, legs: out, order: out[0] };
}

function closeMatchFromState(ticker) {
  var pos = stateModule.getPosition(ticker);
  if (!pos || pos.stopped) return {};
  return {
    side: pos.side,
    strike: pos.strike,
    expiry: pos.expiry,
    instrumentUrl: pos.instrumentUrl
  };
}

async function closePartialPosition(opts) {
  console.log("[CLOSE] " + opts.ticker + " selling " + opts.contracts + "c: " + opts.reason);
  var match = opts.match || closeMatchFromState(opts.ticker);
  return await rh.closeOptionPosition(opts.ticker, opts.contracts, opts.reason, match);
}

async function closeLiveOrLog(ticker, contracts, reason, matchOverride) {
  try {
    var result = await closePartialPosition({
      ticker: ticker,
      contracts: contracts,
      reason: reason,
      match: matchOverride || null
    });
    if (result && result.ok === false) {
      stateModule.logEvent("ORDER_ERROR", ticker + " RH close failed: " + (result.error || "no matching position"));
      return false;
    }
    return true;
  } catch (e) {
    stateModule.logEvent("ORDER_ERROR", ticker + " RH close failed: " + e.message);
    return false;
  }
}

async function closeAllLegs(ticker, reason) {
  var pos = stateModule.getPosition(ticker);
  if (!pos || pos.stopped) return false;
  if (pos.legs && pos.legs.length) {
    var any = false;
    var allOk = true;
    for (var i = 0; i < pos.legs.length; i++) {
      var leg = pos.legs[i];
      if (!leg || leg.contracts < 1) continue;
      any = true;
      var ok = await closeLiveOrLog(ticker, leg.contracts, reason, {
        side: leg.side || pos.side,
        strike: leg.strike,
        expiry: leg.expiry,
        instrumentUrl: leg.instrumentUrl
      });
      if (!ok) allOk = false;
    }
    return any ? allOk : false;
  }
  if (!(pos.contracts > 0)) return false;
  return closeLiveOrLog(ticker, pos.contracts, reason);
}

module.exports = {
  placeOrder: placeOrder,
  placeDualLegEntry: placeDualLegEntry,
  placeDualLegAdd: placeDualLegAdd,
  closePartialPosition: closePartialPosition,
  closeLiveOrLog: closeLiveOrLog,
  closeAllLegs: closeAllLegs
};
