var fs = require("fs");
var persist = require("./persist");

var PNL_FILE = persist.filePath("orb-pnl.json");

function etYmd(date) {
  return (date || new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function logTradePnL(ticker, side, entryPrice, exitPrice, contracts) {
  try {
    var data = { trades: [] };
    if (fs.existsSync(PNL_FILE)) data = JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
    var pnl = (parseFloat(exitPrice) - parseFloat(entryPrice)) * contracts * 100;
    data.trades.push({
      time: new Date().toISOString(),
      ticker: ticker,
      side: side,
      entryPrice: entryPrice,
      exitPrice: exitPrice,
      contracts: contracts,
      pnl: pnl
    });
    var yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    data.trades = data.trades.filter(function(t) { return new Date(t.time) >= yearAgo; });
    fs.writeFileSync(PNL_FILE, JSON.stringify(data));
  } catch (e) {
    console.log("[PNL_ERROR]", e.message);
  }
}

function aggregatePnL() {
  try {
    if (!fs.existsSync(PNL_FILE)) return { daily: null, weekly: null, monthly: null, yearly: null };
    var data = JSON.parse(fs.readFileSync(PNL_FILE, "utf8"));
    var now = new Date();
    var todayEt = etYmd(now);
    var daily = 0, weekly = 0, monthly = 0, yearly = 0;
    var hasData = false;
    (data.trades || []).forEach(function(t) {
      var d = new Date(t.time);
      var pnl = parseFloat(t.pnl) || 0;
      if (etYmd(d) === todayEt) { daily += pnl; hasData = true; }
      var weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
      if (d >= weekAgo) { weekly += pnl; hasData = true; }
      var monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
      if (d >= monthAgo) { monthly += pnl; hasData = true; }
      var yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      if (d >= yearAgo) { yearly += pnl; hasData = true; }
    });
    return hasData ? { daily: daily, weekly: weekly, monthly: monthly, yearly: yearly }
                    : { daily: null, weekly: null, monthly: null, yearly: null };
  } catch (e) {
    console.log("[PNL_ERROR]", e.message);
    return { daily: null, weekly: null, monthly: null, yearly: null };
  }
}

module.exports = { logTradePnL: logTradePnL, aggregatePnL: aggregatePnL, PNL_FILE: PNL_FILE };
