// utils/grokContent.js
// Turns each paper-trading session into a TikTok content package for Grok Bot.

var fs = require("fs");
var path = require("path");
var persist = require("./persist");
var expectedMove = require("./expectedMove");

var VERSION = 1;
var CONTENT_SUBDIR = "grok-content";
var CHANNEL_ORDER = ["main", "free", "spy0dte", "qqq"];
var INDEX_MOVE_TICKERS = ["SPY", "IWM", "QQQ", "SPXW"];
var INDEX_DISPLAY_TICKER = { SPXW: "SPX" };

function formatMoney(n) {
  var abs = Math.abs(n);
  var str = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "-" + str : str;
}

function formatPct(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + "%";
}

function contentRoot() {
  return path.join(persist.dataDir(), CONTENT_SUBDIR);
}

function dayDir(date) {
  return path.join(contentRoot(), date);
}

function channelFile(date, channelId) {
  return path.join(dayDir(date), channelId + ".json");
}

function allFile(date) {
  return path.join(dayDir(date), "all.json");
}

function dailyFeedFile(date) {
  return path.join(dayDir(date), "daily-grok-bot.json");
}

function indexMovesFile(date) {
  return path.join(dayDir(date), "index-expected-moves.json");
}

function displayTicker(ticker) {
  return INDEX_DISPLAY_TICKER[ticker] || ticker;
}

function serializeIndexEntry(tickerMoves) {
  if (!tickerMoves) return null;
  var nextSession = (tickerMoves.sessions && tickerMoves.sessions[0]) || null;
  if (!nextSession) return null;
  return {
    ticker: tickerMoves.ticker,
    displayTicker: displayTicker(tickerMoves.ticker),
    price: tickerMoves.price,
    refPrice: tickerMoves.refPrice || null,
    proxySource: tickerMoves.proxySource || null,
    nextSession: nextSession
  };
}

function serializeIndexExpectedMoves(data) {
  if (!data || !data.tickers) return null;
  var indexes = data.tickers.map(serializeIndexEntry).filter(Boolean);
  if (!indexes.length) return null;
  return {
    sessionLabel: data.sessionLabel,
    computedAt: data.computedAt,
    indexes: indexes
  };
}

function formatExpectedMovesForPrompt(expectedMoves) {
  if (!expectedMoves || !expectedMoves.indexes || !expectedMoves.indexes.length) return [];
  var lines = [];
  lines.push("INDEX EXPECTED MOVES (next session — " + expectedMoves.sessionLabel + "):");
  expectedMoves.indexes.forEach(function(idx) {
    var h = idx.nextSession;
    var name = idx.displayTicker;
    var pct = (h.movePct >= 0 ? "+" : "") + h.movePct.toFixed(2) + "%";
    lines.push("- " + name + " @ $" + (idx.price || 0).toFixed(2)
      + " · expected ±$" + h.moveDollars.toFixed(2) + " (" + pct + ")"
      + " · range $" + h.lower.toFixed(2) + " — $" + h.upper.toFixed(2));
    if (h.oneSdDollars) {
      lines.push("  1σ ±$" + h.oneSdDollars.toFixed(2) + " · $" + h.oneSdLower.toFixed(2) + " — $" + h.oneSdUpper.toFixed(2));
    }
  });
  lines.push("Use these levels as optional context when framing tomorrow's session — not price targets.");
  return lines;
}

function loadCachedIndexExpectedMoves(date) {
  return readJsonSafe(indexMovesFile(date));
}

function fetchAndCacheIndexExpectedMoves(date) {
  return expectedMove.computePlannedMoves(INDEX_MOVE_TICKERS, {
    nextSession: true,
    session2: false,
    weekly: false,
    monthly: false,
    quarterly: false
  }).then(function(data) {
    var block = serializeIndexExpectedMoves(data);
    if (!block) return null;
    var file = indexMovesFile(date);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(block, null, 2));
    return block;
  });
}

function ensureIndexExpectedMoves(date) {
  var cached = loadCachedIndexExpectedMoves(date);
  if (cached && cached.indexes && cached.indexes.length) {
    return Promise.resolve(cached);
  }
  return fetchAndCacheIndexExpectedMoves(date);
}

function promptFile(date, channelId) {
  return path.join(dayDir(date), channelId + "-grok-prompt.txt");
}

function winRate(wins, losses) {
  var total = wins + losses;
  if (!total) return 0;
  return Math.round((wins / total) * 100);
}

function pickExtreme(trades, pickBest) {
  if (!trades || !trades.length) return null;
  var sorted = trades.slice().sort(function(a, b) {
    return pickBest ? b.totalProfit - a.totalProfit : a.totalProfit - b.totalProfit;
  });
  return sorted[0];
}

function tradeSummary(t) {
  return {
    ticker: t.ticker,
    side: t.side,
    leg: t.leg || null,
    entry: t.entry,
    maxPrice: t.maxPrice,
    maxGainPct: t.maxGainPct,
    totalProfit: t.totalProfit,
    totalProfitFormatted: formatMoney(t.totalProfit),
    result: t.totalProfit >= 0 ? "win" : "loss"
  };
}

var THEME_TAGS = {
  default: ["#SPXW", "#SPY", "#ORB", "#0DTE", "#OptionsTrading", "#DayTrading", "#StockMarket"],
  free: ["#IWM", "#ORB", "#0DTE", "#OptionsTrading", "#DayTrading", "#SmallCaps"],
  spy: ["#SPY", "#ORB", "#0DTE", "#OptionsTrading", "#DayTrading", "#StockMarket"],
  qqq: ["#QQQ", "#ORB", "#0DTE", "#OptionsTrading", "#DayTrading", "#Nasdaq"]
};

function themeTags(theme) {
  return THEME_TAGS[theme] || THEME_TAGS.default;
}

function buildTikTokCopy(snapshot) {
  var cfg = snapshot.channel;
  var w = snapshot.pnl;
  var isGreen = w.daily >= 0;
  var emoji = isGreen ? "📈" : "📉";
  var dayLabel = isGreen ? "GREEN DAY" : "RED DAY";
  var ticker = cfg.tradeTicker || "ORB";
  var name = cfg.name || cfg.id;
  var best = pickExtreme(snapshot.trades, true);
  var worst = pickExtreme(snapshot.trades, false);
  var tradeCount = snapshot.trades.length;
  var wr = winRate(snapshot.wins, snapshot.losses);
  var dailyPct = snapshot.startingBalance > 0 ? (w.daily / snapshot.startingBalance) * 100 : 0;

  var hook = isGreen
    ? emoji + " " + dayLabel + ": " + formatMoney(w.daily) + " on " + ticker + " ORB paper trades"
    : emoji + " " + dayLabel + " recap — " + formatMoney(w.daily) + " but here's what we learned on " + ticker;

  var beats = [
    "Open on today's " + ticker + " opening-range breakout session — " + name + " paper account.",
    tradeCount
      ? tradeCount + " closed leg(s): " + snapshot.wins + " win(s), " + snapshot.losses + " loss(s) (" + wr + "% win rate)."
      : "No closed trades today — flat session, capital preserved.",
    "Net P&L: " + formatMoney(w.daily) + " (" + formatPct(dailyPct) + " of starting balance). Balance: " + formatMoney(snapshot.balance) + ".",
    best
      ? "Best trade: " + best.ticker + " " + best.side.toUpperCase() + " " + formatMoney(best.totalProfit) + "."
      : "No standout winner today.",
    worst && worst.totalProfit < 0
      ? "Toughest trade: " + worst.ticker + " " + worst.side.toUpperCase() + " " + formatMoney(worst.totalProfit) + " — risk managed."
      : "Stops and tiers kept drawdowns in check.",
    "Weekly " + formatMoney(w.weekly) + " · Monthly " + formatMoney(w.monthly) + " · Not financial advice."
  ];

  var onScreen = [
    dayLabel + " " + formatMoney(w.daily),
    ticker + " ORB · " + tradeCount + " trade(s)",
    "W/L " + snapshot.wins + "/" + snapshot.losses,
    "Balance " + formatMoney(snapshot.balance)
  ];

  var caption = hook + "\n\n"
    + name + " paper ORB recap for " + snapshot.date + ".\n"
    + (tradeCount ? snapshot.wins + "W / " + snapshot.losses + "L · " : "")
    + formatMoney(w.daily) + " today · " + formatPct(dailyPct) + "\n\n"
    + "ORB = Opening Range Breakout · 0DTE + 1DTE dual-leg paper sim.\n"
    + "Not financial advice. Past paper results ≠ future returns.";

  return {
    hook: hook,
    beats: beats,
    onScreenText: onScreen,
    caption: caption,
    hashtags: themeTags(cfg.theme)
  };
}

function buildGrokPrompt(pkg) {
  var lines = [];
  lines.push("Create a vertical TikTok-style recap video (9:16, ~45–60 seconds) from this ORB paper-trading session.");
  lines.push("");
  lines.push("ACCOUNT: " + pkg.channel.name + " (" + pkg.channel.id + ")");
  lines.push("DATE: " + pkg.date);
  lines.push("INSTRUMENT: " + pkg.channel.tradeTicker + " opening-range breakout (0DTE + 1DTE dual-leg paper sim)");
  lines.push("");
  lines.push("HEADLINE: " + pkg.headline.emoji + " " + pkg.headline.label + " " + pkg.headline.dailyPnlFormatted
    + " (" + pkg.headline.dailyPctFormatted + ")");
  lines.push("");
  lines.push("SESSION STATS:");
  lines.push("- Closed trades: " + pkg.stats.totalTrades + " (" + pkg.stats.wins + " wins / " + pkg.stats.losses + " losses, "
    + pkg.stats.winRate + "% win rate)");
  lines.push("- Starting balance: " + formatMoney(pkg.stats.startingBalance));
  lines.push("- Ending balance: " + formatMoney(pkg.stats.endingBalance));
  lines.push("- Unrealized (open): " + formatMoney(pkg.stats.unrealized));
  lines.push("- Weekly: " + formatMoney(pkg.stats.weekly));
  lines.push("- Monthly: " + formatMoney(pkg.stats.monthly));
  lines.push("- All-time P&L: " + formatMoney(pkg.stats.allTime));
  lines.push("");
  if (pkg.trades.length) {
    lines.push("TRADES (show each as a quick on-screen card):");
    pkg.trades.forEach(function(t, i) {
      lines.push((i + 1) + ". " + t.ticker + " " + t.side.toUpperCase()
        + " · entry $" + (t.entry || 0).toFixed(2)
        + " · max $" + (t.maxPrice || 0).toFixed(2)
        + " · max gain " + formatPct(t.maxGainPct || 0)
        + " · P&L " + t.totalProfitFormatted
        + " (" + t.result + ")");
    });
  } else {
    lines.push("TRADES: No closed trades today.");
  }
  lines.push("");
  if (pkg.highlights.best) {
    lines.push("BEST TRADE: " + pkg.highlights.best.ticker + " " + pkg.highlights.best.side.toUpperCase()
      + " " + pkg.highlights.best.totalProfitFormatted);
  }
  if (pkg.highlights.worst && pkg.highlights.worst.totalProfit < 0) {
    lines.push("WORST TRADE: " + pkg.highlights.worst.ticker + " " + pkg.highlights.worst.side.toUpperCase()
      + " " + pkg.highlights.worst.totalProfitFormatted);
  }
  lines.push("");
  lines.push("VIDEO STRUCTURE:");
  pkg.tiktok.beats.forEach(function(b, i) {
    lines.push((i + 1) + ". " + b);
  });
  lines.push("");
  lines.push("ON-SCREEN TEXT (large, mobile-readable):");
  pkg.tiktok.onScreenText.forEach(function(t) {
    lines.push("- " + t);
  });
  lines.push("");
  lines.push("CAPTION:");
  lines.push(pkg.tiktok.caption);
  lines.push("");
  lines.push("HASHTAGS: " + pkg.tiktok.hashtags.join(" "));
  lines.push("");
  lines.push("STYLE: Energetic but professional finance creator. Green/red P&L colors. Fast cuts. "
    + "End card: \"Not financial advice · Paper sim only\".");
  return lines.join("\n");
}

function buildDailyGrokBotPrompt(date, packages, expectedMoves) {
  var lines = [];
  lines.push("Today's ORB paper trading recaps (" + date + ").");
  lines.push("Create and publish " + packages.length + " separate vertical TikTok recap videos (9:16) to the connected TikTok account — one video per paper channel below.");
  lines.push("Use each channel's caption and hashtags when posting. End every video with \"Not financial advice · Paper sim only\".");
  var moveLines = formatExpectedMovesForPrompt(expectedMoves);
  if (moveLines.length) {
    lines.push("");
    moveLines.forEach(function(line) { lines.push(line); });
  }
  lines.push("");
  packages.forEach(function(pkg, i) {
    lines.push("=== VIDEO " + (i + 1) + "/" + packages.length + ": " + pkg.channel.name + " (" + pkg.channel.id + ") ===");
    lines.push(pkg.grokPrompt);
    lines.push("");
  });
  return lines.join("\n");
}

function buildDailyFeed(date, expectedMoves) {
  var packages = [];
  for (var i = 0; i < CHANNEL_ORDER.length; i++) {
    var pkg = loadPackage(date, CHANNEL_ORDER[i]);
    if (pkg) packages.push(pkg);
  }
  if (!packages.length) return null;

  var moves = expectedMoves || loadCachedIndexExpectedMoves(date);

  var feed = {
    version: VERSION,
    date: date,
    generatedAt: new Date().toISOString(),
    tiktokAccounts: 1,
    videoCount: packages.length,
    instruction: "Create and publish " + packages.length + " separate vertical TikTok recap videos (9:16) to the connected TikTok account — one per channel below.",
    channels: packages,
    grokBotPrompt: buildDailyGrokBotPrompt(date, packages, moves)
  };
  if (moves) feed.expectedMoves = moves;
  return feed;
}

function refreshDailyFeed(date, expectedMoves) {
  var feed = buildDailyFeed(date, expectedMoves);
  if (!feed) return null;
  var file = dailyFeedFile(date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(feed, null, 2));
  return feed;
}

function refreshDailyFeedAsync(date) {
  return ensureIndexExpectedMoves(date).then(function(moves) {
    return refreshDailyFeed(date, moves);
  }).catch(function(err) {
    console.log("[GROK] index expected moves fetch failed: " + err.message);
    return refreshDailyFeed(date, null);
  });
}

function loadDailyFeed(date) {
  return readJsonSafe(dailyFeedFile(date));
}

function buildPackage(snapshot) {
  var cfg = snapshot.channel;
  var w = snapshot.pnl;
  var isGreen = w.daily >= 0;
  var dailyPct = snapshot.startingBalance > 0 ? (w.daily / snapshot.startingBalance) * 100 : 0;
  var trades = (snapshot.trades || []).map(tradeSummary);
  var best = pickExtreme(snapshot.trades, true);
  var worst = pickExtreme(snapshot.trades, false);

  var pkg = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    date: snapshot.date,
    channel: {
      id: cfg.id,
      name: cfg.name,
      theme: cfg.theme || "default",
      tradeTicker: cfg.tradeTicker || null,
      signalTickers: cfg.signalTickers || []
    },
    headline: {
      emoji: isGreen ? "📈" : "📉",
      label: isGreen ? "GREEN DAY" : "RED DAY",
      dailyPnl: w.daily,
      dailyPnlFormatted: formatMoney(w.daily),
      dailyPct: dailyPct,
      dailyPctFormatted: formatPct(dailyPct)
    },
    stats: {
      wins: snapshot.wins || 0,
      losses: snapshot.losses || 0,
      totalTrades: trades.length,
      winRate: winRate(snapshot.wins || 0, snapshot.losses || 0),
      startingBalance: snapshot.startingBalance,
      endingBalance: snapshot.balance,
      unrealized: snapshot.unrealized || 0,
      weekly: w.weekly,
      monthly: w.monthly,
      allTime: w.allTime
    },
    trades: trades,
    highlights: {
      best: best ? tradeSummary(best) : null,
      worst: worst ? tradeSummary(worst) : null
    },
    tiktok: null,
    grokPrompt: null
  };

  pkg.tiktok = buildTikTokCopy(snapshot);
  pkg.grokPrompt = buildGrokPrompt(pkg);
  return pkg;
}

function savePackage(pkg, expectedMoves) {
  var dir = dayDir(pkg.date);
  fs.mkdirSync(dir, { recursive: true });
  var jsonPath = channelFile(pkg.date, pkg.channel.id);
  fs.writeFileSync(jsonPath, JSON.stringify(pkg, null, 2));

  var promptPath = promptFile(pkg.date, pkg.channel.id);
  fs.writeFileSync(promptPath, pkg.grokPrompt, "utf8");

  var allPath = allFile(pkg.date);
  var all = { date: pkg.date, updatedAt: new Date().toISOString(), channels: {} };
  try {
    if (fs.existsSync(allPath)) all = JSON.parse(fs.readFileSync(allPath, "utf8"));
  } catch (e) { /* rebuild */ }
  all.updatedAt = new Date().toISOString();
  all.channels = all.channels || {};
  all.channels[pkg.channel.id] = {
    name: pkg.channel.name,
    headline: pkg.headline,
    stats: { wins: pkg.stats.wins, losses: pkg.stats.losses, totalTrades: pkg.stats.totalTrades },
    file: pkg.channel.id + ".json",
    promptFile: pkg.channel.id + "-grok-prompt.txt"
  };
  fs.writeFileSync(allPath, JSON.stringify(all, null, 2));

  var moves = expectedMoves || loadCachedIndexExpectedMoves(pkg.date);
  var dailyFeed = refreshDailyFeed(pkg.date, moves);

  return {
    jsonPath: jsonPath,
    promptPath: promptPath,
    allPath: allPath,
    dailyFeedPath: dailyFeed ? dailyFeedFile(pkg.date) : null
  };
}

function buildAndSave(snapshot) {
  var pkg = buildPackage(snapshot);
  var paths = savePackage(pkg);
  return { package: pkg, paths: paths };
}

function buildAndSaveAsync(snapshot) {
  var pkg = buildPackage(snapshot);
  return ensureIndexExpectedMoves(pkg.date).then(function(moves) {
    var paths = savePackage(pkg, moves);
    return { package: pkg, paths: paths, expectedMoves: moves };
  });
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

function listDates() {
  var root = contentRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(function(name) { return /^\d{4}-\d{2}-\d{2}$/.test(name); })
    .sort()
    .reverse();
}

function loadPackage(date, channelId) {
  return readJsonSafe(channelFile(date, channelId));
}

function loadAllForDate(date) {
  return readJsonSafe(allFile(date));
}

function loadPrompt(date, channelId) {
  var file = promptFile(date, channelId);
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return null;
  }
}

module.exports = {
  VERSION: VERSION,
  CHANNEL_ORDER: CHANNEL_ORDER,
  INDEX_MOVE_TICKERS: INDEX_MOVE_TICKERS,
  contentRoot: contentRoot,
  buildPackage: buildPackage,
  buildGrokPrompt: buildGrokPrompt,
  buildDailyFeed: buildDailyFeed,
  refreshDailyFeed: refreshDailyFeed,
  refreshDailyFeedAsync: refreshDailyFeedAsync,
  buildAndSave: buildAndSave,
  buildAndSaveAsync: buildAndSaveAsync,
  savePackage: savePackage,
  listDates: listDates,
  loadPackage: loadPackage,
  loadAllForDate: loadAllForDate,
  loadDailyFeed: loadDailyFeed,
  loadPrompt: loadPrompt,
  dailyFeedFile: dailyFeedFile,
  indexMovesFile: indexMovesFile,
  serializeIndexExpectedMoves: serializeIndexExpectedMoves,
  formatExpectedMovesForPrompt: formatExpectedMovesForPrompt,
  loadCachedIndexExpectedMoves: loadCachedIndexExpectedMoves,
  fetchAndCacheIndexExpectedMoves: fetchAndCacheIndexExpectedMoves,
  ensureIndexExpectedMoves: ensureIndexExpectedMoves,
  formatMoney: formatMoney,
  formatPct: formatPct
};
