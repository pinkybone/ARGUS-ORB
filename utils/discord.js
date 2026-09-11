// Discord Paper Trading — MULTI-CHANNEL
// Discord is paper-only. Live Robinhood fills, size, and P&L never post here.
// Paper accounts: percent sizing, 0DTE ATM + 1DTE expected-move legs, touch-based move exits.
//
// Channels (webhook env vars):
//   main     DISCORD_WEBHOOK_URL      SPXW from SPY signals  $50k  5%/trade (2.5% per leg)  15-min
//   free     DISCORD_WEBHOOK_FREE     IWM                    $10k  5%/trade (2.5% per leg)  30-min
//   spy0dte  DISCORD_WEBHOOK_SPY0DTE  SPY                    $10k  5%/trade (2.5% per leg)  30-min
//   qqq      DISCORD_WEBHOOK_QQQ      QQQ                    $10k  5%/trade (2.5% per leg)  30-min

const https = require("https");
const rh = require("./robinhood");
const yahoo = require("./yahoo");
const expiryUtil = require("./expiry");
const exitlogic = require("./exitlogic");
const persist = require("./persist");
const closeDigestUtil = require("./closeDigest");
const grokContent = require("./grokContent");
const technicalsUtil = require("./technicals");
const paperLegs = require("./paperLegs");

var underlyingSnaps = {};

function etTimeLabel() {
  return new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
}

function sizingBlurb(riskPctVal) {
  var rp = riskPctVal || 5;
  return "**Sizing:** " + rp + "% of account balance per trade (2.5% per leg). Contract count scales with option premium — not a fixed number of contracts.";
}

function paperMarketHours() {
  return exitlogic.isRegularMarketHours();
}

// Resolve underlying price for ATM strike: webhook close → Robinhood → Yahoo.
async function resolveUnderlying(ticker, underlying) {
  var v = underlying ? parseFloat(underlying) : NaN;
  if (!isNaN(v) && v > 0) return v;
  try {
    var u = await rh.getQuote(ticker);
    if (u && u > 0) return u;
  } catch (e) {}
  try {
    var y = await yahoo.getUnderlyingPrice(ticker);
    if (y && y > 0) return y;
  } catch (e) {}
  return null;
}

async function fetchOptionMark(ticker, side, strike, expiry) {
  try {
    var m = await rh.getOptionMark(ticker, side, strike, expiry);
    if (m && m.price > 0) return m;
  } catch (e) {
    console.log("[PAPER] RH option mark failed " + ticker + " " + strike + ": " + e.message);
  }
  try {
    var y = await yahoo.getOptionMark(ticker, side, strike, expiry);
    if (y && y.price > 0) {
      console.log("[PAPER] Yahoo option mark " + ticker + " " + y.strike + " $" + y.price.toFixed(2));
      return y;
    }
  } catch (e) {
    console.log("[PAPER] Yahoo option mark failed " + ticker + ": " + e.message);
  }
  return null;
}

async function getUnderlyingSnap(tradeTicker, maxAgeMs) {
  var now = Date.now();
  var cached = underlyingSnaps[tradeTicker];
  if (cached && (now - cached.ts) < maxAgeMs) return cached;
  var price = await yahoo.getUnderlyingPrice(tradeTicker);
  var bar = await yahoo.getIntradayBar(tradeTicker);
  var snap = {
    price: price,
    high: bar && bar.high != null ? bar.high : price,
    low: bar && bar.low != null ? bar.low : price,
    ts: now
  };
  underlyingSnaps[tradeTicker] = snap;
  return snap;
}

// ── low-level + format helpers ──────────────────────────────────────────────
async function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() { resolve({ status: res.statusCode, body: raw }); });
    });
    req.on("error", reject);
    req.write(body); req.end();
  });
}
function formatMoney(n) {
  var abs = Math.abs(n);
  var str = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "-" + str : str;
}
function formatPct(n) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }
function etISODate() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }

var DISCORD_FIELD_MAX = 1024;
var DISCORD_FIELD_SAFE = 980;

function formatTradeLine(t) {
  var e = t.totalProfit >= 0 ? "✅" : "🔴";
  return e + " **" + t.ticker + " " + t.side.toUpperCase() + ":** "
    + formatMoney(t.totalProfit) + " · entry $" + (t.entry || 0).toFixed(2)
    + " · max " + formatPct(t.maxGainPct || 0);
}

function chunkTradeLines(trades) {
  if (!trades || !trades.length) return ["No closed trades today"];
  var chunks = [];
  var current = "";
  for (var i = 0; i < trades.length; i++) {
    var block = formatTradeLine(trades[i]) + "\n";
    if (block.length > DISCORD_FIELD_SAFE) {
      if (current) chunks.push(current.trim());
      chunks.push(block.trim());
      current = "";
      continue;
    }
    if (current.length + block.length > DISCORD_FIELD_SAFE) {
      chunks.push(current.trim());
      current = block;
    } else {
      current += block;
    }
  }
  if (current) chunks.push(current.trim());
  return chunks.length ? chunks : ["No closed trades today"];
}

// Back-compat helper — first chunk only (tests / callers).
function formatTradeLines(trades) {
  return chunkTradeLines(trades)[0];
}

function formatOrbSource(source) {
  var s = String(source || "").toLowerCase();
  if (s === "webhook" || s === "tradingview" || s === "tv") return "TradingView";
  if (s === "yahoo") return "Yahoo";
  if (s === "cached") return "Cached";
  if (!s) return "Yahoo";
  return String(source);
}

// ── morning themes ──────────────────────────────────────────────────────────
function morningMessages(theme, name) {
  if (theme === "free") {
    return {
      60: { color: 0x00e5a0, content: "@everyone", title: "☀️ Good Morning, Free Squad!",
        description: "A brand new day, a brand new shot. 🌅\n\n**" + name + "** is awake and hunting **IWM** setups — 0DTE ATM + 1DTE expected-move legs.\n\n" + sizingBlurb(5) + "\n\nProtect your capital, trust the process, and let's go get it together. 💚",
        footer: "Free alerts • 5% balance/trade • Not financial advice." },
      45: { color: 0x4da6ff, title: "🌤️ 45 Minutes — Getting Ready",
        description: "Coffee up. ☕ Reviewing **IWM 0DTE + 1DTE** legs and expected-move levels before the bell. Discipline beats hype every single time.",
        footer: "Free alerts • 0DTE + 1DTE • Not financial advice." },
      30: { color: 0xf5c518, content: "@everyone", title: "🌅 30 Minutes Out — Stay Patient",
        description: "Half an hour to go. The best traders wait for *their* setup — they don't chase.\n\n**IWM** runs 0DTE ATM + 1DTE at the expected-move strike. We stay calm and let the plan come to us. 🧘",
        footer: "Free alerts • 0DTE + 1DTE • Trade at your own risk." },
      5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — Lock In",
        description: "Almost showtime. Alerts fire on **5m bar close** — not wicks. Each entry opens **0DTE + 1DTE** legs (5% total). Deep breath. 🔥",
        footer: "Free alerts • 0DTE + 1DTE • Trade at your own risk." },
      1:  { color: 0x00e5a0, content: "@everyone", title: "🚀 60 SECONDS — Let's Work",
        description: "Here we go. Stay focused, stay disciplined, and let the setups come. Good luck today, everyone. 💚",
        footer: "Free alerts • Options trading carries substantial risk of loss." }
    };
  }
  if (theme === "spy") {
    return {
      60: { color: 0x00e5a0, content: "@everyone", title: "☀️ Rise & Grind — SPY ORB",
        description: "New day, clean slate. 🌅\n\n**" + name + "** is dialed in on **SPY** — 0DTE ATM + 1DTE expected-move legs.\n\n" + sizingBlurb(5) + "\n\nWe trade the plan, not the emotion. Let's make today count. 💪",
        footer: "SPY ORB • 0DTE + 1DTE • 5% balance/trade • Not financial advice." },
      45: { color: 0x4da6ff, title: "🌤️ 45 Minutes — Pre-Flight Check",
        description: "Reviewing **SPY 0DTE + 1DTE** legs and expected-move levels. Sharp focus now pays off when the bell rings. 📋",
        footer: "SPY ORB • 0DTE + 1DTE • Not financial advice." },
      30: { color: 0xf5c518, content: "@everyone", title: "🌅 30 Minutes — Eyes on SPY",
        description: "Thirty out. Each entry opens **0DTE ATM + 1DTE at the expected-move strike**. We wait for the break, then we execute.\n\nCalm hands win. 🧘",
        footer: "SPY ORB • 0DTE + 1DTE • Trade at your own risk." },
      5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — Locked In on SPY",
        description: "Almost go time. Dual-leg entries (0DTE + 1DTE), 5% total risk per play. Stay present, stay disciplined. 🔥",
        footer: "SPY ORB • 0DTE + 1DTE • Trade at your own risk." },
      1:  { color: 0x00e5a0, content: "@everyone", title: "🚀 60 SECONDS — SPY Is Live",
        description: "This is it. Plan locked, risk defined — 2.5% per leg. Let's go earn it today. 💚",
        footer: "SPY ORB • Options trading carries substantial risk of loss." }
    };
  }
  if (theme === "qqq") {
    return {
      60: { color: 0x00e5a0, content: "@everyone", title: "☀️ Good Morning — QQQ ORB",
        description: "New session, clean book. 🌅\n\n**" + name + "** is dialed in on **QQQ** — 0DTE ATM + 1DTE expected-move legs.\n\n" + sizingBlurb(5) + "\n\nWe trade the plan, not the emotion. Let's make today count. 💪",
        footer: "QQQ ORB • 0DTE + 1DTE • 5% balance/trade • Not financial advice." },
      45: { color: 0x4da6ff, title: "🌤️ 45 Minutes — QQQ Pre-Flight",
        description: "Reviewing **QQQ 0DTE + 1DTE** legs and expected-move levels before the open. 📋",
        footer: "QQQ ORB • 0DTE + 1DTE • Not financial advice." },
      30: { color: 0xf5c518, content: "@everyone", title: "🌅 30 Minutes — Eyes on QQQ",
        description: "Thirty out. Each entry opens **0DTE ATM + 1DTE at the expected-move strike**. Wait for the break, then execute.\n\nCalm hands win. 🧘",
        footer: "QQQ ORB • 0DTE + 1DTE • Trade at your own risk." },
      5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — QQQ Locked In",
        description: "Almost go time. Dual-leg entries (0DTE + 1DTE), 5% total risk per play. Stay present. 🔥",
        footer: "QQQ ORB • 0DTE + 1DTE • Trade at your own risk." },
      1:  { color: 0x00e5a0, content: "@everyone", title: "🚀 60 SECONDS — QQQ Is Live",
        description: "Plan locked, risk defined — 2.5% per leg. Let's work the tape. 💚",
        footer: "QQQ ORB • Options trading carries substantial risk of loss." }
    };
  }
  // default theme (main 50K — SPXW)
  return {
    45: { color: 0x4da6ff, title: "👁️ 45 Minutes to Open — SPX Pre-Market Check",
      description: "Morning rundown incoming. Reviewing SPX 0DTE + 1DTE legs before the bell. 📋",
      footer: "SPXW · 5% risk/trade · Not financial advice." },
    60: { color: 0xf5c518, content: "@everyone", title: "☀️ Good Morning, Traders!",
      description: "Market opens in one hour. **Argus ORB Trader 50K** is tracking **SPXW** off SPY ORB — 0DTE ATM + 1DTE expected-move strikes.\n\n" + sizingBlurb(5) + "\n\nArgus is warmed up and ready. 👁️",
      footer: "SPXW · 5% balance/trade · Not financial advice." },
    30: { color: 0xf5a623, content: "@everyone", title: "🌅 30 Minutes Out",
      description: "Half hour to go. Argus is authenticated, connected, and on standby. All systems green.\n\nTake a breath. Trust the process. Let Argus do its thing. 💚",
      footer: "Not financial advice. Trade at your own risk." },
    5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — Argus Is Locked In",
      description: "We're almost there. Argus is watching every tick.\nWhen the bell rings, it's go time. 👀",
      footer: "Not financial advice. Trade at your own risk." },
    1:  { color: 0xff4d6a, content: "@everyone", title: "🚨 60 SECONDS. ARGUS IS LIVE.",
      description: "This is it. Everything is armed and ready.\nStay focused. Stay disciplined. Let Argus work. 🔥",
      footer: "Not financial advice. Options trading carries substantial risk of loss." }
  };
}

// ── per-channel P&L store (durable) ─────────────────────────────────────────
function loadPnl(file) {
  try { var fs = require("fs"); if (fs.existsSync(file)) { var s = JSON.parse(fs.readFileSync(file, "utf8")); s.byDate = s.byDate || {}; if (typeof s.allTime !== "number") s.allTime = 0; return s; } } catch (e) {}
  return { allTime: 0, byDate: {} };
}

// ── channel factory ─────────────────────────────────────────────────────────
function createChannel(cfg) {
  var pnlFile = persist.filePath("pnl-" + cfg.id + ".json");
  var pnlStore = loadPnl(pnlFile);
  var paperFile = persist.filePath("paper-" + cfg.id + ".json");

  var account = {
    balance: cfg.startBalance + (pnlStore.allTime || 0),
    startingBalance: cfg.startBalance,
    positions: {},
    closedToday: [],
    wins: 0, losses: 0, totalTrades: 0
  };

  function loadPaperState() {
    try {
      var fs = require("fs");
      if (!fs.existsSync(paperFile)) return null;
      return JSON.parse(fs.readFileSync(paperFile, "utf8"));
    } catch (e) { return null; }
  }
  function savePaperState() {
    try {
      require("fs").writeFileSync(paperFile, JSON.stringify({
        date: etISODate(),
        positions: account.positions,
        closedToday: account.closedToday,
        wins: account.wins,
        losses: account.losses,
        totalTrades: account.totalTrades
      }));
    } catch (e) { console.log("[DISCORD] paper save failed: " + e.message); }
  }
  var savedPaper = loadPaperState();
  if (savedPaper && savedPaper.date === etISODate()) {
    account.positions = savedPaper.positions || {};
    account.closedToday = savedPaper.closedToday || [];
    account.wins = savedPaper.wins || 0;
    account.losses = savedPaper.losses || 0;
    account.totalTrades = savedPaper.totalTrades || 0;
    console.log("[DISCORD][" + cfg.id + "] restored " + Object.keys(account.positions).filter(function(k) {
      return account.positions[k] && account.positions[k].contracts > 0;
    }).length + " paper leg(s)");
  }

  function savePnl() { try { require("fs").writeFileSync(pnlFile, JSON.stringify(pnlStore)); } catch (e) { console.log("[DISCORD] pnl save failed: " + e.message); } }
  function realize(amount) {
    var d = etISODate();
    pnlStore.byDate[d] = (pnlStore.byDate[d] || 0) + amount;
    pnlStore.allTime = (pnlStore.allTime || 0) + amount;
    account.balance += amount;
    savePnl();
    savePaperState();
  }

  function footer() { return cfg.name + ": " + formatMoney(account.balance); }
  function acceptsSignal(t) { return (cfg.signalTickers || []).indexOf(t) !== -1; }
  function tradeTickerForSignal(t) { return cfg.tradeTicker || t; }
  function posLabelFromPos(pos) {
    return expiryUtil.contractLabel(pos.tradeTicker, pos.side, pos.strike, pos.expiry)
      + (pos.dteTag === 0 ? " · 0DTE" : " · 1DTE");
  }
  function openLegKeys() {
    return Object.keys(account.positions).filter(function(k) {
      var p = account.positions[k];
      return p && p.contracts > 0;
    });
  }
  function riskPct() { return cfg.riskPct || 5; }
  function legFraction() { return 0.5; }

  async function resolveLegExitPrice(pos, signalTicker, tradeTicker, signalOptionPrice) {
    if (signalTicker === tradeTicker && signalOptionPrice && signalOptionPrice > 0) return signalOptionPrice;
    var m = await fetchOptionMark(pos.tradeTicker, pos.side, pos.strike, pos.expiry);
    if (m && m.price > 0) return m.price;
    return pos.lastKnownPrice || pos.entryPrice || 0;
  }

  async function send(embed, pingEveryone) {
    if (!cfg.webhook) return false;
    var content = pingEveryone ? "@everyone" : null;
    var mentions = pingEveryone ? { parse: ["everyone"] } : { parse: [] };
    try {
      var res = await httpPost(cfg.webhook, { content: content, allowed_mentions: mentions, embeds: [embed] });
      if (!res || res.status < 200 || res.status >= 300) {
        console.log("[DISCORD_ERROR][" + cfg.id + "] HTTP " + (res && res.status) + " " + ((res && res.body) || "").slice(0, 200));
        return false;
      }
      return true;
    } catch (err) {
      console.log("[DISCORD_ERROR][" + cfg.id + "] " + err.message);
      return false;
    }
  }
  async function sendRaw(content, embed, pingEveryone) {
    if (!cfg.webhook) return false;
    var mentions = pingEveryone ? { parse: ["everyone"] } : { parse: [] };
    try {
      var res = await httpPost(cfg.webhook, { content: content, allowed_mentions: mentions, embeds: [embed] });
      if (!res || res.status < 200 || res.status >= 300) {
        console.log("[DISCORD_ERROR][" + cfg.id + "] HTTP " + (res && res.status) + " " + ((res && res.body) || "").slice(0, 200));
        return false;
      }
      return true;
    } catch (err) {
      console.log("[DISCORD_ERROR][" + cfg.id + "] " + err.message);
      return false;
    }
  }

  function recordClose(pos, finalSalePnl, legKey) {
    var totalProfit = (pos.realizedPnl || 0) + finalSalePnl;
    var maxPrice = pos.maxPrice || pos.entryPrice || 0;
    var maxGainPct = pos.entryPrice > 0 ? ((maxPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    account.closedToday.push({
      ticker: pos.tradeTicker + (pos.dteTag === 0 ? " 0DTE" : " 1DTE"),
      side: pos.side, entry: pos.entryPrice, maxPrice: maxPrice,
      maxGainPct: maxGainPct, totalProfit: totalProfit, leg: legKey
    });
    if (totalProfit >= 0) account.wins++; else account.losses++;
    account.totalTrades++;
  }

  async function openLeg(tradeTicker, side, dteTag, orbHigh, orbLow, underlying, moveTargets, optionPriceHint, signalTicker) {
    var sameTicker = !signalTicker || signalTicker === tradeTicker;
    var expiry = expiryUtil.getExpiryForDTE(dteTag);
    var und = await resolveUnderlying(tradeTicker, sameTicker ? underlying : null);
    if (!und) return null;
    var strike = paperLegs.strikeForLegTicker(tradeTicker, side, dteTag, und, moveTargets);
    var m = await fetchOptionMark(tradeTicker, side, strike, expiry);
    var hint = sameTicker && dteTag === 0 ? optionPriceHint : null;
    var price = (hint && hint > 0) ? hint : (m && m.price) || 0;
    var contracts = paperLegs.sizeContracts(account.balance, riskPct(), legFraction(), price);
    if (contracts < 1) {
      console.log("[PAPER][" + cfg.id + "] skip " + tradeTicker + " " + dteTag + "DTE — premium too high for " + (riskPct() * legFraction()) + "% sizing");
      return null;
    }
    var key = paperLegs.legKey(tradeTicker, dteTag);
    var pos = {
      tradeTicker: tradeTicker, side: side, dteTag: dteTag,
      contracts: contracts, totalContracts: contracts,
      entryPrice: price, posValue: price * contracts * 100,
      orbHigh: orbHigh, orbLow: orbLow,
      realizedPnl: 0, lastProfitTier: 0, breakEvenActivated: false, stopPct: null,
      strike: m && m.strike ? m.strike : strike,
      expiry: m && m.expiry ? m.expiry : expiry,
      instrumentUrl: m && m.instrument ? m.instrument : null,
      lastKnownPrice: price, maxPrice: price,
      targetUpper: moveTargets ? moveTargets.upper : null,
      targetLower: moveTargets ? moveTargets.lower : null,
      moveExitDone: false
    };
    account.positions[key] = pos;
    savePaperState();
    return { key: key, pos: pos, label: posLabelFromPos(pos), contracts: contracts, price: price };
  }

  async function sendEntryEmbed(tradeTicker, side, orbHigh, orbLow, opened, signalTicker) {
    var isLong = side === "call";
    var dirLabel = isLong ? "LONG" : "SHORT";
    // Brighter than morning/daily teal so entries pop on Discord mobile dark theme.
    var color = isLong ? 0x57f287 : 0xed4245;
    var display = yahoo.displaySymbol(tradeTicker);
    var stop = (((parseFloat(orbHigh) || 0) + (parseFloat(orbLow) || 0)) / 2).toFixed(2);
    var fields = opened.map(function(o) {
      var tgt = isLong
        ? (o.pos.targetUpper ? "$" + o.pos.targetUpper.toFixed(2) : "—")
        : (o.pos.targetLower ? "$" + o.pos.targetLower.toFixed(2) : "—");
      return {
        name: o.label,
        value: o.contracts + "c @ $" + (o.price > 0 ? o.price.toFixed(2) : "—")
          + "\nRisk: " + (riskPct() * legFraction()).toFixed(2) + "% of " + formatMoney(account.balance)
          + (o.pos.dteTag === 1 ? "\nMove target: " + tgt : ""),
        inline: false
      };
    });
    var sigNote = signalTicker && signalTicker !== tradeTicker
      ? "Signal: **" + signalTicker + "** ORB → **" + display + "**\n" : "";
    var pingLine = isLong
      ? "🟢 **LONG ENTRY — " + display + "**"
      : "🔴 **SHORT ENTRY — " + display + "**";

    await sendRaw("@everyone\n" + pingLine, {
      color: color,
      title: (isLong ? "🟢" : "🔴") + " " + dirLabel + " ENTRY — " + display + " (0DTE + 1DTE)",
      description: sigNote + "Signal at " + etTimeLabel() + " · 5m bar close · **" + riskPct() + "%** total (2.5% per leg)",
      fields: fields.concat([
        { name: "ORB High", value: "$" + (parseFloat(orbHigh) || 0).toFixed(2), inline: true },
        { name: "ORB Low", value: "$" + (parseFloat(orbLow) || 0).toFixed(2), inline: true },
        { name: "Stop (Mid)", value: "$" + stop, inline: true }
      ]),
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function entry(tradeTicker, side, optionPrice, orbHigh, orbLow, underlying, signalTicker, opts) {
    opts = opts || {};
    var force = !!opts.force;
    var existing = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    if (existing.length) {
      var firstPos = account.positions[existing[0]];
      if (firstPos && firstPos.side === side) {
        if (!force) {
          console.log("[PAPER][" + cfg.id + "] entry skipped — " + existing.length + " leg(s) already open for " + tradeTicker);
          return false;
        }
        var replayed = existing.map(function(key) {
          var pos = account.positions[key];
          return {
            key: key,
            pos: pos,
            label: posLabelFromPos(pos),
            contracts: pos.contracts,
            price: pos.entryPrice || pos.lastKnownPrice || 0
          };
        });
        await sendEntryEmbed(tradeTicker, side, orbHigh, orbLow, replayed, signalTicker);
        return true;
      }
      console.log("[PAPER][" + cfg.id + "] flipping " + tradeTicker + " " + firstPos.side + " → " + side);
      await fullClose(signalTicker || tradeTicker, optionPrice || 0);
    }
    var moveTargets = await paperLegs.getEntryMoveTargets(tradeTicker);
    var opened = [];
    var open1DTE = cfg.dualLeg !== false;
    var leg0 = await openLeg(tradeTicker, side, 0, orbHigh, orbLow, underlying, moveTargets, optionPrice, signalTicker);
    if (leg0) opened.push(leg0);
    if (open1DTE) {
      var leg1 = await openLeg(tradeTicker, side, 1, orbHigh, orbLow, underlying, moveTargets, null, signalTicker);
      if (leg1) opened.push(leg1);
    }
    if (!opened.length) {
      console.log("[PAPER][" + cfg.id + "] no legs opened for " + tradeTicker);
      return false;
    }
    await sendEntryEmbed(tradeTicker, side, orbHigh, orbLow, opened, signalTicker);
    return true;
  }

  async function add(tradeTicker, optionPrice, signalTicker) {
    var key = paperLegs.legKey(tradeTicker, 0);
    var pos = account.positions[key];
    if (!pos) return;
    var sameTicker = !signalTicker || signalTicker === tradeTicker;
    if (!sameTicker || !optionPrice || optionPrice <= 0) {
      var m = await fetchOptionMark(tradeTicker, pos.side, pos.strike, pos.expiry);
      optionPrice = m && m.price ? m.price : pos.lastKnownPrice || pos.entryPrice || 0;
    }
    if (pos.retestAdded) return;
    var addQty = paperLegs.sizeContracts(account.balance, riskPct(), legFraction(), optionPrice);
    if (addQty < 1) return;
    pos.contracts += addQty;
    pos.totalContracts += addQty;
    pos.retestAdded = true;
    savePaperState();
    await send({
      color: 0x4da6ff, title: "➕ RETEST ADD — " + posLabelFromPos(pos),
      description: "Retest adds **0DTE leg only** (+2.5% risk)",
      fields: [
        { name: "Added", value: "+" + addQty + "c @ $" + optionPrice.toFixed(2), inline: true },
        { name: "Total", value: String(pos.contracts) + " contracts", inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, false);
  }

  async function breakevenLeg(key) {
    var pos = account.positions[key]; if (!pos) return;
    await send({
      color: 0xf5a623, title: "🟡 BREAKEVEN STOP — " + posLabelFromPos(pos),
      fields: [
        { name: "Stop Level", value: "$" + pos.entryPrice.toFixed(2) + " (entry)", inline: true },
        { name: "Contracts", value: String(pos.contracts), inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function partialExitLeg(key, sellContracts, currentPrice, reason, tierNum) {
    var pos = account.positions[key]; if (!pos || sellContracts <= 0) return;
    if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;
    var tierPnl = sellContracts * (currentPrice - pos.entryPrice) * 100;
    pos.realizedPnl = (pos.realizedPnl || 0) + tierPnl;
    pos.contracts -= sellContracts;
    realize(tierPnl);
    var gainPct = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    var title = tierNum === 3 ? "🎯 EXPECTED MOVE EXIT — " + posLabelFromPos(pos)
      : tierNum === 2 ? "💰💰 RUNNER TRIM — " + posLabelFromPos(pos)
      : "💰 TIER — " + posLabelFromPos(pos);
    await send({
      color: tierNum === 3 ? 0xf5a623 : 0xf5a623, title: title,
      fields: [
        { name: "Sold", value: sellContracts + "c @ $" + currentPrice.toFixed(2), inline: true },
        { name: "Gain", value: formatPct(gainPct), inline: true },
        { name: "P&L Sale", value: formatMoney(tierPnl), inline: true },
        { name: "Remaining", value: String(pos.contracts) + "c", inline: true },
        { name: "Reason", value: reason, inline: false }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, tierNum === 3);
    if (pos.contracts <= 0) {
      recordClose(pos, 0, key);
      account.positions[key] = null;
    }
    savePaperState();
  }

  async function eodSellLeg(key, sellContracts, currentPrice, gainPct) {
    await partialExitLeg(key, sellContracts, currentPrice, "15 min before close", 0);
  }

  async function profitTierLeg(key, tierNum, sellContracts, currentPrice, gainPct) {
    await partialExitLeg(key, sellContracts, currentPrice, "+" + Math.floor(gainPct) + "% scale-out", tierNum);
    if (account.positions[key]) account.positions[key].lastProfitTier = tierNum;
  }

  async function stopLeg(key, currentPrice, reason) {
    var pos = account.positions[key]; if (!pos) return;
    if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;
    var salePnl = pos.contracts * (currentPrice - pos.entryPrice) * 100;
    var pct = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    realize(salePnl);
    recordClose(pos, salePnl, key);
    var totalPnl = salePnl + (pos.realizedPnl || 0);
    var contracts = pos.contracts;
    account.positions[key] = null;
    savePaperState();
    await send({
      color: 0xff4d6a, title: "🔴 STOP — " + posLabelFromPos(pos),
      fields: [
        { name: "Closed", value: contracts + "c @ $" + currentPrice.toFixed(2), inline: true },
        { name: "P&L", value: formatMoney(totalPnl) + " (" + formatPct(pct) + ")", inline: true },
        { name: "Reason", value: reason, inline: false }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function expectedMoveExit(signalTicker, optionPrice, timeframe) {
    var tradeTicker = tradeTickerForSignal(signalTicker);
    var keys = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    for (var i = 0; i < keys.length; i++) {
      var pos = account.positions[keys[i]];
      if (!pos) continue;
      var qty = Math.floor(pos.contracts * 0.9);
      if (qty < 1) continue;
      var price = await resolveLegExitPrice(pos, signalTicker, tradeTicker, optionPrice);
      await partialExitLeg(keys[i], qty, price,
        (timeframe || "daily") + " expected move — 90% exit", 3);
    }
  }

  async function stop(signalTicker, currentPrice, reason) {
    var tradeTicker = tradeTickerForSignal(signalTicker);
    var keys = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    for (var i = 0; i < keys.length; i++) {
      var pos = account.positions[keys[i]];
      if (!pos) continue;
      var price = await resolveLegExitPrice(pos, signalTicker, tradeTicker, currentPrice);
      await stopLeg(keys[i], price, reason);
    }
  }

  async function fullClose(signalTicker, currentPrice) {
    var tradeTicker = tradeTickerForSignal(signalTicker);
    var keys = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    for (var i = 0; i < keys.length; i++) {
      var pos = account.positions[keys[i]];
      if (!pos) continue;
      var price = await resolveLegExitPrice(pos, signalTicker, tradeTicker, currentPrice);
      await stopLeg(keys[i], price, "Position fully closed");
    }
  }

  async function breakeven(ticker) {
    var tradeTicker = tradeTickerForSignal(ticker);
    paperLegs.listLegsForTrade(account.positions, tradeTicker).forEach(function(k) {
      var p = account.positions[k];
      if (p) p.breakEvenActivated = true;
    });
    var keys = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    if (keys.length) await breakevenLeg(keys[0]);
  }

  async function profitTier(ticker, tierNum, sell, price, gain) {
    var tradeTicker = tradeTickerForSignal(ticker);
    var keys = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    for (var i = 0; i < keys.length; i++) {
      var pos = account.positions[keys[i]];
      if (!pos) continue;
      var s10 = Math.max(1, Math.floor(pos.contracts * exitlogic.SCALE_SELL_FRAC));
      await profitTierLeg(keys[i], tierNum, s10, price, gain);
    }
  }

  async function eodSell(ticker, sellContracts, currentPrice, gainPct) {
    var tradeTicker = tradeTickerForSignal(ticker);
    var keys = paperLegs.listLegsForTrade(account.positions, tradeTicker);
    for (var i = 0; i < keys.length; i++) {
      var pos = account.positions[keys[i]];
      if (!pos) continue;
      var qty = Math.max(1, Math.floor(pos.contracts * exitlogic.EOD_SELL_FRAC));
      await eodSellLeg(keys[i], qty, currentPrice, gainPct);
    }
  }

  function unrealized() {
    var sum = 0;
    Object.keys(account.positions).forEach(function(t) {
      var p = account.positions[t];
      if (p && p.contracts > 0) { var cur = p.lastKnownPrice || p.entryPrice; sum += (cur - p.entryPrice) * p.contracts * 100; }
    });
    return sum;
  }

  function pnlWindow() {
    var today = etISODate();
    var month = today.slice(0, 7);
    var weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    var weekAgoISO = weekAgo.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    var daily = pnlStore.byDate[today] || 0, weekly = 0, monthly = 0;
    Object.keys(pnlStore.byDate).forEach(function(d) {
      var v = pnlStore.byDate[d];
      if (d >= weekAgoISO) weekly += v;
      if (d.slice(0, 7) === month) monthly += v;
    });
    return { daily: daily, weekly: weekly, monthly: monthly, allTime: pnlStore.allTime || 0 };
  }

  async function dailySummary(opts) {
    opts = opts || {};
    var trades = opts.trades || account.closedToday;
    var w = pnlWindow();
    var unreal = unrealized();
    var color = w.daily >= 0 ? 0x00e5a0 : 0xff4d6a;
    var emoji = w.daily >= 0 ? "📈" : "📉";
    var dailyPct = account.startingBalance > 0 ? (w.daily / account.startingBalance) * 100 : 0;
    var tradeChunks = chunkTradeLines(trades);
    var dayLabel = w.daily >= 0 ? "GREEN DAY" : "RED DAY";
    var posted = await send({
      color: color,
      title: emoji + " " + dayLabel + " " + formatMoney(w.daily) + " — Daily Summary",
      fields: [
        { name: "Net Profit (Today)", value: formatMoney(w.daily) + " (" + formatPct(dailyPct) + ")", inline: false },
        { name: "Unrealized (Open Positions)", value: formatMoney(unreal), inline: false },
        { name: "Weekly", value: formatMoney(w.weekly), inline: true },
        { name: "Monthly", value: formatMoney(w.monthly), inline: true },
        { name: "All-Time", value: formatMoney(w.allTime), inline: true },
        { name: "Wins / Losses", value: account.wins + " / " + account.losses, inline: true },
        { name: "Account Balance", value: formatMoney(account.balance), inline: true },
        { name: "Closed Trades", value: String(trades.length) + (tradeChunks.length > 1 ? " (split across " + tradeChunks.length + " messages)" : ""), inline: true }
      ],
      footer: { text: cfg.name + " | Starting Balance: " + formatMoney(account.startingBalance) },
      timestamp: new Date().toISOString()
    }, true);

    if (!posted) {
      console.log("[DISCORD][" + cfg.id + "] daily summary post failed — keeping closedToday for retry");
      return false;
    }

    for (var ci = 0; ci < tradeChunks.length; ci++) {
      var partLabel = tradeChunks.length === 1
        ? "Trades (" + trades.length + ")"
        : "Trades " + (ci + 1) + "/" + tradeChunks.length + " (" + trades.length + " total)";
      var partOk = await send({
        color: color,
        title: "📋 " + partLabel,
        description: tradeChunks[ci].slice(0, DISCORD_FIELD_MAX),
        footer: { text: cfg.name + " · Daily trade log" },
        timestamp: new Date().toISOString()
      }, false);
      if (!partOk) {
        console.log("[DISCORD][" + cfg.id + "] daily trade log part " + (ci + 1) + " failed");
        return false;
      }
    }

    try {
      var grokResult = await grokContent.buildAndSaveAsync({
        date: etISODate(),
        channel: cfg,
        trades: trades.slice(),
        wins: account.wins,
        losses: account.losses,
        balance: account.balance,
        startingBalance: account.startingBalance,
        pnl: w,
        unrealized: unreal
      });
      console.log("[GROK][" + cfg.id + "] TikTok package → " + grokResult.paths.jsonPath);
    } catch (grokErr) {
      console.log("[GROK][" + cfg.id + "] package save failed: " + grokErr.message);
    }

    if (!opts.preserveTrades) account.closedToday = [];
    return true;
  }

  async function closeDigest() {
    var digest = await closeDigestUtil.buildDigest(cfg);
    var plan = digest.plan;

    var primaryFields = digest.primary.map(function(b) {
      var lines = [];
      if (b.snap) lines.push(technicalsUtil.formatCompact(b.snap));
      if (b.moves) {
        var mv = closeDigestUtil.formatMovesBlock(b.moves, false);
        if (mv) lines.push(mv);
      }
      return {
        name: b.ticker + (cfg.tickers.indexOf(b.ticker) >= 0 ? " · ORB" : ""),
        value: lines.join("\n\n") || "—",
        inline: false
      };
    }).filter(function(f) { return f.value !== "—"; });

    if (primaryFields.length) {
      await send({
        color: 0x4da6ff,
        title: "📊 Close Digest — " + plan.label,
        description: plan.note + "\n\nClose · **21 EMA** · **55 SMA** · implied moves (when scheduled).",
        fields: primaryFields,
        footer: { text: cfg.name + " · " + etTimeLabel() + " · Not financial advice" },
        timestamp: new Date().toISOString()
      }, false);
    }

    if (digest.watchlist.length) {
      var lines = digest.watchlist.map(technicalsUtil.formatOneLine);
      var chunks = [];
      var chunk = "";
      lines.forEach(function(line) {
        if ((chunk + line + "\n").length > 950) { chunks.push(chunk); chunk = ""; }
        chunk += line + "\n";
      });
      if (chunk) chunks.push(chunk);
      var wlFields = chunks.map(function(c, i) {
        return {
          name: i === 0 ? "Market scan" + (plan.fullWatchlist ? " (full)" : " (notable)") : "…",
          value: c.trim(),
          inline: false
        };
      });
      await send({
        color: 0x5865f2,
        title: "🔍 Watchlist — " + plan.label,
        description: plan.notableWatchlistOnly
          ? "Only names with a big move, EMA cross, or price near 21 EMA / 55 SMA today."
          : "Full daily scan of the Argus 50K watchlist.",
        fields: wlFields,
        footer: { text: cfg.name + " · Not financial advice" },
        timestamp: new Date().toISOString()
      }, false);
    }

    if (digest.watchlistMoves.length) {
      var mvFields = digest.watchlistMoves.map(function(w) {
        return {
          name: yahoo.displaySymbol(w.ticker) + " expected moves",
          value: closeDigestUtil.formatMovesBlock(w.moves, true) || "—",
          inline: true
        };
      });
      await send({
        color: 0xf5a623,
        title: "📐 Watchlist Expected Moves",
        description: "Friday / month-end / quarter-end: calendar week, month, and quarter implied ranges.",
        fields: mvFields.slice(0, 24),
        footer: { text: cfg.name + " · Not financial advice" },
        timestamp: new Date().toISOString()
      }, false);
    }

    console.log("[DISCORD][" + cfg.id + "] close digest posted (" + plan.label + ")");
  }

  async function orbSet(ticker, high, low, mid, source) {
    var display = yahoo.displaySymbol(cfg.tradeTicker || ticker);
    var h = parseFloat(high) || 0;
    var l = parseFloat(low) || 0;
    var m = mid != null ? parseFloat(mid) : (h + l) / 2;
    var srcLabel = formatOrbSource(source);
    await send({
      color: 0x4da6ff,
      title: "📐 ORB SET — " + display,
      description: "**" + display + "** · opening range locked · " + etTimeLabel(),
      fields: [
        { name: "ORB High", value: "$" + h.toFixed(2), inline: true },
        { name: "ORB Low", value: "$" + l.toFixed(2), inline: true },
        { name: "Mid (Stop)", value: "$" + m.toFixed(2), inline: true },
        { name: "Source", value: srcLabel, inline: true },
        { name: "Plan", value: "Watching for **5m bar close** breakout · 0DTE ATM + 1DTE expected-move legs", inline: false }
      ],
      footer: { text: footer() + " · Not financial advice" },
      timestamp: new Date().toISOString()
    }, true);
  }

  async function sundayPremarket() {
    var tickers = closeDigestUtil.sundayTickersForChannel(cfg);
    var data = await closeDigestUtil.buildSundayPremarket(tickers);
    var fields = data.blocks.map(function(b) {
      return {
        name: closeDigestUtil.formatSundayHeader(b),
        value: closeDigestUtil.formatSundayBlock(b) + "\n\u200b",
        inline: false
      };
    }).filter(function(f) { return f.value.replace("\n\u200b", "") !== "—"; });

    if (!fields.length) {
      console.log("[DISCORD][" + cfg.id + "] Sunday premarket skipped — no data");
      return;
    }

    var fullWatchlist = cfg.id === "main";
    var title = fullWatchlist
      ? "🌙 Sunday Premarket — Full Watchlist"
      : "🌙 Sunday Premarket — " + yahoo.displaySymbol(tickers[0] || cfg.tradeTicker || "ORB");
    await send({
      color: 0x00e5a0,
      title: title,
      description: "Friday close · **21 EMA** · **55 SMA** · **Monday** expected move · **this week** expected move.\n\nNext session: **" + data.sessionLabel + "**",
      fields: fields,
      footer: { text: cfg.name + " · " + etTimeLabel() + " · Not financial advice" },
      timestamp: new Date().toISOString()
    }, true);

    console.log("[DISCORD][" + cfg.id + "] Sunday premarket posted (" + fields.length + " symbols)");
  }

  async function expectedMoves() {
    return closeDigest();
  }

  async function openPositions(label) {
    var keys = openLegKeys();
    if (!keys.length) return;
    var fields = keys.map(function(key) {
      var pos = account.positions[key];
      var cur = pos.lastKnownPrice || pos.entryPrice;
      var pending = cur <= 0;
      if (pending) cur = 0;
      var pnl = (cur - pos.entryPrice) * pos.contracts * 100;
      var pct = pos.entryPrice > 0 ? ((cur - pos.entryPrice) / pos.entryPrice * 100).toFixed(1) : "0.0";
      var pnlStr = pending ? "⚠️ Price feed delayed" : (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      var tgt = pos.side === "call" && pos.targetUpper ? "Move ▲ $" + pos.targetUpper.toFixed(2)
        : pos.side === "put" && pos.targetLower ? "Move ▼ $" + pos.targetLower.toFixed(2) : "";
      return {
        name: posLabelFromPos(pos),
        value: "Entry: $" + pos.entryPrice.toFixed(2) + "\nCurrent: $" + (pending ? "—" : cur.toFixed(2))
          + "\nP&L: " + pnlStr + (pending ? "" : " (" + (pnl >= 0 ? "+" : "") + pct + "%)")
          + "\nContracts: " + pos.contracts
          + (tgt ? "\n" + tgt : ""),
        inline: true
      };
    });
    await send({
      color: 0x4da6ff,
      title: "📊 " + cfg.name + " · " + label + " Update",
      description: sizingBlurb(riskPct()),
      fields: fields,
      footer: { text: footer() },
      timestamp: new Date().toISOString()
    }, false);
  }

  async function morning(minutesBefore) {
    var msg = morningMessages(cfg.theme, cfg.name)[minutesBefore];
    if (!msg || !cfg.webhook) return;
    var ping = !!msg.content;
    await sendRaw(msg.content || null, { color: msg.color, title: msg.title, description: msg.description, footer: { text: msg.footer }, timestamp: new Date().toISOString() }, ping);
    if (minutesBefore === 45) await openPositions("Pre-Market 45 Min");
  }

  async function fetchLegOptionPrice(pos, rhAvailable) {
    if (!pos.strike) {
      var und = await resolveUnderlying(pos.tradeTicker, null);
      if (und) pos.strike = paperLegs.roundStrike(pos.tradeTicker, und);
    }
    if (pos.strike && !pos.instrumentUrl) {
      var resolved = await fetchOptionMark(pos.tradeTicker, pos.side, pos.strike, pos.expiry);
      if (resolved) {
        if (resolved.instrument) pos.instrumentUrl = resolved.instrument;
        if (resolved.expiry) pos.expiry = resolved.expiry;
        if (resolved.strike) pos.strike = resolved.strike;
      }
    }
    var price = null;
    if (rhAvailable) {
      try {
        if (pos.instrumentUrl) price = await rh.getOptionMarkByUrl(pos.instrumentUrl);
        if ((!price || price <= 0) && pos.strike) {
          var m = await fetchOptionMark(pos.tradeTicker, pos.side, pos.strike, pos.expiry);
          if (m) {
            price = m.price;
            if (m.instrument && !pos.instrumentUrl) pos.instrumentUrl = m.instrument;
          }
        }
      } catch (e) { console.log("[PAPER_ENGINE][" + cfg.id + "] mark: " + e.message); }
    } else if (pos.strike) {
      var ym = await fetchOptionMark(pos.tradeTicker, pos.side, pos.strike, pos.expiry);
      if (ym) price = ym.price;
    }
    return price;
  }

  async function pollMoveTargets() {
    var keys = openLegKeys();
    if (!keys.length) return;
    var tradeTickers = {};
    keys.forEach(function(k) {
      var p = account.positions[k];
      if (p) tradeTickers[p.tradeTicker] = true;
    });
    var tickerList = Object.keys(tradeTickers);
    for (var t = 0; t < tickerList.length; t++) {
      var tt = tickerList[t];
      var hot = keys.some(function(k) {
        var p = account.positions[k];
        return p && p.tradeTicker === tt && !p.moveExitDone && paperLegs.isNearMoveTarget(p, underlyingSnaps[tt] && underlyingSnaps[tt].price);
      });
      var maxAge = hot ? paperLegs.MONITOR_INTERVAL_MS : paperLegs.MARK_INTERVAL_MS;
      var snap = await getUnderlyingSnap(tt, maxAge);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var pos = account.positions[key];
        if (!pos || pos.tradeTicker !== tt || pos.moveExitDone) continue;
        var hit = paperLegs.checkMoveTouch(pos, snap);
        if (!hit) continue;
        var rhAvailable = !!rh.getToken();
        var optPrice = await fetchLegOptionPrice(pos, rhAvailable);
        if (!optPrice || optPrice <= 0) optPrice = pos.lastKnownPrice || pos.entryPrice || 0;
        var frac = paperLegs.exitFractionForLeg(pos.dteTag);
        var qty = paperLegs.sellQtyForLeg(pos, frac);
        var sideLabel = hit === "upper" ? "upper" : "lower";
        await partialExitLeg(key, qty, optPrice,
          "Expected move " + sideLabel + " touch (underlying $" + (snap.price || 0).toFixed(2) + ")", 3);
        if (account.positions[key]) {
          account.positions[key].moveExitDone = true;
          savePaperState();
        }
        console.log("[PAPER][" + cfg.id + "] move exit " + key + " " + sideLabel + " qty=" + qty);
      }
    }
  }

  async function pollOptionMarks(rhAvailable) {
    var keys = openLegKeys();
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var pos = account.positions[key];
      if (!pos) continue;
      var price = await fetchLegOptionPrice(pos, rhAvailable);
      if (!price || price <= 0) continue;
      if (!pos.entryPrice || pos.entryPrice <= 0) {
        pos.entryPrice = price;
        pos.posValue = price * pos.contracts * 100;
        pos.lastKnownPrice = price;
        pos.maxPrice = price;
        continue;
      }
      pos.lastKnownPrice = price;
      if (!pos.maxPrice || price > pos.maxPrice) pos.maxPrice = price;

      var decision = exitlogic.evaluate(pos, price);
      pos.stopPct = decision.newStopPct;

      if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
        pos.eodSold = exitlogic.etDateKey();
        var eodQty = Math.max(1, Math.floor(pos.contracts * exitlogic.EOD_SELL_FRAC));
        await eodSellLeg(key, eodQty, price, decision.gain);
        continue;
      }
      if (decision.activateBreakeven && !pos.breakEvenActivated) {
        pos.breakEvenActivated = true;
        await breakevenLeg(key);
      }
      if (decision.stopOut) {
        var reason = pos.breakEvenActivated ? "Trailing Stop " + decision.newStopPct + "%" : "Initial Stop -15%";
        await stopLeg(key, price, reason);
        continue;
      }
      if (decision.scaleOut) {
        var s10 = Math.max(1, Math.floor(pos.contracts * decision.sellFraction));
        await profitTierLeg(key, 1, s10, price, decision.gain);
        if (account.positions[key]) account.positions[key].lastProfitTier = decision.newTier;
        savePaperState();
      }
    }
    savePaperState();
  }

  return {
    cfg: cfg, account: account,
    acceptsSignal: acceptsSignal,
    tradeTickerForSignal: tradeTickerForSignal,
    trades: acceptsSignal,
    entry: entry, add: add, stop: stop, fullClose: fullClose,
    breakeven: breakeven, profitTier: profitTier, eodSell: eodSell,
    expectedMoveExit: expectedMoveExit,
    openPositions: openPositions, dailySummary: dailySummary, morning: morning,
    closeDigest: closeDigest, sundayPremarket: sundayPremarket, expectedMoves: expectedMoves,
    orbSet: orbSet,
    pollMoveTargets: pollMoveTargets, pollOptionMarks: pollOptionMarks,
    getAccount: function() { return account; },
    grokSnapshot: function() {
      return {
        date: etISODate(),
        channel: cfg,
        trades: account.closedToday.slice(),
        wins: account.wins,
        losses: account.losses,
        balance: account.balance,
        startingBalance: account.startingBalance,
        pnl: pnlWindow(),
        unrealized: unrealized()
      };
    }
  };
}

// ── channel registry + fan-out ──────────────────────────────────────────────
var channels = [];

function buildChannelConfigs() {
  var watchlist = closeDigestUtil.MAIN_WATCHLIST;
  var list = [];
  if (process.env.DISCORD_WEBHOOK_URL)
    list.push({
      id: "main", name: "Argus ORB Trader 50K", webhook: process.env.DISCORD_WEBHOOK_URL,
      startBalance: 50000, riskPct: 5, dualLeg: true, signalTickers: ["SPY"], tradeTicker: "SPXW",
      tickers: ["SPXW"], watchlist: watchlist, updateMins: 15, theme: "default"
    });
  if (process.env.DISCORD_WEBHOOK_FREE)
    list.push({
      id: "free", name: "Free Alerts", webhook: process.env.DISCORD_WEBHOOK_FREE,
      startBalance: 10000, riskPct: 5, dualLeg: true, signalTickers: ["IWM"], tradeTicker: "IWM",
      tickers: ["IWM"], watchlist: ["IWM"], updateMins: 30, theme: "free"
    });
  if (process.env.DISCORD_WEBHOOK_SPY0DTE)
    list.push({
      id: "spy0dte", name: "SPY ORB Trader", webhook: process.env.DISCORD_WEBHOOK_SPY0DTE,
      startBalance: 10000, riskPct: 5, dualLeg: true, signalTickers: ["SPY"], tradeTicker: "SPY",
      tickers: ["SPY"], watchlist: ["SPY"], updateMins: 30, theme: "spy"
    });
  if (process.env.DISCORD_WEBHOOK_QQQ)
    list.push({
      id: "qqq", name: "QQQ ORB Trader", webhook: process.env.DISCORD_WEBHOOK_QQQ,
      startBalance: 10000, riskPct: 5, dualLeg: true, signalTickers: ["QQQ"], tradeTicker: "QQQ",
      tickers: ["QQQ"], watchlist: ["QQQ"], updateMins: 30, theme: "qqq"
    });
  return list;
}

function forSignal(ticker, fn, channelIds) {
  return Promise.all(channels.filter(function(c) {
    if (!c.acceptsSignal(ticker)) return false;
    if (channelIds && channelIds.length && channelIds.indexOf(c.cfg.id) === -1) return false;
    return true;
  }).map(fn));
}

async function onEntry(ticker, side, optionPrice, orbHigh, orbLow, underlying, opts) {
  var channelIds = opts && opts.channelIds ? opts.channelIds : null;
  var results = await forSignal(ticker, function(c) {
    var trade = c.tradeTickerForSignal(ticker);
    return c.entry(trade, side, optionPrice, orbHigh, orbLow, underlying, ticker, opts);
  }, channelIds);
  return (results || []).some(Boolean);
}
async function onAdd(ticker, optionPrice) {
  await forSignal(ticker, function(c) {
    return c.add(c.tradeTickerForSignal(ticker), optionPrice, ticker);
  });
}
async function onExpectedMoveExit(ticker, optionPrice, timeframe) {
  await forSignal(ticker, function(c) {
    return c.expectedMoveExit(ticker, optionPrice, timeframe);
  });
}
async function onStop(ticker, optionPrice, reason) {
  await forSignal(ticker, function(c) { return c.stop(ticker, optionPrice, reason); });
}
async function onFullClose(ticker, optionPrice) {
  await forSignal(ticker, function(c) { return c.fullClose(ticker, optionPrice); });
}

var _orbPosted = {};
var ORB_POSTED_FILE = persist.filePath("discord-orb-posted.json");

function loadOrbPosted() {
  try {
    var fs = require("fs");
    if (fs.existsSync(ORB_POSTED_FILE)) {
      var d = JSON.parse(fs.readFileSync(ORB_POSTED_FILE, "utf8"));
      if (d && typeof d === "object") _orbPosted = d;
    }
  } catch (e) {}
}

function saveOrbPosted() {
  try {
    require("fs").writeFileSync(ORB_POSTED_FILE, JSON.stringify(_orbPosted));
  } catch (e) {
    console.log("[DISCORD] orb-posted save failed: " + e.message);
  }
}

function orbFingerprint(high, low) {
  return etISODate() + "|" + (parseFloat(high) || 0).toFixed(2) + "|" + (parseFloat(low) || 0).toFixed(2);
}

function forOrbAnnounce(ticker, fn) {
  return Promise.all(channels.filter(function(c) {
    var trade = c.cfg.tradeTicker || (c.cfg.signalTickers && c.cfg.signalTickers[0]);
    // Main SPXW channel announces SPX Yahoo ORB only — never SPY levels as "SPX"
    if (trade === "SPXW" || trade === "SPX") {
      return ticker === "SPX" || ticker === "SPXW";
    }
    return c.acceptsSignal(ticker);
  }).map(fn));
}

async function onOrbSet(ticker, high, low, mid, source, opts) {
  opts = opts || {};
  if (!(parseFloat(high) > 0) || !(parseFloat(low) > 0)) return false;
  loadOrbPosted();
  var fp = orbFingerprint(high, low);
  var key = ticker === "SPXW" ? "SPX" : ticker;
  if (!opts.force && _orbPosted[key] === fp) return false;
  _orbPosted[key] = fp;
  saveOrbPosted();
  await forOrbAnnounce(key, function(c) {
    return c.orbSet(key, high, low, mid, source);
  });
  return true;
}

async function postExistingOrbs(force) {
  var stateModule = require("./state");
  var orbUtil = require("./orb");
  try { await orbUtil.ensureOrbForTicker("SPX"); } catch (e) {}
  try { await orbUtil.ensureOrbForTicker("QQQ"); } catch (e) {}
  var s = stateModule.getState();
  var tickers = ["SPY", "IWM", "QQQ", "SPX"];
  var posted = [];
  for (var i = 0; i < tickers.length; i++) {
    var t = tickers[i];
    var orb = s.orb && s.orb[t];
    if (!orb || !orb.set || !(orb.high > 0) || !(orb.low > 0)) continue;
    var ok = await onOrbSet(t, orb.high, orb.low, orb.mid, orb.source || "yahoo", { force: !!force });
    if (ok) posted.push(t);
  }
  return posted;
}

// ── schedulers ──────────────────────────────────────────────────────────────
function scheduleMorning(channel) {
  var marketOpenMin = 9 * 60 + 30;
  var alerts = [
    { minutesBefore: 60, m: 60 },
    { minutesBefore: 45, m: 45 },
    { minutesBefore: 30, m: 30 },
    { minutesBefore: 5, m: 5 },
    { minutesBefore: 1, m: 1 }
  ];
  alerts.forEach(function(a) {
    var fireMin = marketOpenMin - a.minutesBefore;
    var hour = Math.floor(fireMin / 60);
    var min = fireMin % 60;
    (function next() {
      setTimeout(async function() {
        if (exitlogic.isTradingDayET()) await channel.morning(a.m);
        next();
      }, exitlogic.msUntilNextTradingTimeET(hour, min));
    })();
  });
}

function scheduleUpdates(channel) {
  var stepMins = channel.cfg.updateMins;
  function msUntilNext() { return exitlogic.msUntilNextETInterval(stepMins); }
  (function next() {
    setTimeout(async function() { if (paperMarketHours()) await channel.openPositions(channel.cfg.updateMins + "-Min Update"); next(); }, msUntilNext());
  })();
  console.log("[DISCORD] " + channel.cfg.id + " position updates every " + channel.cfg.updateMins + " min (ET)");
}

function scheduleDaily(channel) {
  (function next() {
    setTimeout(async function() {
      try {
        if (exitlogic.isTradingDayET()) await channel.dailySummary();
      } catch (e) {
        console.log("[DISCORD][" + channel.cfg.id + "] daily summary error: " + e.message);
      }
      next();
    }, exitlogic.msUntilNextTradingTimeET(16, 0));
  })();
}

function scheduleSundayPremarket(channel) {
  (function next() {
    setTimeout(async function() {
      var wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
      if (wd === "Sun") {
        try { await channel.sundayPremarket(); }
        catch (e) { console.log("[DISCORD][" + channel.cfg.id + "] Sunday premarket error: " + e.message); }
      }
      next();
    }, exitlogic.msUntilNextWeekdayTimeET(18, 0, "Sun"));
  })();
  console.log("[DISCORD] " + channel.cfg.id + " Sunday premarket at 6:00 PM ET");
}

function scheduleCloseDigest(channel) {
  (function next() {
    setTimeout(async function() {
      if (exitlogic.isTradingDayET()) {
        try { await channel.closeDigest(); }
        catch (e) { console.log("[DISCORD][" + channel.cfg.id + "] close digest error: " + e.message); }
      }
      next();
    }, exitlogic.msUntilNextTradingTimeET(16, 5));
  })();
  console.log("[DISCORD] " + channel.cfg.id + " close digest at 4:05 PM ET on trading days");
}

function initChannels(getToken) {
  channels = buildChannelConfigs().map(createChannel);
  if (channels.length === 0) { console.log("[DISCORD] no channels active (set DISCORD_WEBHOOK_URL / _FREE / _SPY0DTE / _QQQ)"); return; }
  console.log("[DISCORD] active channels: " + channels.map(function(c) {
    return c.cfg.id + "(" + (c.cfg.tradeTicker || c.cfg.signalTickers.join("+")) + "," + (c.cfg.riskPct || 5) + "%,"
      + (c.cfg.dualLeg !== false ? "0+1DTE" : "0DTE") + ")";
  }).join(", "));
  channels.forEach(function(c) { scheduleMorning(c); scheduleUpdates(c); scheduleDaily(c); scheduleCloseDigest(c); scheduleSundayPremarket(c); });

  // Do not auto-repost ORBs on every redeploy. New ORBs announce when Yahoo/TV sets them.
  // Use GET /api/discord/orb?force=1 only when you intentionally want a re-post.

  var moveBusy = false;
  var markBusy = false;
  setInterval(async function() {
    if (moveBusy) return;
    moveBusy = true;
    try {
      if (!paperMarketHours()) return;
      for (var i = 0; i < channels.length; i++) await channels[i].pollMoveTargets();
    } catch (e) { console.log("[PAPER_MOVE_ERROR] " + e.message); }
    finally { moveBusy = false; }
  }, paperLegs.MONITOR_INTERVAL_MS);

  setInterval(async function() {
    if (markBusy) return;
    markBusy = true;
    try {
      if (!paperMarketHours()) return;
      var rhAvailable = !!(getToken && getToken());
      if (!rhAvailable) {
        try { await rh.reauthorize(); rhAvailable = !!(getToken && getToken()); } catch (e) {}
      }
      for (var i = 0; i < channels.length; i++) await channels[i].pollOptionMarks(rhAvailable);
    } catch (e) { console.log("[PAPER_ENGINE_ERROR] " + e.message); }
    finally { markBusy = false; }
  }, paperLegs.MARK_INTERVAL_MS);
  console.log("[DISCORD] paper engine — move monitor " + (paperLegs.MONITOR_INTERVAL_MS / 1000) + "s · marks " + (paperLegs.MARK_INTERVAL_MS / 1000) + "s");
}

// ── compat shims for /test/discord routes (target the first active channel) ──
function first() {
  return channels[0] || createChannel({
    id: "main", name: "Argus ORB Trader 50K", webhook: process.env.DISCORD_WEBHOOK_URL,
    startBalance: 50000, riskPct: 5, dualLeg: true, signalTickers: ["SPY"], tradeTicker: "SPXW",
    tickers: ["SPXW"], watchlist: closeDigestUtil.MAIN_WATCHLIST, updateMins: 15, theme: "default"
  });
}

function resolveChannelTargets(channelSpec) {
  var chans = channels.length ? channels : [first()];
  if (!channelSpec || channelSpec === "all") return chans;
  if (channelSpec === "bc") return chans.filter(function(c) { return c.cfg.id === "free" || c.cfg.id === "spy0dte"; });
  var ids = String(channelSpec).split(",").map(function(s) { return s.trim(); }).filter(Boolean);
  return chans.filter(function(c) { return ids.indexOf(c.cfg.id) >= 0; });
}

async function postDailySummaryForChannels(channelSpec, opts) {
  opts = opts || {};
  var grokContent = require("./grokContent");
  var list = resolveChannelTargets(channelSpec);
  var results = [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    var trades = null;
    if (opts.restoreFromGrok) {
      var pkg = grokContent.loadPackage(opts.date || etISODate(), c.cfg.id);
      if (pkg && pkg.trades && pkg.trades.length) {
        trades = pkg.trades.map(function(t) {
          return {
            ticker: t.ticker,
            side: t.side,
            entry: t.entry,
            maxPrice: t.maxPrice,
            maxGainPct: t.maxGainPct,
            totalProfit: t.totalProfit,
            leg: t.leg || null
          };
        });
      }
    }
    var ok = await c.dailySummary({ trades: trades, preserveTrades: true });
    results.push({ channel: c.cfg.id, posted: !!ok, trades: trades ? trades.length : null });
  }
  return results;
}

module.exports = {
  initChannels: initChannels,
  onEntry: onEntry, onAdd: onAdd, onStop: onStop, onFullClose: onFullClose,
  onExpectedMoveExit: onExpectedMoveExit,
  onOrbSet: onOrbSet,
  postExistingOrbs: postExistingOrbs,
  getChannels: function() { return channels; },
  formatTradeLines: formatTradeLines,
  chunkTradeLines: chunkTradeLines,
  postDailySummaryForChannels: postDailySummaryForChannels,
  // test-route compatibility
  postGoodMorning: function(m) { return first().morning(m); },
  postDailySummary: function() { return first().dailySummary(); },
  postExpectedMoves: function() { return first().closeDigest(); },
  postCloseDigest: function() { return first().closeDigest(); },
  postSundayPremarket: function(channelSpec) {
    var list = resolveChannelTargets(channelSpec);
    return Promise.all(list.map(function(c) { return c.sundayPremarket(); })).then(function() {
      return list.map(function(c) { return c.cfg.id; });
    });
  },
  postOpenPositions: function(l) { return first().openPositions(l); },
  postEntry: function(ticker, side, optPrice, orbHigh, orbLow, underlying) {
    var c = first();
    return c.entry(c.tradeTickerForSignal(ticker), side, optPrice, orbHigh, orbLow, underlying, ticker);
  },
  postStopLoss: function(ticker, price, reason) { return first().stop(ticker, price, reason); },
  postProfitTier: function(ticker, tierNum, sell, price, gain) { return first().profitTier(ticker, tierNum, sell, price, gain); }
};
