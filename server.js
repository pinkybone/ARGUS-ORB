const express = require("express");
const path = require("path");
const https = require("https");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize, getTradeSizingFromTotal } = require("./utils/state");
const { ensureLoggedIn, submitSmsCode, getPendingWorkflow, scheduleDailyReauth, scheduleProactiveRefresh, getAuthInfo } = require("./utils/reauth");
const rh = require("./utils/robinhood");
const discord = require("./utils/discord");
const profitManager = require("./utils/profitmanager");
const orbUtil = require("./utils/orb");
const settings = require("./utils/settings");
const yahoo = require("./utils/yahoo");
const pnlUtil = require("./utils/pnl");
const authguard = require("./utils/authguard");
const persist = require("./utils/persist");
const reconcile = require("./utils/reconcile");
const expiryUtil = require("./utils/expiry");
const webhookQueue = require("./utils/webhookQueue");
const killswitch = require("./utils/killswitch");
const grokContent = require("./utils/grokContent");
const qqqYahooSignals = require("./utils/qqqYahooSignals");

process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED_REJECTION]", err && err.message ? err.message : err);
});

app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "manifest.json"));
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "dashboard", "sw.js"));
});
app.get("/icon.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "icon.svg"));
});

app.get("/health", async (req, res) => {
  var auth = await getAuthInfo();
  var s = getState();
  var lastAuthErr = (s.log || []).find(function(e) { return e.type === "AUTH_ERROR"; });
  res.json({
    status: "running",
    time: new Date().toISOString(),
    auth: auth.status,
    verified: auth.verified,
    pending_verification: auth.pending,
    durable: persist.isDurable(),
    trading_enabled: settings.isTradingEnabled(),
    dual_leg_live: settings.isDualLegLive(),
    cross_entry_enabled: settings.isCrossEntryEnabled(),
    webhook_queue: webhookQueue.summary().counts,
    token_expires_at: rh.getAccessTokenExpiryMs() ? new Date(rh.getAccessTokenExpiryMs()).toISOString() : null,
    webhook_url: ((req.get("x-forwarded-proto") || req.protocol) + "://" + req.get("host") + "/webhook"),
    auth_hint: lastAuthErr ? lastAuthErr.message : null
  });
});

app.get("/api/buying-power", authguard.requireSecret, async (req, res) => {
  try {
    var bp = null;
    var token = rh.getToken();
    var acct = process.env.RH_ACCOUNT_NUMBER;
    if (token && acct) {
      var status = await rh.checkAuthStatus();
      if (status.ok) {
        var body = await new Promise(function(resolve) {
          var opts = {
            hostname: "api.robinhood.com",
            path: "/accounts/" + acct + "/",
            headers: {
              "Authorization": "Bearer " + token,
              "Accept": "application/json",
              "X-Robinhood-API-Version": "1.431.4",
              "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
            }
          };
          var req3 = https.request(opts, (r) => {
            var raw = ""; r.on("data", c => raw += c);
            r.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } });
          });
          req3.on("error", () => resolve({})); req3.end();
        });
        bp = body.buying_power || body.cash || null;
      }
    }
    res.json({ buying_power: bp });
  } catch (e) {
    console.log("[BUYING_POWER_ERROR]", e.message);
    res.json({ buying_power: null });
  }
});

app.get("/api/state", authguard.requireSecret, async (req, res) => {
  var s = getState();
  s.auth = await getAuthInfo();
  s.dte = settings.getAll().dte;
  s.tradeConfig = buildTradeConfigPreview(
    s.contracts.SPY, s.contracts.IWM, settings.getDTE("SPY"), settings.getDTE("IWM")
  );
  s.webhook_secret_required = !!authguard.getSecret();
  s.durable = persist.isDurable();
  s.trading_enabled = settings.isTradingEnabled();
  s.dual_leg_live = settings.isDualLegLive();
  s.cross_entry_enabled = settings.isCrossEntryEnabled();
  s.webhook_queue = webhookQueue.summary();
  res.json(s);
});

app.post("/api/settings/flags", authguard.requireSecret, (req, res) => {
  try {
    var body = req.body || {};
    if (body.dual_leg_live !== undefined) settings.setDualLegLive(!!body.dual_leg_live);
    if (body.cross_entry_enabled !== undefined) settings.setCrossEntryEnabled(!!body.cross_entry_enabled);
    res.json({
      ok: true,
      dual_leg_live: settings.isDualLegLive(),
      cross_entry_enabled: settings.isCrossEntryEnabled(),
      durable: settings.getAll().durable
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/settings/dte", authguard.requireSecret, (req, res) => {
  try {
    const { spy, iwm } = req.body || {};
    if (spy !== undefined) settings.setDTE("SPY", spy);
    if (iwm !== undefined) settings.setDTE("IWM", iwm);
    res.json({ ok: true, dte: settings.getAll().dte, durable: settings.getAll().durable });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function buildTradeConfigPreview(spyContracts, iwmContracts, spyDte, iwmDte) {
  function pack(ticker, contracts, dte) {
    var sizing = getTradeSizingFromTotal(contracts);
    var info = expiryUtil.getExpiryInfo(ticker);
    if (typeof dte === "number") {
      info = {
        ticker: ticker,
        dte: dte,
        expiry: expiryUtil.getExpiryForDTE(dte),
        label: dte + "DTE",
        formatted: expiryUtil.formatExpiryLabel(expiryUtil.getExpiryForDTE(dte)),
        weekday: new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" })
          .format(expiryUtil.getExpiryDateForDTE(dte))
      };
    }
    return {
      contracts: sizing.total,
      sizing: sizing,
      expiry: info
    };
  }
  return {
    SPY: pack("SPY", spyContracts, typeof spyDte === "number" ? spyDte : undefined),
    IWM: pack("IWM", iwmContracts, typeof iwmDte === "number" ? iwmDte : undefined),
    dailyIncrement: process.env.ORB_DAILY_INCREMENT !== "0",
    durable: persist.isDurable()
  };
}

app.get("/api/trade-config", authguard.requireSecret, (req, res) => {
  var s = getState();
  res.json(buildTradeConfigPreview(s.contracts.SPY, s.contracts.IWM, settings.getDTE("SPY"), settings.getDTE("IWM")));
});

app.post("/api/trade-config", authguard.requireSecret, (req, res) => {
  try {
    var body = req.body || {};
    var spy = body.SPY || body.spy || {};
    var iwm = body.IWM || body.iwm || {};
    if (spy.contracts !== undefined || iwm.contracts !== undefined) {
      setContractSize(
        spy.contracts !== undefined ? spy.contracts : getState().contracts.SPY,
        iwm.contracts !== undefined ? iwm.contracts : getState().contracts.IWM
      );
    }
    if (spy.dte !== undefined) settings.setDTE("SPY", spy.dte);
    if (iwm.dte !== undefined) settings.setDTE("IWM", iwm.dte);
    var s = getState();
    var cfg = buildTradeConfigPreview(s.contracts.SPY, s.contracts.IWM, settings.getDTE("SPY"), settings.getDTE("IWM"));
    res.json({ ok: true, config: cfg, contracts: s.contracts, dte: settings.getAll().dte });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/trade-config/preview", authguard.requireSecret, (req, res) => {
  var spyC = req.query.spy_contracts || getState().contracts.SPY;
  var iwmC = req.query.iwm_contracts || getState().contracts.IWM;
  var spyD = req.query.spy_dte !== undefined ? parseInt(req.query.spy_dte, 10) : settings.getDTE("SPY");
  var iwmD = req.query.iwm_dte !== undefined ? parseInt(req.query.iwm_dte, 10) : settings.getDTE("IWM");
  res.json(buildTradeConfigPreview(spyC, iwmC, spyD, iwmD));
});

app.get("/api/orb/refresh", authguard.requireSecret, async (req, res) => {
  try {
    var results = await orbUtil.populateIfNeeded(true);
    res.json({ ok: true, orb: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/prices", authguard.requireSecret, async (req, res) => {
  try {
    var tickers = { SPY: "SPY", IWM: "IWM", QQQ: "QQQ", SPX: "^GSPC" };
    var results = await Promise.all(Object.entries(tickers).map(async function(entry) {
      var display = entry[0];
      var snap = await yahoo.getQuoteSnapshot(display);
      if (!snap) return [display, { price: null, prev_close: null }];
      return [display, { price: snap.price, prev_close: snap.prev_close }];
    }));
    res.json({ prices: Object.fromEntries(results) });
  } catch (e) {
    console.log("[PRICES_ERROR]", e.message);
    res.json({ prices: {} });
  }
});

app.get("/api/pnl", authguard.requireSecret, (req, res) => {
  res.json(pnlUtil.aggregatePnL());
});

app.get("/api/grok/tiktok/dates", authguard.requireGrokSecret, (req, res) => {
  res.json({ dates: grokContent.listDates() });
});

app.get("/api/grok/tiktok", authguard.requireGrokSecret, (req, res) => {
  var date = req.query.date;
  var channel = req.query.channel;
  if (!date) {
    var dates = grokContent.listDates();
    date = dates[0] || null;
  }
  if (!date) return res.status(404).json({ error: "No Grok content packages found" });
  if (channel) {
    var pkg = grokContent.loadPackage(date, channel);
    if (!pkg) return res.status(404).json({ error: "No package for " + date + " / " + channel });
    var includePrompt = req.query.prompt === "1" || req.query.prompt === "true";
    if (includePrompt) pkg = Object.assign({}, pkg, { grokPromptFile: grokContent.loadPrompt(date, channel) });
    return res.json(pkg);
  }
  var all = grokContent.loadAllForDate(date);
  if (!all) return res.status(404).json({ error: "No packages for " + date });
  res.json(all);
});

app.get("/api/grok/tiktok/daily", authguard.requireGrokSecret, async (req, res) => {
  var date = req.query.date;
  if (!date) {
    var dates = grokContent.listDates();
    date = dates[0] || null;
  }
  if (!date) return res.status(404).json({ error: "No Grok content packages found" });
  var feed = grokContent.loadDailyFeed(date);
  if (!feed) {
    try {
      feed = await grokContent.refreshDailyFeedAsync(date);
    } catch (e) {
      feed = grokContent.refreshDailyFeed(date);
    }
  } else if (!feed.expectedMoves) {
    try {
      feed = await grokContent.refreshDailyFeedAsync(date);
    } catch (e) { /* keep existing feed */ }
  }
  if (!feed) return res.status(404).json({ error: "No daily feed for " + date });
  res.json(feed);
});

// Build (or rebuild) today's packages from live paper account state — works in production.
app.get("/api/grok/tiktok/build", authguard.requireGrokSecret, async (req, res) => {
  try {
    var chans = (typeof discord.getChannels === "function") ? discord.getChannels() : [];
    if (!chans.length) {
      return res.status(503).json({
        error: "No Discord paper channels active — set DISCORD_WEBHOOK_URL / _FREE / _SPY0DTE / _QQQ"
      });
    }
    var built = [];
    for (var i = 0; i < chans.length; i++) {
      var snap = chans[i].grokSnapshot();
      var out = await grokContent.buildAndSaveAsync(snap);
      built.push({
        channel: snap.channel.id,
        name: snap.channel.name,
        date: snap.date,
        headline: out.package.headline,
        trades: out.package.stats.totalTrades
      });
    }
    var date = built[0] && built[0].date;
    var feed = date ? await grokContent.refreshDailyFeedAsync(date) : null;
    res.json({
      ok: true,
      built: built,
      dailyUrl: "/api/grok/tiktok/daily?secret=…",
      feed: feed
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/reauth", authguard.requireSecret, async (req, res) => {
  try {
    rh.setToken(null);
    var ok = await ensureLoggedIn();
    var pending = getPendingWorkflow();
    var auth = await getAuthInfo();
    res.json({
      ok: ok,
      auth: auth,
      pending_type: pending ? pending.challenge_type : null,
      message: ok ? "Connected to Robinhood" : pending ? "Check phone or enter SMS code below" : "Login failed — update RH_TOKEN in Railway"
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sms", authguard.requireSecret, async (req, res) => {
  try {
    var code = req.body.code;
    if (!code) return res.status(400).json({ error: "code required" });
    var result = await submitSmsCode(code);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/contracts", authguard.requireSecret, (req, res) => {
  try {
    const { spy, iwm } = req.body;
    if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
    setContractSize(spy, iwm);
    res.json({ ok: true, contracts: getState().contracts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/discord/sunday", authguard.requireSecret, async (req, res) => {
  try {
    var ch = req.query.channels || req.query.channel || null;
    var posted = await discord.postSundayPremarket(ch);
    res.json({ ok: true, posted: posted || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/discord/orb", authguard.requireSecret, async (req, res) => {
  try {
    var force = String(req.query.force || "") === "1";
    var posted = await discord.postExistingOrbs(force);
    res.json({ ok: true, posted: posted || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/discord/summary", authguard.requireSecret, async (req, res) => {
  try {
    var ch = req.query.channels || req.query.channel || "all";
    var restore = String(req.query.restore || "1") !== "0";
    var date = req.query.date || null;
    var posted = await discord.postDailySummaryForChannels(ch, {
      restoreFromGrok: restore,
      date: date
    });
    res.json({ ok: true, posted: posted || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Replay paper entry Discord alerts (e.g. after a missed TV webhook). Does not place live orders.
app.get("/api/discord/entry", authguard.requireSecret, async (req, res) => {
  try {
    var ticker = ((req.query.ticker) || "SPY").toUpperCase();
    var side = ((req.query.side) || "call").toLowerCase();
    if (side !== "call" && side !== "put") return res.status(400).json({ error: "side must be call or put" });
    if (ticker !== "SPY" && ticker !== "IWM" && ticker !== "QQQ") return res.status(400).json({ error: "invalid ticker" });
    await orbUtil.ensureOrbForTicker(ticker);
    if (ticker === "IWM") await orbUtil.ensureOrbForTicker("SPY");
    var s = getState();
    var orb = (s.orb && s.orb[ticker]) || {};
    var force = String(req.query.force || "1") !== "0";
    var posted = await discord.onEntry(ticker, side, null, orb.high, orb.low, null, { force: force });
    res.json({
      ok: true,
      posted: posted,
      ticker: ticker,
      side: side,
      orb: { high: orb.high, low: orb.low, mid: orb.mid }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/queue", authguard.requireSecret, (req, res) => {
  res.json(webhookQueue.summary());
});

app.post("/api/kill", authguard.requireSecret, async (req, res) => {
  try {
    var action = ((req.body && req.body.action) || "flatten").toLowerCase();
    if (action === "halt") return res.json(killswitch.halt());
    if (action === "resume") return res.json(killswitch.resume());
    if (action === "flatten") return res.json(await killswitch.flattenAll("Kill switch flatten"));
    return res.status(400).json({ error: "action must be halt, resume, or flatten" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function processWebhookPayload(payload) {
  try {
    if (!rh.getToken()) await ensureLoggedIn();
    else {
      var auth = await rh.checkAuthStatus();
      if (!auth.ok) await ensureLoggedIn();
    }
  } catch (authErr) {
    console.warn("[WEBHOOK_QUEUE] Robinhood offline — will retry if retryable:", authErr.message);
    return { ok: false, retryable: true, message: "Robinhood auth: " + authErr.message };
  }
  var result = await handleAlert(payload);
  console.log("[WEBHOOK_DONE]", JSON.stringify(result));
  return result;
}

if (authguard.allowTestRoutes()) {
  app.get("/test/discord/:type", authguard.requireSecret, async (req, res) => {
    try {
      var type = req.params.type;
      if (type === "60") await discord.postGoodMorning(60);
      if (type === "45") await discord.postGoodMorning(45);
      if (type === "30") await discord.postGoodMorning(30);
      if (type === "5")  await discord.postGoodMorning(5);
      if (type === "1")  await discord.postGoodMorning(1);
      if (type === "summary") await discord.postDailySummary();
      if (type === "expected") await discord.postExpectedMoves();
      if (type === "digest" || type === "close") await discord.postCloseDigest();
      if (type === "sunday") await discord.postSundayPremarket();
      if (type === "positions") await discord.postOpenPositions("Test");
      if (type === "entry") await discord.postEntry("SPY", "call", 2.40, 757.50, 754.25);
      if (type === "stop") await discord.postStopLoss("SPY", 1.80, "Stop Loss — ORB Midpoint");
      if (type === "profit") await discord.postProfitTier("SPY", 1, 5, 2.88, 20);
      res.json({ ok: true, tested: type });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/test/discord/summary/:channel", authguard.requireSecret, async (req, res) => {
    try {
      var ch = req.params.channel;
      var chans = (typeof discord.getChannels === "function") ? discord.getChannels() : [];
      var targets;
      if (ch === "all") targets = chans;
      else if (ch === "bc") targets = chans.filter(function(c){ return c.cfg.id === "free" || c.cfg.id === "spy0dte"; });
      else targets = chans.filter(function(c){ return c.cfg.id === ch; });
      for (var i = 0; i < targets.length; i++) await targets[i].dailySummary();
      res.json({ ok: true, tested: targets.map(function(c){ return c.cfg.id; }), active: chans.map(function(c){ return c.cfg.id; }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/test/discord/digest/:channel", authguard.requireSecret, async (req, res) => {
    try {
      var ch = req.params.channel;
      var chans = (typeof discord.getChannels === "function") ? discord.getChannels() : [];
      var targets;
      if (ch === "all") targets = chans;
      else if (ch === "bc") targets = chans.filter(function(c){ return c.cfg.id === "free" || c.cfg.id === "spy0dte"; });
      else targets = chans.filter(function(c){ return c.cfg.id === ch; });
      for (var i = 0; i < targets.length; i++) await targets[i].closeDigest();
      res.json({ ok: true, tested: targets.map(function(c){ return c.cfg.id; }), active: chans.map(function(c){ return c.cfg.id; }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/test/discord/sunday/:channel", authguard.requireSecret, async (req, res) => {
    try {
      var ch = req.params.channel;
      var chans = (typeof discord.getChannels === "function") ? discord.getChannels() : [];
      var targets;
      if (ch === "all") targets = chans;
      else if (ch === "bc") targets = chans.filter(function(c){ return c.cfg.id === "free" || c.cfg.id === "spy0dte"; });
      else targets = chans.filter(function(c){ return c.cfg.id === ch; });
      for (var i = 0; i < targets.length; i++) await targets[i].sundayPremarket();
      res.json({ ok: true, tested: targets.map(function(c){ return c.cfg.id; }), active: chans.map(function(c){ return c.cfg.id; }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/test/grok/tiktok/:channel", authguard.requireGrokSecret, async (req, res) => {
    try {
      var ch = req.params.channel;
      var chans = (typeof discord.getChannels === "function") ? discord.getChannels() : [];
      var targets;
      if (ch === "all") targets = chans;
      else targets = chans.filter(function(c) { return c.cfg.id === ch; });
      if (!targets.length) return res.status(404).json({ error: "No channel: " + ch, active: chans.map(function(c) { return c.cfg.id; }) });
      var save = req.query.save !== "0" && req.query.save !== "false";
      var results = [];
      for (var i = 0; i < targets.length; i++) {
        var snap = targets[i].grokSnapshot();
        var out = save
          ? await grokContent.buildAndSaveAsync(snap)
          : { package: grokContent.buildPackage(snap), paths: null };
        results.push({
          channel: snap.channel.id,
          saved: !!save,
          paths: out.paths,
          headline: out.package.headline,
          grokPrompt: out.package.grokPrompt
        });
      }
      res.json({ ok: true, results: results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

app.post("/webhook", (req, res) => {
  console.log("[WEBHOOK]", JSON.stringify(req.body));
  var item = webhookQueue.enqueue(req.body);
  res.status(200).json({ ok: true, accepted: true, queue_id: item.id });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("ORB server listening on port " + PORT);
  if (authguard.getSecret()) console.log("[AUTH] API secret enabled");
  if (authguard.getGrokSecret()) console.log("[AUTH] Grok API secret enabled");
  await ensureLoggedIn();
  try {
    var recon = await reconcile.reconcileRhPositions();
    if (recon.ok) console.log("[RECONCILE] synced tickers: " + (recon.synced.join(", ") || "none"));
    else console.log("[RECONCILE] skipped: " + (recon.reason || "unknown"));
  } catch (e) {
    console.log("[RECONCILE_ERROR]", e.message);
  }
  scheduleDailyReauth();
  scheduleProactiveRefresh();
  webhookQueue.startWorker(processWebhookPayload, 2000);
  discord.initChannels(rh.getToken.bind(rh));
  profitManager.startProfitManager();
  orbUtil.scheduleORBCapture();
  qqqYahooSignals.startQqqYahooSignals();
});
