// Reconcile in-memory state with open Robinhood option positions.

var rh = require("./robinhood");
var stateModule = require("./state");

var RH_FLAT_GRACE_MS = 10 * 60 * 1000;
var FLAT_CONFIRM_NEEDED = 2;
var _flatStreak = {};

function normalizeSide(rhPos) {
  var side = ((rhPos.option_type || "") + "").toLowerCase();
  return side === "call" || side === "put" ? side : null;
}

function findRhPosition(rhPositions, ticker, pos) {
  var open = (rhPositions || []).filter(function(p) {
    return p.chain_symbol === ticker && rh.optionPositionQty(p) > 0;
  });
  if (!open.length) return null;

  if (pos && pos.instrumentUrl) {
    var byUrl = open.find(function(p) { return rh.sameOptionUrl(p.option, pos.instrumentUrl); });
    if (byUrl) return byUrl;
  }
  if (pos && pos.side) {
    var bySide = open.find(function(p) { return normalizeSide(p) === pos.side; });
    if (bySide) return bySide;
    if (pos.strike) {
      var byStrike = open.find(function(p) {
        return normalizeSide(p) === pos.side &&
          Math.round(parseFloat(p.strike_price)) === Math.round(parseFloat(pos.strike));
      });
      if (byStrike) return byStrike;
    }
  }
  return open.length === 1 ? open[0] : null;
}

function entryPriceFromRh(rhPos, markFallback) {
  return rh.perShareFromRhPosition(rhPos, markFallback);
}

function entryLooksInflated(stored, corrected, mark) {
  if (!stored || stored <= 0 || !corrected || corrected <= 0) return false;
  if (stored <= corrected * 5) return false;
  if (mark && mark > 0 && stored > mark * 20) return true;
  return stored >= corrected * 20;
}

function fillFromRhPosition(rhPos, markFallback) {
  return {
    entryPrice: entryPriceFromRh(rhPos, markFallback),
    instrumentUrl: rhPos.option,
    strike: rhPos.strike_price ? Math.round(parseFloat(rhPos.strike_price)) : null,
    expiry: rhPos.expiration_date || null
  };
}

async function backfillEntryFromRh(ticker, pos, rhPositions) {
  if (!pos) return pos;
  var rhPos = findRhPosition(rhPositions, ticker, pos);
  if (!rhPos) return pos;

  var mark = await rh.getOptionMarkByUrl(rhPos.option);
  var fill = fillFromRhPosition(rhPos, mark);
  if (fill.entryPrice > 0) {
    var missing = !(pos.entryPrice > 0);
    var inflated = entryLooksInflated(pos.entryPrice, fill.entryPrice, mark);
    if (missing || inflated) {
      if (inflated) {
        stateModule.logEvent("RECONCILE", ticker + " corrected entry $" + pos.entryPrice.toFixed(2)
          + " → $" + fill.entryPrice.toFixed(2));
      }
      stateModule.applyOrderFill(ticker, fill);
      return stateModule.getPosition(ticker);
    }
  }
  return pos;
}

function clearFlatStreak(ticker) {
  delete _flatStreak[ticker];
}

async function reconcileRhPositions() {
  if (!rh.getToken()) return { ok: false, reason: "no_token" };
  var auth = await rh.checkAuthStatus();
  if (!auth.ok) return { ok: false, reason: "auth_failed" };

  var fetched = await rh.fetchOpenOptionPositions();
  if (!fetched.ok) {
    stateModule.logEvent("RECONCILE_WARN", "RH positions fetch failed (" + (fetched.error || "unknown")
      + ") — not marking flat");
    return { ok: false, reason: "positions_fetch_failed", error: fetched.error };
  }

  var rhPositions = fetched.positions || [];
  stateModule.logEvent("RECONCILE", "RH open option positions: " + rhPositions.length);
  var tickers = require("./liveTickers").liveTickers();
  var synced = [];

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var statePos = stateModule.getPosition(ticker);
    var rhPos = findRhPosition(rhPositions, ticker, statePos);

    if (!rhPos) {
      if (statePos && !statePos.stopped) {
        var ageMs = statePos.openedAtMs ? (Date.now() - statePos.openedAtMs) : null;
        if (ageMs != null && ageMs < RH_FLAT_GRACE_MS) {
          stateModule.logEvent("RECONCILE", ticker + " RH flat but opened " + Math.round(ageMs / 1000)
            + "s ago — keeping state (grace " + Math.round(RH_FLAT_GRACE_MS / 1000) + "s)");
          continue;
        }
        // If we still have an instrument URL, verify the option mark is reachable —
        // a temporary empty positions list should not kill live TP/SL tracking.
        if (statePos.instrumentUrl) {
          try {
            var stillQuoted = await rh.getOptionMarkByUrl(statePos.instrumentUrl);
            if (stillQuoted && stillQuoted > 0) {
              _flatStreak[ticker] = (_flatStreak[ticker] || 0) + 1;
              if (_flatStreak[ticker] < FLAT_CONFIRM_NEEDED) {
                stateModule.logEvent("RECONCILE", ticker + " RH list miss but mark still quotes $"
                  + stillQuoted.toFixed(2) + " — keeping state (confirm "
                  + _flatStreak[ticker] + "/" + FLAT_CONFIRM_NEEDED + ")");
                continue;
              }
            }
          } catch (e) {}
        }
        _flatStreak[ticker] = (_flatStreak[ticker] || 0) + 1;
        if (_flatStreak[ticker] < FLAT_CONFIRM_NEEDED) {
          stateModule.logEvent("RECONCILE", ticker + " RH flat — waiting confirm "
            + _flatStreak[ticker] + "/" + FLAT_CONFIRM_NEEDED);
          continue;
        }
        stateModule.logEvent("RECONCILE", ticker + " state open but RH flat — marking closed");
        clearFlatStreak(ticker);
        stateModule.closePosition(ticker, "reconcile: RH flat");
      }
      continue;
    }

    clearFlatStreak(ticker);
    var side = normalizeSide(rhPos) || (statePos && statePos.side) || null;
    if (!side) continue;

    // Dual-leg live positions: sync each leg to its RH option independently.
    if (statePos && statePos.legs && statePos.legs.length && !statePos.stopped) {
      var legSynced = false;
      for (var li = 0; li < statePos.legs.length; li++) {
        var leg = statePos.legs[li];
        if (!leg || leg.contracts < 1) continue;
        var legMatch = {
          side: leg.side || statePos.side,
          strike: leg.strike,
          expiry: leg.expiry,
          instrumentUrl: leg.instrumentUrl
        };
        var rhLeg = findRhPosition(rhPositions, ticker, legMatch);
        if (!rhLeg) {
          if (leg.contracts > 0) {
            stateModule.logEvent("RECONCILE", ticker + " DTE" + leg.dteTag + " RH flat — zeroing leg in state");
            leg.contracts = 0;
            legSynced = true;
          }
          continue;
        }
        var legQty = Math.max(0, Math.floor(rh.optionPositionQty(rhLeg)));
        var legMark = await rh.getOptionMarkByUrl(rhLeg.option);
        var legFill = fillFromRhPosition(rhLeg, legMark);
        leg.contracts = legQty;
        if (rhLeg.option) leg.instrumentUrl = rhLeg.option;
        if (legFill.strike) leg.strike = legFill.strike;
        if (legFill.expiry) leg.expiry = legFill.expiry;
        if (legFill.entryPrice > 0) {
          if (!(leg.entryPrice > 0) || entryLooksInflated(leg.entryPrice, legFill.entryPrice, legMark)) {
            leg.entryPrice = legFill.entryPrice;
          }
        }
        legSynced = true;
      }
      if (legSynced) {
        stateModule.setPositionLegs(ticker, statePos.legs);
        var refreshed = stateModule.getPosition(ticker);
        if (refreshed && refreshed.contracts <= 0 && !refreshed.stopped) {
          stateModule.closePosition(ticker, "reconcile: all legs flat");
        }
        synced.push(ticker);
      }
      continue;
    }

    var qty = Math.max(1, Math.floor(rh.optionPositionQty(rhPos)));
    var mark = await rh.getOptionMarkByUrl(rhPos.option);
    var fill = fillFromRhPosition(rhPos, mark);

    if (!statePos || statePos.stopped) {
      var meta = {
        instrumentUrl: fill.instrumentUrl,
        strike: fill.strike,
        expiry: fill.expiry
      };
      if (statePos) {
        meta.crossEntry = !!statePos.crossEntry;
        meta.stopMode = statePos.stopMode || "mid";
      }
      if (!meta.crossEntry && ticker === "SPY") {
        var iwm = stateModule.getPosition("IWM");
        if (iwm && !iwm.stopped && iwm.side === side) {
          meta.crossEntry = true;
          meta.stopMode = side === "call" ? "orb_low" : "orb_high";
        }
      }
      stateModule.importRhPosition(ticker, side, qty, fill.entryPrice, meta);
      stateModule.logEvent("RECONCILE", ticker + " imported RH " + side + " " + qty + "c" +
        (fill.entryPrice ? " @ $" + fill.entryPrice.toFixed(2) : "") +
        (meta.crossEntry ? " (cross-entry stop=" + meta.stopMode + ")" : ""));
      synced.push(ticker);
      continue;
    }

    if (statePos.side !== side) {
      stateModule.logEvent("RECONCILE_WARN", ticker + " state=" + statePos.side + " RH=" + side + " — syncing to RH");
      var sideMeta = {
        instrumentUrl: fill.instrumentUrl,
        strike: fill.strike,
        expiry: fill.expiry,
        crossEntry: !!statePos.crossEntry,
        stopMode: statePos.stopMode || "mid"
      };
      stateModule.importRhPosition(ticker, side, qty, fill.entryPrice || statePos.entryPrice, sideMeta);
      synced.push(ticker);
      continue;
    }

    stateModule.syncPositionQty(ticker, qty);
    var fillMeta = { instrumentUrl: fill.instrumentUrl, strike: fill.strike, expiry: fill.expiry };
    if (!(statePos.entryPrice > 0) || entryLooksInflated(statePos.entryPrice, fill.entryPrice, mark)) {
      fillMeta.entryPrice = fill.entryPrice;
      if (statePos.entryPrice > 0 && fill.entryPrice > 0) {
        stateModule.logEvent("RECONCILE", ticker + " corrected entry $" + statePos.entryPrice.toFixed(2)
          + " → $" + fill.entryPrice.toFixed(2));
      }
    }
    stateModule.applyOrderFill(ticker, fillMeta);
    synced.push(ticker);
  }

  return { ok: true, synced: synced };
}

module.exports = {
  findRhPosition: findRhPosition,
  entryPriceFromRh: entryPriceFromRh,
  entryLooksInflated: entryLooksInflated,
  backfillEntryFromRh: backfillEntryFromRh,
  reconcileRhPositions: reconcileRhPositions,
  RH_FLAT_GRACE_MS: RH_FLAT_GRACE_MS,
  FLAT_CONFIRM_NEEDED: FLAT_CONFIRM_NEEDED
};
