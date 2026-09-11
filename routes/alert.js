var stateModule = require("../utils/state");
var trayd = require("../utils/trayd");
var orbUtil = require("../utils/orb");
var yahoo = require("../utils/yahoo");
var pnlUtil = require("../utils/pnl");
var settings = require("../utils/settings");

var discord = null;
try { discord = require("../utils/discord"); } catch (e) { discord = null; }

async function notify(fn, args) {
  try {
    if (discord && typeof discord[fn] === "function") return await discord[fn].apply(null, args);
  } catch (e) { console.log("[DISCORD_NOTIFY_ERROR] " + fn + ": " + e.message); }
}

async function underlyingForNotify(ticker, close) {
  if (close && parseFloat(close) > 0) return parseFloat(close);
  return await yahoo.getUnderlyingPrice(ticker);
}

async function orbLevelsFor(ticker, payloadHigh, payloadLow) {
  if (payloadHigh && payloadLow) return { high: payloadHigh, low: payloadLow };
  var ensured = await orbUtil.ensureOrbForTicker(ticker);
  if (ensured) return ensured;
  var s = stateModule.getState();
  var orb = s.orb[ticker];
  if (orb && orb.set) return { high: orb.high, low: orb.low };
  return { high: payloadHigh || 0, low: payloadLow || 0 };
}

async function placeAndFill(ticker, side, contracts) {
  var order = await trayd.placeOrder({ ticker: ticker, side: side, contracts: contracts });
  stateModule.applyOrderFill(ticker, order);
  return order;
}

async function notifyPaperEntry(ticker, side, optPrice, orbHigh, orbLow, close, opts) {
  var und = await underlyingForNotify(ticker, close);
  var useWebhookPrice = !(opts && opts.ignoreWebhookPrice);
  var paperPrice = useWebhookPrice ? (optPrice || 0) : 0;
  var args = [ticker, side, paperPrice, orbHigh, orbLow, und];
  if (opts) args.push(opts);
  var opened = await notify("onEntry", args);
  if (!opened) await notify("onAdd", [ticker, paperPrice]);
  return opened;
}

async function closeLiveOrLog(ticker, contracts, reason) {
  var pos = stateModule.getPosition(ticker);
  if (pos && pos.legs && pos.legs.length) {
    var openLegs = pos.legs.filter(function(l) { return l && l.contracts > 0; });
    if (openLegs.length > 1 || (pos.dualLeg && openLegs.length >= 1 && contracts >= pos.contracts)) {
      return trayd.closeAllLegs(ticker, reason);
    }
  }
  return trayd.closeLiveOrLog(ticker, contracts, reason);
}

function liveEntryBlocked(ticker, action) {
  if (!settings.isTradingEnabled()) {
    stateModule.logEvent("KILL_SWITCH", ticker + " live " + action + " blocked");
    return true;
  }
  if (!settings.isBuyEnabled(ticker)) {
    stateModule.logEvent("BUY_OFF", ticker + " live " + action + " blocked — buy toggle OFF");
    return true;
  }
  return false;
}

function isRetryableRhError(msg) {
  var m = (msg || "").toLowerCase();
  return m.indexOf("token") !== -1 || m.indexOf("auth") !== -1 || m.indexOf("timeout") !== -1
    || m.indexOf("econn") !== -1 || m.indexOf("network") !== -1 || m.indexOf("503") !== -1
    || m.indexOf("502") !== -1 || m.indexOf("429") !== -1;
}

var DEDUP_WINDOW_MS = parseInt(process.env.ORB_DEDUP_MS, 10) || 30000;
var lastSignal = {};
var processing = {};

function seenAgo(ticker, event) {
  var key = ticker + ":" + event;
  var now = Date.now();
  if (lastSignal[key] && (now - lastSignal[key]) < DEDUP_WINDOW_MS) {
    return (now - lastSignal[key]) || 1;
  }
  return 0;
}

function markSeen(ticker, event) {
  lastSignal[ticker + ":" + event] = Date.now();
}

function recentlySeen(ticker, event) {
  var ago = seenAgo(ticker, event);
  if (ago > 0) return ago;
  markSeen(ticker, event);
  return 0;
}

function isLiveTicker(ticker) {
  return require("../utils/liveTickers").isLiveTicker(ticker);
}


// SPX live mirrors SPY signals (same side/sizing params). No TradingView SPX webhook —
// SPY ORB breakouts/stops/retests drive SPX live entries using SPY contract size.
async function mirrorSpyLiveToSpx(kind, side, opts) {
  opts = opts || {};
  if (!isLiveTicker("SPX")) return null;
  var s = stateModule.getState();
  var total = s.contracts.SPX || s.contracts.SPY || 1;
  var half = Math.ceil(total / 2);
  var spxPos = stateModule.getPosition("SPX");

  try {
    if (kind === "entry") {
      if (spxPos && !spxPos.stopped) {
        stateModule.logEvent("SPX_MIRROR", "SPY " + side + " entry — SPX already open, skip");
        return null;
      }
      if (liveEntryBlocked("SPX", "spy-mirror entry")) return null;
      stateModule.logEvent("SPX_MIRROR", "SPY " + side + " → SPX live half=" + half + "/" + total + " (SPY ORB signal)");
      return await tryLiveHalfEntry("SPX", side, half, total, null);
    }

    if (kind === "retest") {
      if (!spxPos || spxPos.stopped || spxPos.side !== side || !spxPos.halfIn) return null;
      if (liveEntryBlocked("SPX", "spy-mirror retest")) return null;
      stateModule.logEvent("SPX_MIRROR", "SPY retest → SPX add " + spxPos.totalContracts + "c");
      return await tryLiveRetestAdd("SPX", side, spxPos.totalContracts, spxPos);
    }

    if (kind === "stop" || kind === "flip_close") {
      if (!spxPos || spxPos.stopped) return null;
      var reason = opts.reason || ("SPY " + kind + " → SPX close");
      stateModule.logEvent("SPX_MIRROR", reason);
      var closed = await closeLiveOrLog("SPX", spxPos.contracts, reason);
      if (closed) stateModule.closePosition("SPX", reason);
      return { closed: closed };
    }

    if (kind === "expected_move") {
      if (!spxPos || spxPos.stopped) return null;
      if ((spxPos.lastProfitTier || 0) >= 300) return null;
      var qty90 = Math.floor(spxPos.contracts * 0.9);
      if (qty90 < 1) return null;
      var emReason = (opts.timeframe || "daily") + " expected move 90% exit (SPY mirror)";
      var ok = await trayd.closeLiveOrLog("SPX", qty90, emReason);
      if (ok) {
        stateModule.reduceContracts("SPX", qty90);
        stateModule.markProfitTier("SPX", 300);
        spxPos = stateModule.getPosition("SPX");
        if (!spxPos || spxPos.contracts <= 0) stateModule.closePosition("SPX", emReason);
      }
      return { closed: ok };
    }
  } catch (e) {
    stateModule.logEvent("SPX_MIRROR_ERROR", "SPY→SPX " + kind + " failed: " + e.message);
    return { error: e.message, retryable: isRetryableRhError(e.message) };
  }
  return null;
}

async function handleAlert(payload) {
  stateModule.resetDay();
  var ticker = ((payload.ticker) || "").toUpperCase();
  var event  = (payload.event || "").toLowerCase();

  if (!ticker || !event) throw new Error("Missing ticker or event");
  if (ticker !== "SPY" && ticker !== "IWM" && ticker !== "QQQ") throw new Error("Unknown ticker: " + ticker);

  var TRADE_EVENTS = ["breakout_long", "breakout_short", "stop_long", "stop_short", "expected_move_hit"];
  var guarded = TRADE_EVENTS.indexOf(event) !== -1;
  var lockedTickers = [];

  if (guarded) {
    if (processing[ticker]) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — order in progress");
      return { ok: true, deduped: true, message: ticker + " " + event + " ignored (in progress)" };
    }
    var ago = seenAgo(ticker, event);
    if (ago > 0) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — duplicate " + Math.round(ago / 1000) + "s ago");
      return { ok: true, deduped: true, message: ticker + " " + event + " duplicate ignored (" + Math.round(ago / 1000) + "s)" };
    }
    processing[ticker] = true;
    lockedTickers.push(ticker);
  }

  try {
    var result = await processEvent(payload, ticker, event, lockedTickers);
    if (guarded && result && result.ok) markSeen(ticker, event);
    return result;
  } finally {
    lockedTickers.forEach(function(t) { processing[t] = false; });
  }
}

async function tryLiveRetestAdd(ticker, side, qty, pos) {
  if (pos && pos.dualLeg && pos.legs && pos.legs.length) {
    var perLeg = Math.max(1, qty);
    stateModule.logEvent("RETEST", ticker + " dual-leg retest add " + perLeg + "c per leg");
    var dualAdd = await trayd.placeDualLegAdd(ticker, side, perLeg, pos.legs);
    stateModule.addToLegs(ticker, dualAdd.legs || []);
    if (dualAdd.partial) {
      stateModule.logEvent("ORDER_WARN", ticker + " dual-leg retest partial");
    }
    return dualAdd.order;
  }
  var addOrder = await placeAndFill(ticker, side, qty);
  stateModule.addSecondHalf(ticker, qty, (addOrder && addOrder.entryPrice) || pos.entryPrice);
  return addOrder;
}

async function tryLiveHalfEntry(ticker, side, half, total, optPrice) {
  if (liveEntryBlocked(ticker, "entry")) return { order: null, retryable: false, blocked: true };
  var dual = settings.isDualLegLive();
  stateModule.logEvent("ENTRY", ticker + " " + side + " @ half=" + half + "/" + total +
    (dual ? " (0DTE+1DTE dual-leg)" : ""));

  if (dual) {
    var perLeg = Math.max(1, half);
    stateModule.openHalfPosition(ticker, side, perLeg * 2, optPrice || 0, {
      dualLeg: true,
      totalContracts: perLeg
    });
    try {
      var dualRes = await trayd.placeDualLegEntry(ticker, side, perLeg);
      var legStates = (dualRes.legs || []).map(function(o) {
        return {
          dteTag: o.dteTag,
          side: side,
          contracts: o.contracts,
          entryPrice: o.entryPrice,
          strike: o.strike,
          expiry: o.expiry,
          instrumentUrl: o.instrumentUrl,
          breakEvenActivated: false,
          lastProfitTier: 0,
          stopPct: null
        };
      });
      stateModule.setPositionLegs(ticker, legStates);
      if (dualRes.partial) {
        stateModule.logEvent("ORDER_WARN", ticker + " dual-leg partial — 0DTE live, 1DTE failed: " +
          (dualRes.error || "unknown"));
      } else {
        stateModule.logEvent("ENTRY_FILL", ticker + " dual-leg 0DTE+1DTE filled");
      }
      return { order: dualRes.order, retryable: false, dual: true, partial: !!dualRes.partial };
    } catch (e) {
      stateModule.closePosition(ticker, "dual-leg entry order failed");
      stateModule.logEvent("ORDER_ERROR", ticker + " " + side + " dual-leg entry failed: " + e.message);
      return { order: null, retryable: isRetryableRhError(e.message), error: e.message };
    }
  }

  stateModule.openHalfPosition(ticker, side, half, optPrice || 0);
  try {
    var order = await placeAndFill(ticker, side, half);
    return { order: order, retryable: false };
  } catch (e) {
    stateModule.closePosition(ticker, "entry order failed");
    stateModule.logEvent("ORDER_ERROR", ticker + " " + side + " entry failed: " + e.message);
    return { order: null, retryable: isRetryableRhError(e.message), error: e.message };
  }
}

async function tryIwmCrossEntry(side, spyOrbHigh, spyOrbLow, s, lockedTickers) {
  if (!settings.isCrossEntryEnabled()) {
    stateModule.logEvent("CROSS_SKIP", "IWM → SPY cross-entry disabled in settings");
    return null;
  }
  var spyPos = stateModule.getPosition("SPY");
  var stopMode = side === "call" ? "orb_low" : "orb_high";
  var spyHalf = Math.ceil(s.contracts.SPY / 2);
  if (liveEntryBlocked("SPY", "cross-entry")) return { order: null, retryable: false, blocked: true };
  if (!processing["SPY"] && (!spyPos || spyPos.stopped) && s.orb.SPY.set) {
    processing["SPY"] = true;
    lockedTickers.push("SPY");
    stateModule.logEvent("CROSS_ENTRY", "IWM " + side + " → SPY " + side + " half=" + spyHalf + " stop=" + stopMode);
    stateModule.openHalfPosition("SPY", side, spyHalf, 0, { crossEntry: true, stopMode: stopMode });
    try {
      var cross = await placeAndFill("SPY", side, spyHalf);
      recentlySeen("SPY", side === "call" ? "cross_long" : "cross_short");
      return { order: cross, retryable: false };
    } catch (e) {
      stateModule.closePosition("SPY", "cross entry failed");
      stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
      return { order: null, retryable: isRetryableRhError(e.message), error: e.message };
    }
  }
  return null;
}

async function notifyPaperAndMaybeLiveEntry(ticker, side, half, total, optPrice, orbHigh, orbLow, close, s, lockedTickers) {
  await notifyPaperEntry(ticker, side, optPrice, orbHigh, orbLow, close);
  if (!isLiveTicker(ticker)) {
    return { order: null, cross: null, paper: true, live: false, retryable: false };
  }
  var livePos = stateModule.getPosition(ticker);
  var liveFlat = !livePos || livePos.stopped;
  var entryResult = { order: null, retryable: false };
  if (liveFlat) entryResult = await tryLiveHalfEntry(ticker, side, half, total, optPrice);
  var cross = null;
  if (ticker === "IWM") {
    await notifyPaperEntry("SPY", side, null, s.orb.SPY.high || orbHigh || 0, s.orb.SPY.low || orbLow || 0, null,
      { channelIds: ["spy0dte"], ignoreWebhookPrice: true });
    cross = await tryIwmCrossEntry(side, s.orb.SPY.high || orbHigh || 0, s.orb.SPY.low || orbLow || 0, s, lockedTickers);
  }
  var spxMirror = null;
  if (ticker === "SPY" && entryResult.order) {
    spxMirror = await mirrorSpyLiveToSpx("entry", side);
  }
  var retryable = !!(entryResult.retryable || (cross && cross.retryable) || (spxMirror && spxMirror.retryable));
  return {
    order: entryResult.order,
    cross: cross && cross.order,
    spx: spxMirror && (spxMirror.order || spxMirror),
    paper: true,
    live: !!entryResult.order,
    retryable: retryable,
    error: entryResult.error || (cross && cross.error) || (spxMirror && spxMirror.error)
  };
}

function stopLabel(pos) {
  if (pos.crossEntry && pos.stopMode === "orb_low") return "ORB Low (cross-entry)";
  if (pos.crossEntry && pos.stopMode === "orb_high") return "ORB High (cross-entry)";
  return "ORB Midpoint";
}

async function processEvent(payload, ticker, event, lockedTickers) {
  var s        = stateModule.getState();
  var pos      = stateModule.getPosition(ticker);
  var optPrice = payload.option_price ? parseFloat(payload.option_price) : null;
  var close    = payload.close ? parseFloat(payload.close) : null;
  var orbHigh  = payload.orb_high ? parseFloat(payload.orb_high) : null;
  var orbLow   = payload.orb_low  ? parseFloat(payload.orb_low)  : null;

  var TRADE_EVENTS = ["breakout_long", "breakout_short", "stop_long", "stop_short", "expected_move_hit"];
  if (TRADE_EVENTS.indexOf(event) !== -1) {
    await orbUtil.ensureOrbForTicker(ticker);
    if (ticker === "IWM") await orbUtil.ensureOrbForTicker("SPY");
    var levels = await orbLevelsFor(ticker, orbHigh, orbLow);
    orbHigh = levels.high;
    orbLow = levels.low;
  }

  if (event === "orb_set") {
    if (orbHigh && orbLow) {
      if (parseFloat(orbHigh) <= parseFloat(orbLow)) {
        stateModule.logEvent("ORB_REJECT", ticker + " webhook flat range High=" + orbHigh + " Low=" + orbLow);
        return { ok: false, error: ticker + " ORB rejected — high must be above low" };
      }
      stateModule.setORB(ticker, orbHigh, orbLow, "webhook");
      var midWh = (parseFloat(orbHigh) + parseFloat(orbLow)) / 2;
      await notify("onOrbSet", [ticker, orbHigh, orbLow, midWh, "webhook"]);
      return { ok: true, message: ticker + " ORB set (from TradingView)" };
    }

    // Bare orb_set (no high/low): keep an existing same-day ORB — do not overwrite
    // TradingView levels with Yahoo. Only Yahoo-fill when nothing is set yet.
    s = stateModule.getState();
    var existing = s.orb && s.orb[ticker];
    var today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
    if (existing && existing.set && existing.date === today && existing.high > 0 && existing.low > 0) {
      await notify("onOrbSet", [ticker, existing.high, existing.low, existing.mid, existing.source || "webhook"]);
      return { ok: true, message: ticker + " ORB already set (" + (existing.source || "cached") + ") — preserved" };
    }

    stateModule.logEvent("ORB_WARN", ticker + " orb_set without levels — auto-fetching from Yahoo");
    var range = await orbUtil.fetchOpeningRange(ticker);
    if (range && range.high > range.low) {
      stateModule.setORB(ticker, range.high, range.low, "yahoo");
      var midY = (range.high + range.low) / 2;
      await notify("onOrbSet", [ticker, range.high, range.low, midY, "yahoo"]);
      return { ok: true, message: ticker + " ORB set (Yahoo fallback)" };
    }
    stateModule.logEvent("ORB_SET", ticker + " ORB levels unavailable yet");
    return { ok: true, message: ticker + " ORB set (no levels)" };
  }

  if (event === "stop_long" || event === "stop_short") {
    var wantSide = event === "stop_long" ? "call" : "put";
    var slPaper = "ORB Midpoint";
    var slLive = pos ? stopLabel(pos) : slPaper;
    stateModule.logEvent("STOP_LOSS", ticker + " " + slLive + " stop hit");
    await notify("onStop", [ticker, optPrice || 0, slPaper]);
    if (!pos || pos.stopped || pos.side !== wantSide) {
      return { ok: true, message: ticker + " paper stop sent (no matching live position)" };
    }
    var stopQty = pos.contracts;
    var stopEntry = pos.entryPrice;
    var stopSide = pos.side;
    var liveClosed = await closeLiveOrLog(ticker, stopQty, slLive);
    if (liveClosed) {
      if (optPrice) pnlUtil.logTradePnL(ticker, stopSide, stopEntry, optPrice, stopQty);
      stateModule.closePosition(ticker, slLive);
    }
    if (ticker === "SPY") {
      await mirrorSpyLiveToSpx("stop", wantSide, { reason: "SPY stop → SPX close (" + slLive + ")" });
    }
    return {
      ok: true,
      message: ticker + (wantSide === "call" ? " long" : " short") + " paper stopped" +
        (liveClosed ? " · live closed" : " · live RH close failed (paper unaffected)")
    };
  }

  if (event === "breakout_long") {
    var total = isLiveTicker(ticker) ? (s.contracts[ticker] || 1) : 0;
    var half  = isLiveTicker(ticker) ? Math.ceil(total / 2) : 0;

    if (pos && !pos.stopped && pos.side === "put") {
      stateModule.logEvent("FLIP", ticker + " breakout long — paper close + live close if possible");
      await notify("onFullClose", [ticker, optPrice || 0]);
      if (await closeLiveOrLog(ticker, pos.contracts, "ORB breakout flip to long")) {
        if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
        stateModule.closePosition(ticker, "flip to long");
        pos = null;
        if (ticker === "SPY") {
          await mirrorSpyLiveToSpx("flip_close", "put", { reason: "SPY flip to long → SPX close" });
        }
      }
    }

    pos = stateModule.getPosition(ticker);
    if (pos && !pos.stopped && pos.side === "call") {
      await notify("onAdd", [ticker, optPrice || 0]);
      if (pos.halfIn) {
        stateModule.logEvent("RETEST", ticker + " retest add " + pos.totalContracts + "c");
        if (!liveEntryBlocked(ticker, "retest")) {
          try {
            await tryLiveRetestAdd(ticker, "call", pos.totalContracts, pos);
            if (ticker === "SPY") await mirrorSpyLiveToSpx("retest", "call");
          } catch (e) {
            stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
            if (isRetryableRhError(e.message)) {
              return { ok: false, retryable: true, message: ticker + " retest RH failed: " + e.message };
            }
          }
        }
        return { ok: true, message: ticker + " paper retest sent" + (pos.halfIn ? " · live add attempted" : "") };
      }
      return { ok: true, message: ticker + " paper signal sent · live already in long" };
    }

    var opened = await notifyPaperAndMaybeLiveEntry(ticker, "call", half, total, optPrice, orbHigh, orbLow, close, s, lockedTickers);
    if (opened.retryable) {
      return { ok: false, retryable: true, message: ticker + " live entry failed: " + (opened.error || "RH error") };
    }
    return { ok: true, entry: opened.order, cross: opened.cross, paper: true, live: opened.live };
  }

  if (event === "breakout_short") {
    var total2 = isLiveTicker(ticker) ? (s.contracts[ticker] || 1) : 0;
    var half2  = isLiveTicker(ticker) ? Math.ceil(total2 / 2) : 0;

    if (pos && !pos.stopped && pos.side === "call") {
      stateModule.logEvent("FLIP", ticker + " breakout short — paper close + live close if possible");
      await notify("onFullClose", [ticker, optPrice || 0]);
      if (await closeLiveOrLog(ticker, pos.contracts, "ORB breakout flip to short")) {
        if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
        stateModule.closePosition(ticker, "flip to short");
        pos = null;
        if (ticker === "SPY") {
          await mirrorSpyLiveToSpx("flip_close", "call", { reason: "SPY flip to short → SPX close" });
        }
      }
    }

    pos = stateModule.getPosition(ticker);
    if (pos && !pos.stopped && pos.side === "put") {
      await notify("onAdd", [ticker, optPrice || 0]);
      if (pos.halfIn) {
        stateModule.logEvent("RETEST", ticker + " retest add " + pos.totalContracts + "c");
        if (!liveEntryBlocked(ticker, "retest")) {
          try {
            await tryLiveRetestAdd(ticker, "put", pos.totalContracts, pos);
            if (ticker === "SPY") await mirrorSpyLiveToSpx("retest", "put");
          } catch (e) {
            stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
            if (isRetryableRhError(e.message)) {
              return { ok: false, retryable: true, message: ticker + " retest RH failed: " + e.message };
            }
          }
        }
        return { ok: true, message: ticker + " paper retest sent" };
      }
      return { ok: true, message: ticker + " paper signal sent · live already in short" };
    }

    var opened2 = await notifyPaperAndMaybeLiveEntry(ticker, "put", half2, total2, optPrice, orbHigh, orbLow, close, s, lockedTickers);
    if (opened2.retryable) {
      return { ok: false, retryable: true, message: ticker + " live entry failed: " + (opened2.error || "RH error") };
    }
    return { ok: true, entry: opened2.order, cross: opened2.cross, paper: true, live: opened2.live };
  }

  if (event === "bar_close") {
    return { ok: true, message: ticker + " bar_close ignored — profit manager handles tiers" };
  }

  if (event === "expected_move_hit") {
    var timeframe = payload.timeframe || "daily";
    await notify("onExpectedMoveExit", [ticker, optPrice || 0, timeframe]);
    if (!pos || pos.stopped) {
      return { ok: true, message: ticker + " paper expected-move sent (no live position)" };
    }
    if ((pos.lastProfitTier || 0) >= 300) {
      return { ok: true, message: ticker + " paper expected-move sent · live already processed" };
    }
    var qty90 = Math.floor(pos.contracts * 0.9);
    if (qty90 < 1) return { ok: true, message: ticker + " paper expected-move sent · live not enough contracts" };
    stateModule.logEvent("PROFIT_TIER_3", ticker + " " + timeframe + " expected move — selling 90% (" + qty90 + "c)");
    var closed = await trayd.closeLiveOrLog(ticker, qty90, timeframe + " expected move 90% exit");
    if (closed) {
      if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, qty90);
      stateModule.reduceContracts(ticker, qty90);
      stateModule.markProfitTier(ticker, 300);
      pos = stateModule.getPosition(ticker);
      if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, timeframe + " expected move 90% exit");
      if (ticker === "SPY") {
        await mirrorSpyLiveToSpx("expected_move", null, { timeframe: timeframe });
      }
    }
    return {
      ok: true,
      message: ticker + " paper expected-move sent" + (closed ? " · live 90% exit" : " · live RH close failed (paper unaffected)")
    };
  }

  throw new Error("Unknown event: " + event);
}

module.exports = { handleAlert: handleAlert };
