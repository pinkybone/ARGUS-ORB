// utils/yahoo.js
// Unauthenticated underlying quotes for SPY, IWM, etc.

var https = require("https");

var SYMBOLS = {
  SPY: "SPY", IWM: "IWM", QQQ: "QQQ", SPX: "^GSPC", SPXW: "^GSPC",
  AAPL: "AAPL", AMZN: "AMZN", META: "META", NVDA: "NVDA", MSFT: "MSFT",
  TSLA: "TSLA", SPCX: "SPCX", XLE: "XLE", GOOG: "GOOG", SMH: "SMH",
  GLD: "GLD", SLV: "SLV"
};
var _session = null; // { cookie, crumb, ts }

function resolveSymbol(ticker) {
  return SYMBOLS[ticker] || ticker;
}

function displaySymbol(ticker) {
  if (ticker === "SPXW" || ticker === "^GSPC") return "SPX";
  return ticker;
}

function httpGet(hostname, path, headers) {
  return new Promise(function(resolve) {
    var req = https.request({ hostname: hostname, path: path, headers: headers }, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() { resolve({ status: r.statusCode, headers: r.headers, body: raw }); });
    });
    req.on("error", function() { resolve({ status: 0, body: "" }); });
    req.setTimeout(8000, function() { req.destroy(); resolve({ status: 0, body: "" }); });
    req.end();
  });
}

function getYahooSession(force) {
  if (!force && _session && (Date.now() - _session.ts) < 30 * 60 * 1000) {
    return Promise.resolve(_session);
  }
  return httpGet("fc.yahoo.com", "/", { "User-Agent": "Mozilla/5.0", Accept: "text/html" }).then(function(fc) {
    var setCookie = fc.headers["set-cookie"] || [];
    var cookie = setCookie.map(function(c) { return c.split(";")[0]; }).join("; ");
    return httpGet("query1.finance.yahoo.com", "/v1/test/getcrumb", {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain",
      Cookie: cookie
    }).then(function(cr) {
      var crumb = (cr.body || "").trim();
      if (!crumb) return null;
      _session = { cookie: cookie, crumb: crumb, ts: Date.now() };
      return _session;
    });
  });
}

function fetchOptionsChain(ticker, dateUnix, retry) {
  var symbol = resolveSymbol(ticker);
  return getYahooSession(false).then(function(session) {
    if (!session) return null;
    var path = "/v7/finance/options/" + encodeURIComponent(symbol) + "?crumb=" + encodeURIComponent(session.crumb);
    if (dateUnix) path += "&date=" + dateUnix;
    return httpGet("query1.finance.yahoo.com", path, {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
      Cookie: session.cookie
    }).then(function(res) {
      if (res.status === 401 && !retry) {
        _session = null;
        return fetchOptionsChain(ticker, dateUnix, true);
      }
      try { return JSON.parse(res.body); } catch (e) { return null; }
    });
  });
}

function getUnderlyingPrice(ticker) {
  return getQuoteSnapshot(ticker).then(function(s) { return s ? s.price : null; });
}

function getQuoteSnapshot(ticker) {
  var symbol = resolveSymbol(ticker);
  return new Promise(function(resolve) {
    var options = {
      hostname: "query1.finance.yahoo.com",
      path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d",
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
    };
    var req = https.request(options, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() {
        try {
          var parsed = JSON.parse(raw);
          var meta = parsed.chart && parsed.chart.result && parsed.chart.result[0] && parsed.chart.result[0].meta;
          if (!meta) return resolve(null);
          var price = parseFloat(meta.regularMarketPrice || meta.previousClose || 0) || null;
          var prev = parseFloat(meta.chartPreviousClose || meta.previousClose || price) || price;
          if (!price) return resolve(null);
          resolve({ price: price, prev_close: prev });
        } catch (e) { resolve(null); }
      });
    });
    req.on("error", function() { resolve(null); });
    req.setTimeout(8000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

function getChart(ticker, interval, range) {
  var symbol = resolveSymbol(ticker);
  return new Promise(function(resolve) {
    var options = {
      hostname: "query1.finance.yahoo.com",
      path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=" + interval + "&range=" + range,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
    };
    var req = https.request(options, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
      });
    });
    req.on("error", function() { resolve(null); });
    req.setTimeout(8000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

function unixToYmd(unix) {
  // Yahoo expirationDates are epoch seconds at UTC midnight of the listed day.
  // America/New_York would shift Friday 00:00 UTC to Thursday evening ET.
  if (unix == null || unix === "") return "";
  var d = new Date(Number(unix) * 1000);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function pickOptionPrice(opt) {
  if (!opt) return null;
  if (opt.lastPrice && opt.lastPrice > 0) return parseFloat(opt.lastPrice);
  var bid = parseFloat(opt.bid);
  var ask = parseFloat(opt.ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return null;
}

// ATM/near-strike option mark when Robinhood is unavailable (Discord paper feed).
function getOptionMark(ticker, side, strike, expiryYmd) {
  var wantStrike = Math.round(parseFloat(strike));
  if (!wantStrike || wantStrike <= 0) return Promise.resolve(null);
  var optionType = side === "call" ? "calls" : "puts";

  return fetchOptionsChain(ticker, null).then(function(data) {
    try {
      var result = data && data.optionChain && data.optionChain.result && data.optionChain.result[0];
      if (!result || !result.options || !result.options.length) return null;

      var expDates = result.expirationDates || [];
      var targetUnix = null;
      if (expiryYmd) {
        for (var i = 0; i < expDates.length; i++) {
          if (unixToYmd(expDates[i]) === expiryYmd) { targetUnix = expDates[i]; break; }
        }
      }
      if (!targetUnix) targetUnix = expDates[0];

      var chain = result.options[0];
      if (targetUnix && chain.expirationDate !== targetUnix && expDates.length > 1) {
        return fetchOptionsChain(ticker, targetUnix).then(function(data2) {
          var r2 = data2 && data2.optionChain && data2.optionChain.result && data2.optionChain.result[0];
          return parseOptionMark(r2, optionType, wantStrike, expiryYmd);
        });
      }
      return parseOptionMark(result, optionType, wantStrike, expiryYmd);
    } catch (e) { return null; }
  });
}

function parseOptionMark(result, optionType, wantStrike, expiryYmd) {
  if (!result || !result.options || !result.options.length) return null;
  var bucket = result.options[0];
  var list = bucket[optionType] || [];
  if (!list.length) return null;

  var best = null;
  var bestDiff = Infinity;
  for (var j = 0; j < list.length; j++) {
    var diff = Math.abs(list[j].strike - wantStrike);
    if (diff < bestDiff) { bestDiff = diff; best = list[j]; }
  }
  if (!best) return null;
  var price = pickOptionPrice(best);
  if (!price || price <= 0) return null;
  var expiry = expiryYmd || unixToYmd(bucket.expirationDate);
  return { price: price, strike: best.strike, expiry: expiry, instrument: null, source: "yahoo" };
}

function findStrikeOption(list, strike) {
  if (!list || !list.length) return null;
  var want = Math.round(strike);
  var best = null;
  var bestDiff = Infinity;
  for (var i = 0; i < list.length; i++) {
    var diff = Math.abs(list[i].strike - want);
    if (diff < bestDiff) { bestDiff = diff; best = list[i]; }
  }
  return best;
}

function getChainForExpiry(ticker, expiryYmd) {
  return fetchOptionsChain(ticker, null).then(function(data) {
    try {
      var result = data && data.optionChain && data.optionChain.result && data.optionChain.result[0];
      if (!result) return null;
      var expDates = result.expirationDates || [];
      var targetUnix = null;
      if (expiryYmd) {
        for (var i = 0; i < expDates.length; i++) {
          if (unixToYmd(expDates[i]) === expiryYmd) { targetUnix = expDates[i]; break; }
        }
      }
      if (!targetUnix && expDates.length) targetUnix = expDates[0];
      if (!targetUnix) return null;

      function packChain(chainResult) {
        if (!chainResult || !chainResult.options || !chainResult.options.length) return null;
        var bucket = chainResult.options[0];
        var quote = chainResult.quote || {};
        var price = quote.regularMarketPrice || quote.postMarketPrice || quote.preMarketPrice || null;
        return {
          price: price ? parseFloat(price) : null,
          expiryYmd: unixToYmd(bucket.expirationDate),
          calls: bucket.calls || [],
          puts: bucket.puts || []
        };
      }

      if (targetUnix && result.options && result.options[0] && result.options[0].expirationDate !== targetUnix) {
        return fetchOptionsChain(ticker, targetUnix).then(function(data2) {
          var r2 = data2 && data2.optionChain && data2.optionChain.result && data2.optionChain.result[0];
          return packChain(r2);
        });
      }
      return packChain(result);
    } catch (e) { return null; }
  });
}

function getATMStraddle(ticker, expiryYmd) {
  return getChainForExpiry(ticker, expiryYmd).then(async function(chain) {
    if (!chain) return null;
    var price = chain.price;
    if (!price || price <= 0) price = await getUnderlyingPrice(ticker);
    if (!price || price <= 0) return null;

    var strike = Math.round(price);
    var call = findStrikeOption(chain.calls, strike);
    var put = findStrikeOption(chain.puts, strike);
    if (!call || !put) return null;

    var callPx = pickOptionPrice(call);
    var putPx = pickOptionPrice(put);
    if (!callPx || !putPx || callPx <= 0 || putPx <= 0) return null;

    var straddle = callPx + putPx;
    var movePct = (straddle / price) * 100;
    return {
      ticker: ticker,
      price: price,
      strike: call.strike,
      expiry: chain.expiryYmd,
      callPrice: callPx,
      putPrice: putPx,
      straddle: straddle,
      moveDollars: straddle,
      movePct: movePct,
      upper: price + straddle,
      lower: price - straddle
    };
  });
}

function getDailyCloses(ticker) {
  return getChart(ticker, "1d", "1y").then(parseDailyCloses);
}

function parseDailyCloses(chartJson) {
  try {
    var result = chartJson && chartJson.chart && chartJson.chart.result && chartJson.chart.result[0];
    if (!result) return null;
    var quotes = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!quotes || !quotes.close) return null;
    var closes = [];
    for (var i = 0; i < quotes.close.length; i++) {
      var c = quotes.close[i];
      if (c !== null && c !== undefined && c > 0) closes.push(parseFloat(c));
    }
    return closes.length >= 56 ? closes : null;
  } catch (e) {
    return null;
  }
}

function parseLatestBar(chartJson) {
  try {
    var result = chartJson && chartJson.chart && chartJson.chart.result && chartJson.chart.result[0];
    if (!result) return null;
    var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!q || !q.close || !q.close.length) return null;
    var i = q.close.length - 1;
    while (i >= 0 && (q.close[i] === null || q.close[i] === undefined)) i--;
    if (i < 0) return null;
    return {
      open: q.open && q.open[i] ? parseFloat(q.open[i]) : null,
      high: q.high && q.high[i] ? parseFloat(q.high[i]) : null,
      low: q.low && q.low[i] ? parseFloat(q.low[i]) : null,
      close: parseFloat(q.close[i]),
      prevClose: result.meta && result.meta.chartPreviousClose
        ? parseFloat(result.meta.chartPreviousClose)
        : (i > 0 && q.close[i - 1] ? parseFloat(q.close[i - 1]) : null)
    };
  } catch (e) {
    return null;
  }
}

function getIntradayBar(ticker) {
  return getChart(ticker, "1d", "5d").then(parseLatestBar);
}

function getExpirationDates(ticker) {
  return fetchOptionsChain(ticker, null).then(function(data) {
    try {
      var result = data && data.optionChain && data.optionChain.result && data.optionChain.result[0];
      if (!result || !result.expirationDates) return [];
      return result.expirationDates.map(unixToYmd).filter(Boolean).sort();
    } catch (e) { return []; }
  });
}

module.exports = {
  getUnderlyingPrice: getUnderlyingPrice,
  getQuoteSnapshot: getQuoteSnapshot,
  getChart: getChart,
  getDailyCloses: getDailyCloses,
  getIntradayBar: getIntradayBar,
  getOptionMark: getOptionMark,
  getChainForExpiry: getChainForExpiry,
  getATMStraddle: getATMStraddle,
  getExpirationDates: getExpirationDates,
  resolveSymbol: resolveSymbol,
  displaySymbol: displaySymbol,
  unixToYmd: unixToYmd,
  SYMBOLS: SYMBOLS
};
