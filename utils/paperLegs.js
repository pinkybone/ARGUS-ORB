// utils/paperLegs.js — dual-leg paper sizing, strikes, expected-move touch detection.

var expectedMoveUtil = require("./expectedMove");

var MOVE_HOT_ZONE_PCT = 0.0025;
var MONITOR_INTERVAL_MS = 15000;
var MARK_INTERVAL_MS = 10000;
var ONE_DTE_EXIT_FRAC = 0.75;
var ZERO_DTE_EXIT_FRAC = 1.0;

function legKey(tradeTicker, dteTag) {
  return tradeTicker + ":" + dteTag;
}

function parseLegKey(key) {
  var parts = (key || "").split(":");
  return { tradeTicker: parts[0], dteTag: parseInt(parts[1], 10) || 0 };
}

function listLegsForTrade(positions, tradeTicker) {
  return Object.keys(positions || {}).filter(function(k) {
    var parsed = parseLegKey(k);
    return parsed.tradeTicker === tradeTicker && positions[k] && positions[k].contracts > 0;
  });
}

function sizeContracts(balance, riskPct, legFraction, premium) {
  if (!premium || premium <= 0 || !balance || balance <= 0) return 0;
  var legRisk = balance * (riskPct / 100) * legFraction;
  return Math.floor(legRisk / (premium * 100));
}

function roundStrike(ticker, price) {
  if (!price || price <= 0) return null;
  if (ticker === "SPXW" || ticker === "SPX") return Math.round(price / 5) * 5;
  return Math.round(price);
}

function strikeForLegTicker(ticker, side, dteTag, atmPrice, moveTargets) {
  if (dteTag === 0) return roundStrike(ticker, atmPrice);
  if (!moveTargets) return roundStrike(ticker, atmPrice);
  if (side === "call") return roundStrike(ticker, moveTargets.upper);
  return roundStrike(ticker, moveTargets.lower);
}

function getEntryMoveTargets(tradeTicker) {
  return expectedMoveUtil.computeTickerMoves(tradeTicker).then(function(moves) {
    if (!moves) return null;
    var session = moves.sessions && moves.sessions[0];
    if (!session) return null;
    return {
      upper: session.upper,
      lower: session.lower,
      moveDollars: session.moveDollars,
      movePct: session.movePct
    };
  });
}

function distToTargetPct(price, target, side) {
  if (!price || !target) return 1;
  if (side === "call") return Math.abs(price - target) / target;
  return Math.abs(price - target) / target;
}

function isNearMoveTarget(pos, livePrice) {
  if (!pos || pos.moveExitDone) return false;
  if (pos.side === "call" && pos.targetUpper) {
    return distToTargetPct(livePrice, pos.targetUpper, "call") <= MOVE_HOT_ZONE_PCT;
  }
  if (pos.side === "put" && pos.targetLower) {
    return distToTargetPct(livePrice, pos.targetLower, "put") <= MOVE_HOT_ZONE_PCT;
  }
  return false;
}

function checkMoveTouch(pos, snap) {
  if (!pos || pos.moveExitDone || !snap) return null;
  var price = snap.price;
  var high = snap.high != null ? snap.high : price;
  var low = snap.low != null ? snap.low : price;
  if (pos.side === "call" && pos.targetUpper) {
    if (price >= pos.targetUpper || high >= pos.targetUpper) return "upper";
  }
  if (pos.side === "put" && pos.targetLower) {
    if (price <= pos.targetLower || low <= pos.targetLower) return "lower";
  }
  return null;
}

function exitFractionForLeg(dteTag) {
  return dteTag === 0 ? ZERO_DTE_EXIT_FRAC : ONE_DTE_EXIT_FRAC;
}

function sellQtyForLeg(pos, fraction) {
  if (!pos || pos.contracts <= 0) return 0;
  if (fraction >= 1) return pos.contracts;
  return Math.max(1, Math.floor(pos.contracts * fraction));
}

module.exports = {
  legKey: legKey,
  parseLegKey: parseLegKey,
  listLegsForTrade: listLegsForTrade,
  sizeContracts: sizeContracts,
  roundStrike: roundStrike,
  strikeForLegTicker: strikeForLegTicker,
  getEntryMoveTargets: getEntryMoveTargets,
  isNearMoveTarget: isNearMoveTarget,
  checkMoveTouch: checkMoveTouch,
  exitFractionForLeg: exitFractionForLeg,
  sellQtyForLeg: sellQtyForLeg,
  MOVE_HOT_ZONE_PCT: MOVE_HOT_ZONE_PCT,
  MONITOR_INTERVAL_MS: MONITOR_INTERVAL_MS,
  MARK_INTERVAL_MS: MARK_INTERVAL_MS,
  ONE_DTE_EXIT_FRAC: ONE_DTE_EXIT_FRAC
};
