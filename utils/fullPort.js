// Full-port sizing: spend available buying power on the maximum whole ATM contracts.
// Never sizes fractional contracts. Pads premium so live asks still fit in BP.

var yahoo = require("./yahoo");
var expiryUtil = require("./expiry");
var settings = require("./settings");

var MAX_CONTRACTS = 100;
// Leave a little BP headroom + pad premium so ask fills don't reject for BP / "partial".
var BP_UTILIZATION = 0.985;
var PREMIUM_PAD = 1.05;

function wholeContracts(n) {
  var x = Math.floor(Number(n) || 0);
  return x > 0 ? x : 0;
}

// Prefer even totals so half-entry + retest (ceil/floor halves) never need a fractional add.
function preferEvenContracts(n) {
  var x = wholeContracts(n);
  if (x > 1 && x % 2 === 1) x -= 1;
  return x;
}

function costPerContractUnit(premium, dualLeg) {
  var prem = parseFloat(premium);
  if (!(prem > 0)) return Infinity;
  var cost = prem * 100;
  if (dualLeg) cost *= 2;
  return cost;
}

function contractsFromBuyingPower(buyingPower, premium, opts) {
  opts = opts || {};
  var bp = parseFloat(buyingPower);
  var prem = parseFloat(premium);
  if (!(bp > 0) || !(prem > 0)) return 0;

  var util = opts.bpUtilization != null ? parseFloat(opts.bpUtilization) : BP_UTILIZATION;
  var pad = opts.premiumPad != null ? parseFloat(opts.premiumPad) : PREMIUM_PAD;
  if (!(util > 0) || util > 1) util = BP_UTILIZATION;
  if (!(pad >= 1)) pad = PREMIUM_PAD;

  var usable = bp * util;
  var sizedPrem = prem * pad;
  var costPerUnit = costPerContractUnit(sizedPrem, !!opts.dualLeg);
  if (!(costPerUnit > 0) || !isFinite(costPerUnit)) return 0;

  var n = preferEvenContracts(Math.floor(usable / costPerUnit));
  // If pad/evening wiped a viable 1-lot, fall back to a single whole contract when raw BP allows.
  if (n < 1) {
    var raw = Math.floor(bp / costPerContractUnit(prem, !!opts.dualLeg));
    if (raw >= 1) n = 1;
  }
  if (n < 1) return 0;
  return Math.min(MAX_CONTRACTS, n);
}

async function estimateAtmPremium(ticker) {
  var t = String(ticker || "").toUpperCase();
  var quoteTicker = t === "SPX" || t === "SPXW" ? "SPX" : t;
  var dte = expiryUtil.getDTE(t === "SPX" || t === "SPXW" ? "SPY" : t);
  var expiry = expiryUtil.getExpiryForDTE(dte);
  var straddle = await yahoo.getATMStraddle(quoteTicker, expiry);
  if (straddle && straddle.callPrice > 0) {
    return {
      premium: straddle.callPrice,
      putPremium: straddle.putPrice || null,
      strike: straddle.strike,
      expiry: straddle.expiry || expiry,
      underlying: straddle.price || null
    };
  }
  if (dte !== 0) {
    var exp0 = expiryUtil.getExpiryForDTE(0);
    var s0 = await yahoo.getATMStraddle(quoteTicker, exp0);
    if (s0 && s0.callPrice > 0) {
      return {
        premium: s0.callPrice,
        putPremium: s0.putPrice || null,
        strike: s0.strike,
        expiry: s0.expiry || exp0,
        underlying: s0.price || null
      };
    }
  }
  return null;
}

function packResult(t, contracts, est, bp, dualLeg, extra) {
  var costPer = costPerContractUnit(est.premium, dualLeg);
  var out = {
    ok: true,
    ticker: t,
    contracts: contracts,
    premium: est.premium,
    strike: est.strike,
    expiry: est.expiry,
    underlying: est.underlying,
    buyingPower: bp,
    dualLeg: dualLeg,
    estimatedCost: parseFloat((contracts * costPer).toFixed(2)),
    wholeContractsOnly: true,
    premiumPad: PREMIUM_PAD,
    bpUtilization: BP_UTILIZATION,
    note: dualLeg
      ? "Max whole contracts for dual-leg (0DTE+1DTE) — no fractional size"
      : "Max whole contracts for single-leg — no fractional size"
  };
  if (extra) {
    Object.keys(extra).forEach(function(k) { out[k] = extra[k]; });
  }
  return out;
}

async function computeFullPort(ticker, buyingPower, opts) {
  opts = opts || {};
  var t = String(ticker || "").toUpperCase();
  if (t !== "SPY" && t !== "IWM" && t !== "SPX") {
    return { ok: false, error: "full-port supports SPY, IWM, or SPX" };
  }
  var bp = parseFloat(buyingPower);
  if (!(bp > 0)) return { ok: false, error: "buying power unavailable" };

  var dualLeg = opts.dualLeg != null ? !!opts.dualLeg : settings.isDualLegLive();
  var crossEntry = opts.crossEntry != null ? !!opts.crossEntry : settings.isCrossEntryEnabled();

  var est = await estimateAtmPremium(t === "SPX" ? "SPX" : t);
  if (t === "SPX" && (!est || !(est.premium > 0))) {
    // Fallback: scale SPY ATM if SPX chain quotes are unavailable.
    var spyEst = await estimateAtmPremium("SPY");
    if (spyEst && spyEst.premium > 0) {
      est = {
        premium: spyEst.premium * 10,
        putPremium: spyEst.putPremium != null ? spyEst.putPremium * 10 : null,
        strike: spyEst.strike != null ? Math.round(spyEst.strike * 10) : null,
        expiry: spyEst.expiry,
        underlying: spyEst.underlying != null ? spyEst.underlying * 10 : null,
        proxy: "SPY"
      };
    }
  }
  if (!est || !(est.premium > 0)) {
    return { ok: false, error: "could not estimate ATM option premium for " + t };
  }

  // IWM full-port with cross-entry ON: reserve BP so IWM→SPY cross can also fill
  // whole contracts (no partial SPY add that would reject).
  if (t === "IWM" && crossEntry) {
    var spyPremEst = await estimateAtmPremium("SPY");
    if (spyPremEst && spyPremEst.premium > 0) {
      var iwmBp = bp * 0.55;
      var spyBp = bp * 0.45;
      var iwmC = contractsFromBuyingPower(iwmBp, est.premium, { dualLeg: dualLeg });
      var spyC = contractsFromBuyingPower(spyBp, spyPremEst.premium, { dualLeg: dualLeg });
      if (iwmC < 1 && spyC < 1) {
        // Not enough for a split — fall through to IWM-only max.
      } else {
        if (iwmC < 1) iwmC = contractsFromBuyingPower(bp * 0.7, est.premium, { dualLeg: dualLeg });
        if (spyC < 1) spyC = 1;
        if (iwmC < 1) {
          return {
            ok: false,
            error: "buying power too low for whole IWM contracts with cross-entry reserved",
            premium: est.premium,
            buyingPower: bp,
            crossEntry: true
          };
        }
        return packResult(t, iwmC, est, bp, dualLeg, {
          crossEntry: true,
          companion: { SPY: spyC },
          note: "Max whole IWM contracts with BP reserved for SPY cross-entry (" + spyC + "c)"
        });
      }
    }
  }

  var contracts = contractsFromBuyingPower(bp, est.premium, { dualLeg: dualLeg });
  if (contracts < 1) {
    return {
      ok: false,
      error: "buying power too low for 1 whole contract @ ~$" + est.premium.toFixed(2),
      premium: est.premium,
      buyingPower: bp
    };
  }

  return packResult(t, contracts, est, bp, dualLeg, {
    crossEntry: crossEntry,
    mirrorSpx: t === "SPY" ? (opts.mirrorSpx !== false) : false
  });
}

module.exports = {
  MAX_CONTRACTS: MAX_CONTRACTS,
  BP_UTILIZATION: BP_UTILIZATION,
  PREMIUM_PAD: PREMIUM_PAD,
  wholeContracts: wholeContracts,
  preferEvenContracts: preferEvenContracts,
  contractsFromBuyingPower: contractsFromBuyingPower,
  estimateAtmPremium: estimateAtmPremium,
  computeFullPort: computeFullPort
};
