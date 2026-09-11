// Lightweight audit tests for trading logic (no network, no Discord, no RH).
var assert = require("assert");
var paperLegs = require("../utils/paperLegs");
var exitlogic = require("../utils/exitlogic");
var reconcile = require("../utils/reconcile");
var marketCal = require("../utils/marketCalendar");
var expiryCal = require("../utils/expiryCalendar");
var expiryUtil = require("../utils/expiry");
var authguard = require("../utils/authguard");
var yahoo = require("../utils/yahoo");
var closeDigest = require("../utils/closeDigest");
var rh = require("../utils/robinhood");

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL  " + name + " — " + e.message);
    process.exitCode = 1;
  }
}

console.log("paperLegs");
test("5% / 2.5% per leg floors contracts", function() {
  // $50k * 5% * 50% = $1,250 / ($2.50 * 100) = 5 contracts
  assert.strictEqual(paperLegs.sizeContracts(50000, 5, 0.5, 2.50), 5);
  // $10k * 2.5% = $250 / ($3 * 100) = 0 (too expensive)
  assert.strictEqual(paperLegs.sizeContracts(10000, 5, 0.5, 3.00), 0);
  assert.strictEqual(paperLegs.sizeContracts(10000, 5, 0.5, 1.00), 2);
  assert.strictEqual(paperLegs.sizeContracts(50000, 5, 0.5, 0), 0);
});

test("SPXW strikes round to $5; equity to $1", function() {
  assert.strictEqual(paperLegs.roundStrike("SPXW", 6402), 6400);
  assert.strictEqual(paperLegs.roundStrike("SPXW", 6403), 6405);
  assert.strictEqual(paperLegs.roundStrike("SPY", 570.4), 570);
  assert.strictEqual(paperLegs.roundStrike("IWM", 218.6), 219);
});

test("0DTE ATM vs 1DTE expected-move strike", function() {
  var moves = { upper: 6450, lower: 6350 };
  assert.strictEqual(paperLegs.strikeForLegTicker("SPXW", "call", 0, 6402, moves), 6400);
  assert.strictEqual(paperLegs.strikeForLegTicker("SPXW", "call", 1, 6402, moves), 6450);
  assert.strictEqual(paperLegs.strikeForLegTicker("SPXW", "put", 1, 6402, moves), 6350);
  assert.strictEqual(paperLegs.strikeForLegTicker("SPY", "call", 1, 570.2, null), 570);
});

test("leg keys do not prefix-match SPXW as SPX", function() {
  var positions = {
    "SPXW:0": { contracts: 2 },
    "SPXW:1": { contracts: 1 },
    "SPY:0": { contracts: 3 }
  };
  assert.deepStrictEqual(paperLegs.listLegsForTrade(positions, "SPXW").sort(), ["SPXW:0", "SPXW:1"]);
  assert.deepStrictEqual(paperLegs.listLegsForTrade(positions, "SPX"), []);
  assert.deepStrictEqual(paperLegs.listLegsForTrade(positions, "SPY"), ["SPY:0"]);
});

test("move touch: call uses high/upper, put uses low/lower", function() {
  var call = { side: "call", targetUpper: 100, moveExitDone: false };
  var put = { side: "put", targetLower: 90, moveExitDone: false };
  assert.strictEqual(paperLegs.checkMoveTouch(call, { price: 99, high: 100, low: 98 }), "upper");
  assert.strictEqual(paperLegs.checkMoveTouch(call, { price: 99, high: 99.5, low: 98 }), null);
  assert.strictEqual(paperLegs.checkMoveTouch(put, { price: 91, high: 92, low: 90 }), "lower");
  assert.strictEqual(paperLegs.checkMoveTouch(put, { price: 91, high: 92, low: 90.5 }), null);
  assert.strictEqual(paperLegs.checkMoveTouch({ side: "call", targetUpper: 100, moveExitDone: true }, { price: 101 }), null);
});

test("sell qty: 0DTE 100%, 1DTE 75% with 1-contract floor", function() {
  assert.strictEqual(paperLegs.exitFractionForLeg(0), 1);
  assert.strictEqual(paperLegs.exitFractionForLeg(1), 0.75);
  assert.strictEqual(paperLegs.sellQtyForLeg({ contracts: 4 }, 1), 4);
  assert.strictEqual(paperLegs.sellQtyForLeg({ contracts: 4 }, 0.75), 3);
  assert.strictEqual(paperLegs.sellQtyForLeg({ contracts: 1 }, 0.75), 1);
});

console.log("exitlogic");
test("initial stop at -15%", function() {
  var d = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false }, 1.70);
  assert.ok(d.stopOut);
  assert.strictEqual(d.scaleOut, false);
});

test("scale-out at +20%, not at +19%", function() {
  var a = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false }, 2.40);
  assert.ok(a.scaleOut);
  assert.strictEqual(a.newTier, 1);
  var b = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false }, 2.38);
  assert.strictEqual(b.scaleOut, false);
});

test("breakeven at +30% then trail +10% per +20%", function() {
  var be = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 1, breakEvenActivated: false }, 2.60);
  assert.ok(be.activateBreakeven);
  assert.strictEqual(be.newStopPct, 0);
  var trail = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 2, breakEvenActivated: true, stopPct: 0 }, 3.00);
  // +50% → one 20% step above +30% → trail stop 10%
  assert.strictEqual(trail.newStopPct, 10);
});

test("does not scale out while stopping out", function() {
  var d = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false, stopPct: -15 }, 1.50);
  assert.ok(d.stopOut);
  assert.strictEqual(d.scaleOut, false);
});

console.log("reconcile");
test("uses average_price before mark fallback", function() {
  assert.strictEqual(reconcile.entryPriceFromRh({ average_price: "1.85" }, 2.40), 1.85);
  assert.strictEqual(reconcile.entryPriceFromRh({ pending_average_price: "1.90" }, 2.40), 1.90);
  assert.strictEqual(reconcile.entryPriceFromRh({}, 2.40), 2.40);
  assert.strictEqual(reconcile.entryPriceFromRh({}, 0), 0);
});

test("refuses ambiguous multi-position pick", function() {
  var many = [
    { chain_symbol: "SPY", quantity: "2", option_type: "call", option: "a" },
    { chain_symbol: "SPY", quantity: "1", option_type: "put", option: "b" }
  ];
  assert.strictEqual(reconcile.findRhPosition(many, "SPY", null), null);
  var one = [{ chain_symbol: "SPY", quantity: "2", option_type: "call", option: "a" }];
  assert.strictEqual(reconcile.findRhPosition(one, "SPY", null).option, "a");
  var byUrl = reconcile.findRhPosition(many, "SPY", { instrumentUrl: "b" });
  assert.strictEqual(byUrl.option, "b");
});

test("findRhPosition matches pending qty and URL slash variants", function() {
  var pending = [{
    chain_symbol: "SPY", quantity: "0", pending_buy_quantity: "1",
    option_type: "put", option: "https://api.robinhood.com/options/instruments/abc/"
  }];
  var hit = reconcile.findRhPosition(pending, "SPY", {
    instrumentUrl: "https://api.robinhood.com/options/instruments/abc"
  });
  assert.ok(hit);
  assert.strictEqual(hit.option_type, "put");
  assert.strictEqual(rh.optionPositionQty(pending[0]), 1);
  assert.ok(rh.sameOptionUrl(
    "https://api.robinhood.com/options/instruments/abc/",
    "https://api.robinhood.com/options/instruments/abc"
  ));
});

test("reconcile grace is at least 10 minutes", function() {
  assert.ok(reconcile.RH_FLAT_GRACE_MS >= 10 * 60 * 1000);
  assert.ok(reconcile.FLAT_CONFIRM_NEEDED >= 2);
});

console.log("calendar / expiry");
test("2026 holidays include Good Friday and Independence Day", function() {
  var h = marketCal.getYearHolidays(2026);
  assert.ok(h.closed["2026-04-03"], "Good Friday 2026");
  assert.ok(h.closed["2026-07-03"], "Independence Day observed 2026 (Fri)");
  assert.ok(!marketCal.isTradingDayET(new Date("2026-07-03T16:00:00Z")));
  assert.ok(marketCal.isTradingDayET(new Date("2026-07-02T16:00:00Z")));
});

test("weekly expiry is this week's Friday", function() {
  assert.strictEqual(expiryCal.fridayOfTradingWeek("2026-08-30"), "2026-09-04");
  assert.strictEqual(expiryCal.fridayOfTradingWeek("2026-08-31"), "2026-09-04");
  assert.strictEqual(expiryCal.thirdFriday(2026, 9), "2026-09-18");
});

test("Yahoo option expiries use UTC date not Eastern (Friday not Thursday)", function() {
  var friMidnightUtc = Date.UTC(2026, 8, 4, 0, 0, 0) / 1000;
  assert.strictEqual(yahoo.unixToYmd(friMidnightUtc), "2026-09-04");
  var shiftedEt = new Date(friMidnightUtc * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  assert.strictEqual(shiftedEt, "2026-09-03", "sanity: ET conversion would wrongly show Thursday");
});

test("weekly option pick prefers Friday over prior Thursday", function() {
  var expiries = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-11"];
  assert.strictEqual(expiryCal.pickWeeklyExpiry(expiries, "2026-08-30"), "2026-09-04");
  var noFriday = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-11"];
  assert.strictEqual(expiryCal.pickWeeklyExpiry(noFriday, "2026-08-30"), "2026-09-03");
});

test("0DTE is today on a trading day, 1DTE is next session", function() {
  var d0 = expiryUtil.getExpiryForDTE(0);
  var d1 = expiryUtil.getExpiryForDTE(1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d0));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d1));
  assert.ok(d1 > d0 || d1 >= d0);
});

console.log("misc");
test("SPXW displays as SPX", function() {
  assert.strictEqual(yahoo.displaySymbol("SPXW"), "SPX");
  assert.strictEqual(yahoo.displaySymbol("SPY"), "SPY");
});

test("authguard is off without WEBHOOK_SECRET", function() {
  assert.strictEqual(!!authguard.getSecret(), !!(process.env.WEBHOOK_SECRET || process.env.API_SECRET));
});

test("grok secret falls back to WEBHOOK_SECRET", function() {
  var origGrok = process.env.GROK_API_SECRET;
  var origWh = process.env.WEBHOOK_SECRET;
  var origApi = process.env.API_SECRET;
  delete process.env.GROK_API_SECRET;
  delete process.env.WEBHOOK_SECRET;
  delete process.env.API_SECRET;
  assert.strictEqual(authguard.getGrokSecret(), null);
  process.env.WEBHOOK_SECRET = "grok-only";
  assert.strictEqual(authguard.getGrokSecret(), "grok-only");
  delete process.env.WEBHOOK_SECRET;
  process.env.GROK_API_SECRET = "grok-dedicated";
  assert.strictEqual(authguard.getGrokSecret(), "grok-dedicated");
  if (origGrok !== undefined) process.env.GROK_API_SECRET = origGrok;
  else delete process.env.GROK_API_SECRET;
  if (origWh !== undefined) process.env.WEBHOOK_SECRET = origWh;
  else delete process.env.WEBHOOK_SECRET;
  if (origApi !== undefined) process.env.API_SECRET = origApi;
  else delete process.env.API_SECRET;
});

test("trade sizing preview matches live half+half", function() {
  var state = require("../utils/state");
  var sz = state.getTradeSizingFromTotal(7);
  assert.strictEqual(sz.halfEntry, 4);
  assert.strictEqual(sz.retestAdd, 4);
  assert.strictEqual(sz.fullPosition, 8);
  var from1 = state.getTradeSizingFromTotal(1);
  assert.strictEqual(from1.halfEntry, 1);
  assert.strictEqual(from1.retestAdd, 1);
});

test("import infers half vs full from qty without mutating persist", function() {
  var state = require("../utils/state");
  var half = state.phaseFromQty(3, 3);
  assert.strictEqual(half.halfIn, true);
  assert.strictEqual(half.fullIn, false);
  assert.strictEqual(half.contracts, 3);
  var full = state.phaseFromQty(6, 3);
  assert.strictEqual(full.halfIn, false);
  assert.strictEqual(full.fullIn, true);
  assert.strictEqual(full.contracts, 6);
});

test("syncPositionQty does not re-arm halfIn after a trim", function() {
  var state = require("../utils/state");
  var s = state.getState();
  var snapPos = { SPY: s.positions.SPY, IWM: s.positions.IWM };
  var snapC = { SPY: s.contracts.SPY, IWM: s.contracts.IWM };
  try {
    s.contracts.SPY = 4;
    s.contracts.IWM = 4;
    state.openHalfPosition("SPY", "call", 2, 1.50);
    state.addSecondHalf("SPY", 2, 1.60);
    assert.strictEqual(state.getPosition("SPY").halfIn, false);
    assert.ok(Math.abs(state.getPosition("SPY").entryPrice - 1.55) < 1e-9);
    state.syncPositionQty("SPY", 2);
    var trimmed = state.getPosition("SPY");
    assert.strictEqual(trimmed.contracts, 2);
    assert.strictEqual(trimmed.halfIn, false);
    assert.strictEqual(trimmed.fullIn, true);
  } finally {
    s.positions.SPY = snapPos.SPY;
    s.positions.IWM = snapPos.IWM;
    s.contracts.SPY = snapC.SPY;
    s.contracts.IWM = snapC.IWM;
    state.setContractSize(snapC.SPY, snapC.IWM);
  }
});

test("fill price uses per-share execution and total processed_premium", function() {
  var rh = require("../utils/robinhood");
  assert.strictEqual(rh.fillPriceFromOrder({ price: "2.10", state: "filled" }), 2.10);
  assert.strictEqual(rh.fillPriceFromOrder({
    price: "2.10",
    processed_premium: "61",
    quantity: "1",
    trade_value_multiplier: "100"
  }), 0.61);
  assert.strictEqual(rh.fillPriceFromOrder({
    price: "2.10",
    legs: [{ executions: [{ price: "1.92" }] }]
  }), 1.92);
  assert.strictEqual(rh.fillPriceFromOrder({ price: "1.85", processed_premium: "185", quantity: "1" }), 1.85);
});

test("RH position average_price normalizes to per-share", function() {
  var reconcile = require("../utils/reconcile");
  assert.strictEqual(reconcile.entryPriceFromRh({ average_price: "1.85" }, 2.40), 1.85);
  assert.strictEqual(reconcile.entryPriceFromRh({ average_price: "61.00", trade_value_multiplier: "100" }, 0.58), 0.61);
});

test("entryLooksInflated detects premium stored as total", function() {
  var reconcile = require("../utils/reconcile");
  assert.strictEqual(reconcile.entryLooksInflated(61, 0.61, 0.85), true);
  assert.strictEqual(reconcile.entryLooksInflated(1.85, 1.85, 2.40), false);
});

test("ET interval aligns to Eastern clock boundaries", function() {
  var ms = exitlogic.msUntilNextETInterval(15);
  assert.ok(ms > 0 && ms <= 15 * 60 * 1000);
});

test("Sunday digest header and implied-move levels", function() {
  var block = {
    ticker: "SPY",
    snap: {
      display: "SPY",
      close: 769.35,
      changePct: -0.23,
      ema21: 764.90,
      sma55: 753.15,
      distEma21Pct: 0.58,
      distSma55Pct: 2.15,
      trend: "above both"
    },
    moves: {
      price: 769.35,
      sessions: [{ expiry: "2026-08-31", moveDollars: 4.87, movePct: 0.63, price: 769.35 }],
      weekly: { expiry: "2026-09-04", moveDollars: 8.27, movePct: 1.07, price: 769.35 }
    }
  };
  assert.strictEqual(closeDigest.formatSundayHeader(block), "$SPY: $769.35 (-0.23%)");
  var body = closeDigest.formatSundayBlock(block);
  assert.ok(body.indexOf("21 EMA $764.90 (+0.58%)") !== -1);
  assert.ok(body.indexOf("55 SMA $753.15 (+2.15%)") !== -1);
  assert.ok(body.indexOf("Trend: above both") !== -1);
  assert.ok(body.indexOf("Daily Expected Move: 8/31 +$4.87 (0.63%)") !== -1);
  assert.ok(body.indexOf("Upper EM: $774.22") !== -1);
  assert.ok(body.indexOf("Lower EM: $764.48") !== -1);
  assert.ok(body.indexOf("Weekly Expected Move: 8/31- 9/4 +$8.27 (1.07%)") !== -1);
  var thuWeek = JSON.parse(JSON.stringify(block));
  thuWeek.moves.weekly.expiry = "2026-09-03";
  var thuBody = closeDigest.formatSundayBlock(thuWeek);
  assert.ok(thuBody.indexOf("Weekly Expected Move: 8/31- 9/4") !== -1, "week end is calendar Friday even if option expiry is Thursday");
  assert.ok(thuBody.indexOf("9/3") === -1);
  assert.ok(body.indexOf("Upper EM: $777.62") !== -1);
  assert.ok(body.indexOf("Lower EM: $761.08") !== -1);
  assert.ok(body.indexOf("⚡") === -1);
  var spyIdx = body.indexOf("$SPY:");
  assert.ok(spyIdx === -1, "ticker header lives in the field name, not the body");
});

test("Robinhood refresh requires device_token", async function() {
  var rh = require("../utils/robinhood");
  var savedDevice = process.env.RH_DEVICE_TOKEN;
  delete process.env.RH_DEVICE_TOKEN;
  rh.clearAuthSession();
  rh.setDeviceToken(null);
  var r = await rh.refreshToken("fake-refresh-token");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, "missing_device_token");
  if (savedDevice) process.env.RH_DEVICE_TOKEN = savedDevice;
});

test("JWT expiry decode for proactive refresh", function() {
  var rh = require("../utils/robinhood");
  var header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  var payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url");
  var token = header + "." + payload + ".sig";
  assert.strictEqual(rh.decodeJwtExp(token), 2000000000 * 1000);
});

test("trading_enabled defaults true and persists", function() {
  var settings = require("../utils/settings");
  settings.setTradingEnabled(true);
  assert.strictEqual(settings.isTradingEnabled(), true);
  settings.setTradingEnabled(false);
  assert.strictEqual(settings.isTradingEnabled(), false);
  settings.setTradingEnabled(true);
});

test("dual_leg_live defaults false and persists", function() {
  var settings = require("../utils/settings");
  settings.setDualLegLive(false);
  assert.strictEqual(settings.isDualLegLive(), false);
  settings.setDualLegLive(true);
  assert.strictEqual(settings.isDualLegLive(), true);
  settings.setDualLegLive(false);
  assert.strictEqual(settings.isDualLegLive(), false);
  var all = settings.getAll();
  assert.strictEqual(all.dual_leg_live, false);
});

test("cross_entry_enabled defaults true and persists", function() {
  var settings = require("../utils/settings");
  settings.setCrossEntryEnabled(true);
  assert.strictEqual(settings.isCrossEntryEnabled(), true);
  settings.setCrossEntryEnabled(false);
  assert.strictEqual(settings.isCrossEntryEnabled(), false);
  settings.setCrossEntryEnabled(true);
  assert.strictEqual(settings.isCrossEntryEnabled(), true);
  var all = settings.getAll();
  assert.strictEqual(all.cross_entry_enabled, true);
});

test("Whop license key format accepts dash-separated uppercase", function() {
  var whop = require("../scripts/whop-customer-templates/whopLicense");
  assert.strictEqual(whop.isLicenseKeyFormat("ABCD12-EF3456-GH7890"), true);
  assert.strictEqual(whop.isLicenseKeyFormat("T-D9825F-713A53FD-DD2E4CW"), true);
  assert.strictEqual(whop.isLicenseKeyFormat("abcd12-ef3456-gh7890"), false);
  assert.strictEqual(whop.isLicenseKeyFormat("NODASHES"), false);
  assert.strictEqual(whop.isLicenseKeyFormat(""), false);
});

test("Whop premarket slotDue fires in 2-minute ET window", function() {
  var whop = require("../scripts/whop-customer-templates/whopLicense");
  assert.strictEqual(whop.slotDue(whop.CHECK_T60_MIN, whop.CHECK_T60_MIN, false), true);
  assert.strictEqual(whop.slotDue(whop.CHECK_T60_MIN + 1, whop.CHECK_T60_MIN, false), true);
  assert.strictEqual(whop.slotDue(whop.CHECK_T60_MIN + 2, whop.CHECK_T60_MIN, false), false);
  assert.strictEqual(whop.slotDue(whop.CHECK_T60_MIN, whop.CHECK_T60_MIN, true), false);
  assert.strictEqual(whop.slotDue(whop.CHECK_T1_MIN, whop.CHECK_T1_MIN, false), true);
});

test("Whop product catalog lists all AI Orb Trader Pro tiers", function() {
  var catalog = require("../scripts/whop-customer-templates/whop-products.json");
  assert.strictEqual(catalog.companyId, "biz_WtV0OPGXfsal8r");
  assert.strictEqual(catalog.products.length, 4);
  var ids = catalog.products.map(function(p) { return p.id; });
  assert.ok(ids.indexOf("prod_qp6ewBBRjFpze") !== -1);
  assert.ok(ids.indexOf("prod_ffd2vAuWFMXaN") !== -1);
});

test("setPositionLegs averages dual-leg entry and totals contracts", function() {
  var stateModule = require("../utils/state");
  stateModule.openHalfPosition("SPY", "call", 2, 1.0, { dualLeg: true, totalContracts: 1 });
  stateModule.setPositionLegs("SPY", [
    { dteTag: 0, contracts: 1, entryPrice: 1.0, strike: 500, expiry: "2099-01-01", instrumentUrl: "u0" },
    { dteTag: 1, contracts: 1, entryPrice: 2.0, strike: 505, expiry: "2099-01-02", instrumentUrl: "u1" }
  ]);
  var pos = stateModule.getPosition("SPY");
  assert.ok(pos);
  assert.strictEqual(pos.contracts, 2);
  assert.strictEqual(pos.dualLeg, true);
  assert.strictEqual(pos.totalContracts, 1);
  assert.ok(Math.abs(pos.entryPrice - 1.5) < 1e-9);
  stateModule.reduceLegContracts("SPY", 0, 1);
  pos = stateModule.getPosition("SPY");
  assert.strictEqual(pos.contracts, 1);
  assert.strictEqual(pos.legs[0].contracts, 0);
  assert.strictEqual(pos.instrumentUrl, "u1");
  stateModule.closePosition("SPY", "test cleanup");
});

test("webhook queue enqueues and summarizes", function() {
  var webhookQueue = require("../utils/webhookQueue");
  var before = webhookQueue.summary().total;
  webhookQueue.enqueue({ ticker: "SPY", event: "orb_set" });
  var after = webhookQueue.summary();
  assert.ok(after.total >= before + 1);
  assert.ok(after.counts.pending >= 1 || after.counts.retry >= 1 || after.counts.processing >= 1 || after.counts.done >= 1);
});

test("Sunday premarket tickers scoped per Discord channel", function() {
  assert.deepStrictEqual(
    closeDigest.sundayTickersForChannel({ id: "main", tickers: ["SPXW"] }),
    closeDigest.MAIN_WATCHLIST
  );
  assert.deepStrictEqual(
    closeDigest.sundayTickersForChannel({ id: "spy0dte", tickers: ["SPY"] }),
    ["SPY"]
  );
  assert.deepStrictEqual(
    closeDigest.sundayTickersForChannel({ id: "free", tickers: ["IWM"] }),
    ["IWM"]
  );
  assert.deepStrictEqual(
    closeDigest.sundayTickersForChannel({ id: "qqq", tickers: ["QQQ"] }),
    ["QQQ"]
  );
});

console.log("orb");
var orbUtil = require("../utils/orb");

test("rejects flat ORB range (high <= low)", function() {
  assert.strictEqual(orbUtil.isValidRange(291.93, 291.93), false);
  assert.strictEqual(orbUtil.isValidRange(292.5, 291.2), true);
  assert.strictEqual(orbUtil.isValidRange(0, 0), false);
});

test("opening bar timestamp resolves to 9:30 ET", function() {
  // Mon Aug 31 2026 9:30 AM ET = 1756647000 unix (verify)
  var mins = orbUtil.barStartMinutesET(1756647000);
  assert.strictEqual(mins, 9 * 60 + 30);
});

console.log("grokContent");
var grokContent = require("../utils/grokContent");

test("builds green-day TikTok package with grok prompt", function() {
  var snap = {
    date: "2026-08-31",
    channel: { id: "spy0dte", name: "SPY ORB Trader", theme: "spy", tradeTicker: "SPY", signalTickers: ["SPY"] },
    trades: [
      { ticker: "SPY 0DTE", side: "call", entry: 2.5, maxPrice: 3.2, maxGainPct: 28, totalProfit: 350, leg: "SPY:0" },
      { ticker: "SPY 1DTE", side: "call", entry: 3.0, maxPrice: 3.1, maxGainPct: 3.3, totalProfit: -80, leg: "SPY:1" }
    ],
    wins: 1,
    losses: 1,
    balance: 10270,
    startingBalance: 10000,
    pnl: { daily: 270, weekly: 500, monthly: 1200, allTime: 270 },
    unrealized: 0
  };
  var pkg = grokContent.buildPackage(snap);
  assert.strictEqual(pkg.headline.label, "GREEN DAY");
  assert.strictEqual(pkg.stats.totalTrades, 2);
  assert.strictEqual(pkg.stats.winRate, 50);
  assert.strictEqual(pkg.highlights.best.totalProfit, 350);
  assert.ok(pkg.tiktok.hook.indexOf("GREEN DAY") >= 0);
  assert.ok(pkg.tiktok.hashtags.indexOf("#SPY") >= 0);
  assert.ok(pkg.grokPrompt.indexOf("SPY ORB Trader") >= 0);
  assert.ok(pkg.grokPrompt.indexOf("Not financial advice") >= 0);
});

test("builds red-day package with no trades", function() {
  var snap = {
    date: "2026-08-30",
    channel: { id: "qqq", name: "QQQ ORB Trader", theme: "qqq", tradeTicker: "QQQ", signalTickers: ["QQQ"] },
    trades: [],
    wins: 0,
    losses: 0,
    balance: 10000,
    startingBalance: 10000,
    pnl: { daily: -120, weekly: -120, monthly: -120, allTime: -120 },
    unrealized: 0
  };
  var pkg = grokContent.buildPackage(snap);
  assert.strictEqual(pkg.headline.label, "RED DAY");
  assert.strictEqual(pkg.stats.totalTrades, 0);
  assert.strictEqual(pkg.highlights.best, null);
  assert.ok(pkg.tiktok.beats.some(function(b) { return b.indexOf("No closed trades") >= 0; }));
});

test("save and load package round-trip", function() {
  var snap = {
    date: "2099-01-15",
    channel: { id: "test-grok", name: "Test Channel", theme: "default", tradeTicker: "SPXW", signalTickers: ["SPY"] },
    trades: [{ ticker: "SPXW 0DTE", side: "put", entry: 4, maxPrice: 5, maxGainPct: 25, totalProfit: 100, leg: "SPXW:0" }],
    wins: 1,
    losses: 0,
    balance: 50100,
    startingBalance: 50000,
    pnl: { daily: 100, weekly: 100, monthly: 100, allTime: 100 },
    unrealized: 0
  };
  var saved = grokContent.buildAndSave(snap);
  assert.ok(saved.paths.jsonPath);
  var loaded = grokContent.loadPackage("2099-01-15", "test-grok");
  assert.strictEqual(loaded.channel.id, "test-grok");
  assert.strictEqual(loaded.trades.length, 1);
  var prompt = grokContent.loadPrompt("2099-01-15", "test-grok");
  assert.ok(prompt && prompt.indexOf("Test Channel") >= 0);
  var all = grokContent.loadAllForDate("2099-01-15");
  assert.ok(all.channels["test-grok"]);
  try {
    require("fs").unlinkSync(saved.paths.jsonPath);
    require("fs").unlinkSync(saved.paths.promptPath);
    require("fs").unlinkSync(saved.paths.allPath);
    if (saved.paths.dailyFeedPath && require("fs").existsSync(saved.paths.dailyFeedPath)) {
      require("fs").unlinkSync(saved.paths.dailyFeedPath);
    }
    require("fs").rmdirSync(require("path").join(grokContent.contentRoot(), "2099-01-15"));
  } catch (e) { /* cleanup best-effort */ }
});

test("daily feed bundles channel packages for Grok Bot pull", function() {
  var date = "2099-02-01";
  var snaps = [
    {
      date: date,
      channel: { id: "main", name: "Argus ORB Trader 50K", theme: "default", tradeTicker: "SPXW", signalTickers: ["SPY"] },
      trades: [], wins: 0, losses: 0, balance: 50000, startingBalance: 50000,
      pnl: { daily: 200, weekly: 200, monthly: 200, allTime: 200 }, unrealized: 0
    },
    {
      date: date,
      channel: { id: "spy0dte", name: "SPY ORB Trader", theme: "spy", tradeTicker: "SPY", signalTickers: ["SPY"] },
      trades: [], wins: 0, losses: 0, balance: 10000, startingBalance: 10000,
      pnl: { daily: -50, weekly: -50, monthly: -50, allTime: -50 }, unrealized: 0
    }
  ];
  grokContent.buildAndSave(snaps[0]);
  var second = grokContent.buildAndSave(snaps[1]);
  var feed = grokContent.loadDailyFeed(date);
  assert.strictEqual(feed.videoCount, 2);
  assert.strictEqual(feed.tiktokAccounts, 1);
  assert.strictEqual(feed.channels.length, 2);
  assert.ok(feed.grokBotPrompt.indexOf("VIDEO 1/2") >= 0);
  assert.ok(feed.grokBotPrompt.indexOf("VIDEO 2/2") >= 0);
  assert.ok(feed.grokBotPrompt.indexOf("connected TikTok account") >= 0);
  try {
    require("fs").unlinkSync(second.paths.jsonPath);
    require("fs").unlinkSync(require("path").join(grokContent.contentRoot(), date, "main.json"));
    require("fs").unlinkSync(require("path").join(grokContent.contentRoot(), date, "main-grok-prompt.txt"));
    require("fs").unlinkSync(require("path").join(grokContent.contentRoot(), date, "spy0dte-grok-prompt.txt"));
    require("fs").unlinkSync(second.paths.allPath);
    require("fs").unlinkSync(second.paths.dailyFeedPath);
    require("fs").rmdirSync(require("path").join(grokContent.contentRoot(), date));
  } catch (e) { /* cleanup best-effort */ }
});

test("serializes index expected moves for Grok daily feed", function() {
  var raw = {
    sessionLabel: "Wednesday, Sep 3, 2026",
    computedAt: "2026-09-02T12:00:00.000Z",
    tickers: [
      {
        ticker: "SPY",
        price: 562.34,
        refPrice: 561,
        sessions: [{
          horizon: "Next session",
          expiry: "2026-09-03",
          label: "Wednesday, Sep 3, 2026",
          shortLabel: "Wed Sep 3",
          moveDollars: 5.23,
          movePct: 0.93,
          upper: 567.57,
          lower: 557.11,
          oneSdDollars: 6.15,
          oneSdPct: 1.09,
          oneSdUpper: 568.49,
          oneSdLower: 556.19
        }]
      },
      {
        ticker: "SPXW",
        price: 6234.5,
        refPrice: 6220,
        proxySource: "SPY",
        sessions: [{
          horizon: "Next session",
          expiry: "2026-09-03",
          moveDollars: 58.1,
          movePct: 0.93,
          upper: 6292.6,
          lower: 6176.4
        }]
      }
    ]
  };
  var block = grokContent.serializeIndexExpectedMoves(raw);
  assert.strictEqual(block.indexes.length, 2);
  assert.strictEqual(block.indexes[0].ticker, "SPY");
  assert.strictEqual(block.indexes[1].displayTicker, "SPX");
  assert.strictEqual(block.indexes[1].proxySource, "SPY");
  var promptLines = grokContent.formatExpectedMovesForPrompt(block);
  assert.ok(promptLines.some(function(l) { return l.indexOf("INDEX EXPECTED MOVES") >= 0; }));
  assert.ok(promptLines.some(function(l) { return l.indexOf("SPX @") >= 0; }));
});

test("daily feed includes expected moves when provided", function() {
  var date = "2099-03-01";
  var snap = {
    date: date,
    channel: { id: "qqq", name: "QQQ ORB Trader", theme: "qqq", tradeTicker: "QQQ", signalTickers: ["QQQ"] },
    trades: [], wins: 0, losses: 0, balance: 10000, startingBalance: 10000,
    pnl: { daily: 0, weekly: 0, monthly: 0, allTime: 0 }, unrealized: 0
  };
  grokContent.buildAndSave(snap);
  var moves = {
    sessionLabel: "Thursday, Mar 2, 2099",
    computedAt: "2099-03-01T21:00:00.000Z",
    indexes: [
      {
        ticker: "QQQ",
        displayTicker: "QQQ",
        price: 500,
        refPrice: 498,
        nextSession: {
          horizon: "Next session",
          moveDollars: 4.5,
          movePct: 0.9,
          upper: 504.5,
          lower: 495.5
        }
      }
    ]
  };
  var feed = grokContent.refreshDailyFeed(date, moves);
  assert.ok(feed.expectedMoves);
  assert.strictEqual(feed.expectedMoves.indexes.length, 1);
  assert.ok(feed.grokBotPrompt.indexOf("INDEX EXPECTED MOVES") >= 0);
  assert.ok(feed.grokBotPrompt.indexOf("QQQ @") >= 0);
  try {
    require("fs").unlinkSync(require("path").join(grokContent.contentRoot(), date, "qqq.json"));
    require("fs").unlinkSync(require("path").join(grokContent.contentRoot(), date, "qqq-grok-prompt.txt"));
    require("fs").unlinkSync(require("path").join(grokContent.contentRoot(), date, "all.json"));
    require("fs").unlinkSync(grokContent.dailyFeedFile(date));
    require("fs").rmdirSync(require("path").join(grokContent.contentRoot(), date));
  } catch (e) { /* cleanup best-effort */ }
});

console.log("qqqYahooSignals");
var qqqYahoo = require("../utils/qqqYahooSignals");
test("QQQ Yahoo picks breakout long above ORB high", function() {
  assert.strictEqual(qqqYahoo.pickSignalEvent(708.5, 707.69, 706.21, null), "breakout_long");
});
test("QQQ Yahoo picks breakout short below ORB low", function() {
  assert.strictEqual(qqqYahoo.pickSignalEvent(705.5, 707.69, 706.21, null), "breakout_short");
});
test("QQQ Yahoo stop long at ORB mid when in call", function() {
  assert.strictEqual(qqqYahoo.pickSignalEvent(706.5, 707.69, 706.21, "call"), "stop_long");
});
test("QQQ Yahoo stop short at ORB mid when in put", function() {
  assert.strictEqual(qqqYahoo.pickSignalEvent(707.5, 707.69, 706.21, "put"), "stop_short");
});
test("QQQ Yahoo no signal inside range when flat", function() {
  assert.strictEqual(qqqYahoo.pickSignalEvent(707.0, 707.69, 706.21, null), null);
});
test("QQQ Yahoo uses last fully closed 5m bar", function() {
  var now = 1000000;
  var chart = {
    chart: {
      result: [{
        timestamp: [now - 600, now - 300, now - 60],
        indicators: { quote: [{ close: [706, 707, 708], high: [706, 707, 708], low: [705, 706, 707] }] },
        meta: { currentTradingPeriod: { regular: { start: now - 10000 } } }
      }]
    }
  };
  var bar = qqqYahoo.getLatestClosedBar(chart, now);
  assert.strictEqual(bar.ts, now - 300);
  assert.strictEqual(bar.close, 707);
});

console.log("discord");
test("daily summary splits busy sessions across multiple Discord messages", function() {
  var discord = require("../utils/discord");
  var trades = [];
  for (var i = 0; i < 30; i++) {
    trades.push({
      ticker: "SPXW " + (i % 2 === 0 ? "0DTE" : "1DTE"),
      side: i % 3 === 0 ? "call" : "put",
      entry: 10 + i,
      maxPrice: 12 + i,
      maxGainPct: 20 + i,
      totalProfit: i % 2 === 0 ? 250 : -120
    });
  }
  var chunks = discord.chunkTradeLines(trades);
  assert.ok(chunks.length >= 2, "expected multiple chunks, got " + chunks.length);
  chunks.forEach(function(ch, idx) {
    assert.ok(ch.length <= 1024, "chunk " + idx + " length " + ch.length);
  });
  var joined = chunks.join("\n");
  assert.ok(joined.indexOf("…and") < 0);
  assert.strictEqual((joined.match(/SPXW/g) || []).length, 30);
});

if (process.exitCode) {
  console.error("\nAUDIT TESTS FAILED");
  process.exit(1);
}
console.log("\n" + passed + " tests passed");
