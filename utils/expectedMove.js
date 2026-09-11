// utils/expectedMove.js
// Calendar-based expected moves from ATM straddles + 1σ next-session for indices.

var yahoo = require("./yahoo");
var marketCal = require("./marketCalendar");
var expiryUtil = require("./expiry");
var expiryCal = require("./expiryCalendar");

var ONE_SD_TICKERS = ["SPY", "IWM", "QQQ", "SPXW"];
var ONE_SD_FACTOR = 1 / 0.85; // straddle ≈ 85% of 1 standard deviation
var MOVE_PROXY = { SPXW: "SPY" }; // Yahoo ^GSPC options chain unavailable — scale SPY implied move

function sessionLabel(date) {
  var d = date;
  if (typeof date === "string") d = new Date(date + "T12:00:00");
  if (!d) d = marketCal.nextTradingDayAfter(new Date());
  var ymd = marketCal.ymdInET(d);
  var weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(d);
  return weekday + ", " + expiryUtil.formatExpiryLabel(ymd);
}

function shortLabel(ymd) {
  var d = new Date(ymd + "T12:00:00");
  var weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
  return weekday + " " + expiryUtil.formatExpiryLabel(ymd);
}

function unique(list) {
  var out = [];
  list.forEach(function(v) { if (v && out.indexOf(v) === -1) out.push(v); });
  return out;
}

function enrichOneSd(data, include) {
  if (!include || !data) return data;
  var sd = data.moveDollars * ONE_SD_FACTOR;
  data.oneSdDollars = sd;
  data.oneSdPct = (sd / data.price) * 100;
  data.oneSdUpper = data.price + sd;
  data.oneSdLower = data.price - sd;
  return data;
}

function packHorizon(data, horizon, expiryYmd, opts) {
  if (!data) return null;
  var d = enrichOneSd(Object.assign({}, data), opts && opts.oneSd);
  return {
    horizon: horizon,
    expiry: expiryYmd,
    label: sessionLabel(expiryYmd),
    shortLabel: shortLabel(expiryYmd),
    moveDollars: d.moveDollars,
    movePct: d.movePct,
    upper: d.upper,
    lower: d.lower,
    strike: d.strike,
    callPrice: d.callPrice,
    putPrice: d.putPrice,
    price: d.price,
    oneSdDollars: d.oneSdDollars || null,
    oneSdPct: d.oneSdPct || null,
    oneSdUpper: d.oneSdUpper || null,
    oneSdLower: d.oneSdLower || null
  };
}

function computeExpectedMove(ticker, expiryYmd) {
  return yahoo.getATMStraddle(ticker, expiryYmd).then(function(data) {
    if (!data) return null;
    return {
      ticker: ticker,
      price: data.price,
      strike: data.strike,
      expiry: data.expiry,
      callPrice: data.callPrice,
      putPrice: data.putPrice,
      moveDollars: data.moveDollars,
      movePct: data.movePct,
      upper: data.upper,
      lower: data.lower
    };
  });
}

function detectHits(horizons, refPrice, dayHigh, dayLow) {
  if (!refPrice || !dayHigh || !dayLow) return [];
  var hits = [];
  horizons.forEach(function(h) {
    if (!h || !h.moveDollars) return;
    if (h.horizon === "Next session" || h.horizon === "Session +2") return;
    var up = refPrice + h.moveDollars;
    var dn = refPrice - h.moveDollars;
    if (dayHigh >= up) hits.push({ horizon: h.horizon, side: "upper", level: up, label: h.shortLabel });
    if (dayLow <= dn) hits.push({ horizon: h.horizon, side: "lower", level: dn, label: h.shortLabel });
  });
  return hits;
}

function formatHits(hits) {
  if (!hits || !hits.length) return "No expected-move levels hit today (vs prior close).";
  return "**Hit today** (from prior close):\n" + hits.map(function(h) {
    var arrow = h.side === "upper" ? "▲ upper" : "▼ lower";
    return "• " + h.horizon + " " + arrow + " $" + h.level.toFixed(2);
  }).join("\n");
}

function scaleHorizonFromProxy(h, price) {
  if (!h || !price) return null;
  var moveDollars = price * (h.movePct / 100);
  var scaled = Object.assign({}, h, {
    moveDollars: moveDollars,
    price: price,
    upper: price + moveDollars,
    lower: price - moveDollars
  });
  if (h.oneSdPct) {
    scaled.oneSdDollars = price * (h.oneSdPct / 100);
    scaled.oneSdUpper = price + scaled.oneSdDollars;
    scaled.oneSdLower = price - scaled.oneSdDollars;
  }
  return scaled;
}

function scaleMovesFromProxy(proxyMoves, ticker, price) {
  if (!proxyMoves || !price) return null;
  var sessions = (proxyMoves.sessions || []).map(function(s) { return scaleHorizonFromProxy(s, price); }).filter(Boolean);
  return {
    ticker: ticker,
    price: price,
    refPrice: proxyMoves.refPrice,
    dayHigh: proxyMoves.dayHigh,
    dayLow: proxyMoves.dayLow,
    sessions: sessions,
    weekly: scaleHorizonFromProxy(proxyMoves.weekly, price),
    monthly: scaleHorizonFromProxy(proxyMoves.monthly, price),
    quarterly: scaleHorizonFromProxy(proxyMoves.quarterly, price),
    hitsToday: proxyMoves.hitsToday || [],
    proxySource: proxyMoves.ticker
  };
}

function computeTickerMovesDirect(ticker) {
  var includeOneSd = ONE_SD_TICKERS.indexOf(ticker) !== -1;

  return Promise.all([
    yahoo.getExpirationDates(ticker),
    yahoo.getIntradayBar(ticker)
  ]).then(function(results) {
    var expiries = results[0];
    var bar = results[1];
    var todayYmd = marketCal.ymdInET(new Date());
    var session1Date = marketCal.nextTradingDayAfter(new Date());
    var session1Ymd = marketCal.ymdInET(session1Date);
    var session2Date = marketCal.nextTradingDayAfter(session1Date);
    var session2Ymd = marketCal.ymdInET(session2Date);
    var weeklyYmd = expiryCal.pickWeeklyExpiry(expiries, todayYmd);
    var monthlyYmd = expiryCal.pickMonthlyExpiry(expiries, todayYmd);
    var quarterlyYmd = expiryCal.pickQuarterlyExpiry(expiries, todayYmd);

    var targets = unique([session1Ymd, session2Ymd, weeklyYmd, monthlyYmd, quarterlyYmd]);
    return Promise.all(targets.map(function(exp) {
      return computeExpectedMove(ticker, exp).then(function(m) { return [exp, m]; });
    })).then(function(pairs) {
      var byExp = {};
      pairs.forEach(function(p) { if (p[1]) byExp[p[0]] = p[1]; });

      var price = (byExp[session1Ymd] && byExp[session1Ymd].price)
        || (pairs[0] && pairs[0][1] && pairs[0][1].price) || null;

      var sessions = [
        packHorizon(byExp[session1Ymd], "Next session", session1Ymd, { oneSd: includeOneSd }),
        packHorizon(byExp[session2Ymd], "Session +2", session2Ymd, { oneSd: false })
      ].filter(Boolean);

      var weekly = packHorizon(byExp[weeklyYmd], "This week", weeklyYmd);
      var monthly = packHorizon(byExp[monthlyYmd], "This month", monthlyYmd);
      var quarterly = packHorizon(byExp[quarterlyYmd], "This quarter", quarterlyYmd);

      var refPrice = (bar && bar.prevClose) ? bar.prevClose : null;
      var dayHigh = bar && bar.high;
      var dayLow = bar && bar.low;
      var hitsToday = detectHits(
        sessions.concat([weekly, monthly, quarterly]),
        refPrice, dayHigh, dayLow
      );

      return {
        ticker: ticker,
        price: price,
        refPrice: refPrice,
        dayHigh: dayHigh,
        dayLow: dayLow,
        sessions: sessions,
        weekly: weekly,
        monthly: monthly,
        quarterly: quarterly,
        hitsToday: hitsToday
      };
    });
  });
}

function computeTickerMoves(ticker) {
  var proxy = MOVE_PROXY[ticker];
  if (!proxy) return computeTickerMovesDirect(ticker);

  return computeTickerMovesDirect(proxy).then(function(proxyMoves) {
    if (!proxyMoves) return null;
    return Promise.all([
      yahoo.getUnderlyingPrice(ticker),
      yahoo.getIntradayBar(ticker)
    ]).then(function(results) {
      var price = results[0];
      var bar = results[1];
      if (!price) return null;
      var scaled = scaleMovesFromProxy(proxyMoves, ticker, price);
      if (!scaled) return null;
      if (bar) {
        scaled.refPrice = bar.prevClose || scaled.refPrice;
        scaled.dayHigh = bar.high;
        scaled.dayLow = bar.low;
        scaled.hitsToday = detectHits(
          scaled.sessions.concat([scaled.weekly, scaled.monthly, scaled.quarterly]),
          scaled.refPrice, scaled.dayHigh, scaled.dayLow
        );
      }
      return scaled;
    });
  });
}

function formatHorizonLine(h) {
  if (!h) return "";
  var pct = (h.movePct >= 0 ? "+" : "") + h.movePct.toFixed(2) + "%";
  var lines = [
    "**" + h.horizon + "** · " + h.shortLabel,
    "Expected ±$" + h.moveDollars.toFixed(2) + " (" + pct + ") · $" + h.lower.toFixed(2) + " — $" + h.upper.toFixed(2)
  ];
  if (h.oneSdDollars) {
    var sdPct = h.oneSdPct.toFixed(2) + "%";
    lines.push("1σ next session ±$" + h.oneSdDollars.toFixed(2) + " (" + sdPct + ") · $" + h.oneSdLower.toFixed(2) + " — $" + h.oneSdUpper.toFixed(2));
  }
  return lines.join("\n");
}

function computeFullMoves(tickers) {
  var list = tickers || ["SPY", "IWM"];
  var uniqueTickers = [];
  list.forEach(function(t) { if (uniqueTickers.indexOf(t) === -1) uniqueTickers.push(t); });

  return Promise.all(uniqueTickers.map(computeTickerMoves)).then(function(results) {
    var tickersOut = results.filter(function(r) {
      return r && (r.sessions.length || r.weekly || r.monthly || r.quarterly);
    });
    return {
      sessionLabel: sessionLabel(marketCal.nextTradingDayAfter(new Date())),
      tickers: tickersOut,
      computedAt: new Date().toISOString()
    };
  });
}

function filterMoves(tickerMoves, plan) {
  if (!tickerMoves || !plan) return tickerMoves;
  var sessions = tickerMoves.sessions || [];
  return {
    ticker: tickerMoves.ticker,
    price: tickerMoves.price,
    refPrice: tickerMoves.refPrice,
    hitsToday: tickerMoves.hitsToday,
    sessions: [].concat(
      plan.nextSession !== false && sessions[0] ? [sessions[0]] : [],
      plan.session2 && sessions[1] ? [sessions[1]] : []
    ),
    weekly: plan.weekly ? tickerMoves.weekly : null,
    monthly: plan.monthly ? tickerMoves.monthly : null,
    quarterly: plan.quarterly ? tickerMoves.quarterly : null
  };
}

function computePlannedMoves(tickers, plan) {
  return computeFullMoves(tickers).then(function(data) {
    data.tickers = data.tickers.map(function(t) { return filterMoves(t, plan); }).filter(function(t) {
      return t && (t.sessions.length || t.weekly || t.monthly || t.quarterly);
    });
    return data;
  });
}

function computeNextSessionMoves(tickers) {
  return computeFullMoves(tickers);
}

module.exports = {
  ONE_SD_TICKERS: ONE_SD_TICKERS,
  computeExpectedMove: computeExpectedMove,
  computeTickerMoves: computeTickerMoves,
  computeFullMoves: computeFullMoves,
  computePlannedMoves: computePlannedMoves,
  filterMoves: filterMoves,
  computeNextSessionMoves: computeNextSessionMoves,
  sessionLabel: sessionLabel,
  formatHorizonLine: formatHorizonLine,
  formatHits: formatHits,
  detectHits: detectHits
};
