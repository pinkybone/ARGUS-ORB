var fs = require("fs");
var persist = require("./persist");

var PERSIST_FILE = persist.filePath("orb-state.json");

function etDateKey() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

function loadPersistedState() {
  try {
    if (fs.existsSync(PERSIST_FILE)) return JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
  } catch (e) {}
  return null;
}

function savePersistedState() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      contracts: state.contracts,
      orb: state.orb,
      positions: state.positions,
      lastReset: state.lastReset
    }));
  } catch (e) {}
}

var _saved = loadPersistedState();
var _today = etDateKey();

function freshOrb() {
  return {
    SPY: { high: null, low: null, mid: null, set: false, date: null, source: null },
    IWM: { high: null, low: null, mid: null, set: false, date: null, source: null },
    QQQ: { high: null, low: null, mid: null, set: false, date: null, source: null },
    SPX: { high: null, low: null, mid: null, set: false, date: null, source: null }
  };
}

function restoreOrb(savedOrb) {
  var orb = freshOrb();
  if (!savedOrb) return orb;
  ["SPY", "IWM", "QQQ", "SPX"].forEach(function(t) {
    var o = savedOrb[t];
    if (o && o.set && o.date === _today) orb[t] = o;
  });
  return orb;
}

function restorePositions(savedPos) {
  var positions = { SPY: null, IWM: null };
  if (!savedPos || _saved.lastReset !== _today) return positions;
  ["SPY", "IWM"].forEach(function(t) {
    if (savedPos[t] && !savedPos[t].stopped) positions[t] = savedPos[t];
  });
  return positions;
}

let state = {
  contracts: (_saved && _saved.contracts) ? _saved.contracts : { SPY: 1, IWM: 1 },
  orb: restoreOrb(_saved && _saved.orb),
  positions: restorePositions(_saved && _saved.positions),
  lastReset: (_saved && _saved.lastReset === _today) ? _saved.lastReset : null,
  log: []
};

function getState() { return state; }

function resetDay() {
  var today = etDateKey();
  if (state.lastReset !== today) {
    var hadPrior = !!state.lastReset;
    state.orb = freshOrb();
    state.positions = { SPY: null, IWM: null };
    if (hadPrior && process.env.ORB_DAILY_INCREMENT !== "0") {
      state.contracts.SPY = Math.min(100, (state.contracts.SPY || 1) + 1);
      state.contracts.IWM = Math.min(100, (state.contracts.IWM || 1) + 1);
      logEvent("CONTRACTS", "Daily +1 → SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
    }
    state.lastReset = today;
    logEvent("DAY_RESET", "New day. Contracts SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
    savePersistedState();
  }
}

function setORB(ticker, high, low, source) {
  var h = parseFloat(high);
  var l = parseFloat(low);
  if (!isFinite(h) || !isFinite(l) || h <= 0 || l <= 0 || h <= l) {
    logEvent("ORB_REJECT", ticker + " flat/invalid range High=" + high + " Low=" + low + " (" + (source || "webhook") + ")");
    return false;
  }
  var mid = parseFloat(((h + l) / 2).toFixed(4));
  var etDate = etDateKey();
  state.orb[ticker] = { high: h, low: l, mid: mid, set: true, date: etDate, source: source || "webhook" };
  logEvent("ORB_SET", ticker + " High=" + h + " Low=" + l + " Mid=" + mid + " (" + (source || "webhook") + ")");
  savePersistedState();
  return true;
}

function getPosition(ticker) { return state.positions[ticker]; }

function openHalfPosition(ticker, side, contracts, entryPrice, meta) {
  meta = meta || {};
  var totalForRetest = meta.totalContracts != null
    ? Math.max(1, Math.floor(parseFloat(meta.totalContracts) || 1))
    : contracts;
  state.positions[ticker] = {
    side: side,
    halfIn: true,
    fullIn: false,
    contracts: contracts,
    totalContracts: totalForRetest,
    entryPrice: parseFloat(entryPrice) || 0,
    breakEvenActivated: false,
    lastProfitTier: 0,
    stopPct: null,
    stopped: false,
    crossEntry: !!meta.crossEntry,
    stopMode: meta.stopMode || "mid",
    strike: meta.strike || null,
    expiry: meta.expiry || null,
    instrumentUrl: meta.instrumentUrl || null,
    legs: meta.legs || null,
    dualLeg: !!meta.dualLeg,
    openedAtMs: Date.now()
  };
  logEvent("POSITION_OPEN", ticker + " " + side + " half " + contracts + "c @ $" + entryPrice +
    (meta.dualLeg ? " (0DTE+1DTE)" : "") +
    (meta.crossEntry ? " (cross-entry stop=" + meta.stopMode + ")" : ""));
  savePersistedState();
}

function setPositionLegs(ticker, legs) {
  var pos = state.positions[ticker];
  if (!pos || pos.stopped || !legs || !legs.length) return;
  pos.legs = legs.map(function(l) {
    return {
      dteTag: l.dteTag != null ? l.dteTag : 0,
      side: l.side || pos.side,
      contracts: Math.max(0, Math.floor(parseFloat(l.contracts) || 0)),
      entryPrice: parseFloat(l.entryPrice) || 0,
      strike: l.strike != null ? Math.round(parseFloat(l.strike)) : null,
      expiry: l.expiry || null,
      instrumentUrl: l.instrumentUrl || null,
      breakEvenActivated: !!l.breakEvenActivated,
      lastProfitTier: l.lastProfitTier || 0,
      stopPct: typeof l.stopPct === "number" ? l.stopPct : null
    };
  });
  refreshPositionFromLegs(pos);
  savePersistedState();
}

function refreshPositionFromLegs(pos) {
  if (!pos || !pos.legs) return;
  var totalC = 0;
  var weighted = 0;
  pos.legs.forEach(function(l) {
    totalC += l.contracts;
    weighted += (l.entryPrice || 0) * l.contracts;
  });
  pos.contracts = totalC;
  if (totalC > 0 && weighted > 0) pos.entryPrice = weighted / totalC;
  pos.dualLeg = pos.legs.filter(function(l) { return l.contracts > 0; }).length > 1;
  var live = pos.legs.find(function(l) { return l.contracts > 0; });
  if (live) {
    pos.instrumentUrl = live.instrumentUrl;
    pos.strike = live.strike;
    pos.expiry = live.expiry;
  }
}

function reduceLegContracts(ticker, legIndex, sold) {
  var pos = state.positions[ticker];
  if (!pos || !pos.legs || !pos.legs[legIndex]) {
    reduceContracts(ticker, sold);
    return;
  }
  var leg = pos.legs[legIndex];
  leg.contracts = Math.max(0, leg.contracts - sold);
  refreshPositionFromLegs(pos);
  savePersistedState();
}

function setLegBreakEven(ticker, legIndex) {
  var pos = state.positions[ticker];
  if (!pos || !pos.legs || !pos.legs[legIndex]) return;
  var leg = pos.legs[legIndex];
  if (!leg.breakEvenActivated) {
    leg.breakEvenActivated = true;
    pos.breakEvenActivated = pos.legs.every(function(l) {
      return l.contracts <= 0 || l.breakEvenActivated;
    });
    logEvent("BREAKEVEN", ticker + " leg DTE" + leg.dteTag + " breakeven @ $" + (leg.entryPrice || 0).toFixed(2));
    savePersistedState();
  }
}

function markLegProfitTier(ticker, legIndex, tier) {
  var pos = state.positions[ticker];
  if (!pos || !pos.legs || !pos.legs[legIndex]) return;
  var leg = pos.legs[legIndex];
  leg.lastProfitTier = Math.max(leg.lastProfitTier || 0, tier);
  pos.lastProfitTier = Math.max(pos.lastProfitTier || 0, tier);
  savePersistedState();
}

function addToLegs(ticker, filledLegs) {
  var pos = state.positions[ticker];
  if (!pos || pos.stopped || !pos.legs || !filledLegs || !filledLegs.length) return;
  filledLegs.forEach(function(fill) {
    var qty = Math.max(0, Math.floor(parseFloat(fill.contracts) || 0));
    if (qty < 1) return;
    var leg = null;
    for (var i = 0; i < pos.legs.length; i++) {
      if (fill.dteTag != null && pos.legs[i].dteTag === fill.dteTag) { leg = pos.legs[i]; break; }
      if (fill.instrumentUrl && pos.legs[i].instrumentUrl === fill.instrumentUrl) { leg = pos.legs[i]; break; }
    }
    if (!leg) return;
    var px = parseFloat(fill.entryPrice) || 0;
    if (leg.entryPrice > 0 && px > 0 && leg.contracts > 0) {
      leg.entryPrice = (leg.entryPrice * leg.contracts + px * qty) / (leg.contracts + qty);
    } else if (px > 0) {
      leg.entryPrice = px;
    }
    leg.contracts += qty;
    if (fill.instrumentUrl) leg.instrumentUrl = fill.instrumentUrl;
    if (fill.strike != null) leg.strike = Math.round(parseFloat(fill.strike));
    if (fill.expiry) leg.expiry = fill.expiry;
  });
  pos.fullIn = true;
  pos.halfIn = false;
  refreshPositionFromLegs(pos);
  logEvent("POSITION_ADD", ticker + " dual-leg retest add — total " + pos.contracts + "c avg=$" +
    (pos.entryPrice ? pos.entryPrice.toFixed(2) : "0"));
  savePersistedState();
}

function addSecondHalf(ticker, contracts, fillPrice) {
  var pos = state.positions[ticker];
  if (!pos || pos.fullIn) return;
  var add = Math.max(0, parseFloat(contracts) || 0);
  var newPx = parseFloat(fillPrice) || 0;
  if (pos.entryPrice > 0 && newPx > 0 && pos.contracts > 0 && add > 0) {
    pos.entryPrice = (pos.entryPrice * pos.contracts + newPx * add) / (pos.contracts + add);
  } else if (newPx > 0) {
    pos.entryPrice = newPx;
  }
  pos.contracts += add;
  pos.fullIn = true;
  pos.halfIn = false;
  logEvent("POSITION_ADD", ticker + " +half +" + add + "c @ $" + fillPrice + " total=" + pos.contracts +
    (pos.entryPrice ? " avg=$" + pos.entryPrice.toFixed(2) : ""));
  savePersistedState();
}

function setBreakEven(ticker) {
  var pos = state.positions[ticker];
  if (pos && !pos.breakEvenActivated) {
    pos.breakEvenActivated = true;
    logEvent("BREAKEVEN", ticker + " breakeven stop activated @ entry $" + pos.entryPrice);
    savePersistedState();
  }
}

function markProfitTier(ticker, tier) {
  var pos = state.positions[ticker];
  if (pos) {
    pos.lastProfitTier = Math.max(pos.lastProfitTier, tier);
    savePersistedState();
  }
}

function reduceContracts(ticker, sold) {
  var pos = state.positions[ticker];
  if (!pos) return;
  pos.contracts = Math.max(0, pos.contracts - sold);
  savePersistedState();
}

function closePosition(ticker, reason) {
  var pos = state.positions[ticker];
  if (pos) {
    pos.stopped = true;
    logEvent("POSITION_CLOSE", ticker + " closed: " + reason);
    savePersistedState();
  }
}

function setEntryPrice(ticker, price) {
  var pos = state.positions[ticker];
  if (pos && price > 0) {
    pos.entryPrice = parseFloat(price);
    savePersistedState();
  }
}

function applyOrderFill(ticker, order) {
  if (!order) return;
  var pos = state.positions[ticker];
  if (!pos || pos.stopped) return;
  if (order.entryPrice && order.entryPrice > 0) {
    pos.entryPrice = parseFloat(order.entryPrice);
    if (!pos.openedAtMs) pos.openedAtMs = Date.now();
  }
  if (order.instrumentUrl) pos.instrumentUrl = order.instrumentUrl;
  if (order.strike) pos.strike = Math.round(parseFloat(order.strike));
  if (order.expiry) pos.expiry = order.expiry;
  savePersistedState();
  if (order.entryPrice && order.entryPrice > 0) {
    logEvent("ENTRY_FILL", ticker + " live entry @ $" + parseFloat(order.entryPrice).toFixed(2));
  }
}

function setContractSize(spy, iwm) {
  state.contracts.SPY = Math.min(100, Math.max(1, parseInt(spy, 10) || 1));
  state.contracts.IWM = Math.min(100, Math.max(1, parseInt(iwm, 10) || 1));
  savePersistedState();
  logEvent("CONTRACTS", "Size updated SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
}

function getTradeSizingFromTotal(total) {
  total = Math.min(100, Math.max(1, parseInt(total, 10) || 1));
  var half = Math.ceil(total / 2);
  return {
    total: total,
    halfEntry: half,
    retestAdd: half,
    fullPosition: half * 2
  };
}

function getTradeSizing(ticker) {
  return getTradeSizingFromTotal(state.contracts[ticker] || 1);
}

function phaseFromQty(qty, halfEntry) {
  var q = Math.max(1, Math.floor(parseFloat(qty) || 1));
  var half = Math.max(1, parseInt(halfEntry, 10) || 1);
  var isFull = q > half;
  return { halfIn: !isFull, fullIn: isFull, contracts: q, totalContracts: half };
}

function inferPositionPhase(ticker, qty) {
  return phaseFromQty(qty, getTradeSizing(ticker).halfEntry);
}

function importRhPosition(ticker, side, qty, entryPrice, meta) {
  meta = meta || {};
  var phase = inferPositionPhase(ticker, qty);
  state.positions[ticker] = {
    side: side,
    halfIn: phase.halfIn,
    fullIn: phase.fullIn,
    contracts: phase.contracts,
    totalContracts: phase.totalContracts,
    entryPrice: parseFloat(entryPrice) || 0,
    breakEvenActivated: false,
    lastProfitTier: 0,
    stopPct: null,
    stopped: false,
    crossEntry: !!meta.crossEntry,
    stopMode: meta.stopMode || "mid",
    strike: meta.strike || null,
    expiry: meta.expiry || null,
    instrumentUrl: meta.instrumentUrl || null,
    openedAtMs: Date.now()
  };
  logEvent("POSITION_OPEN", ticker + " " + side + " " + phase.contracts + "c @ $" + entryPrice +
    (phase.halfIn ? " (half)" : " (full)") +
    (meta.crossEntry ? " cross-entry stop=" + meta.stopMode : "") + " [reconcile]");
  savePersistedState();
}

function syncPositionQty(ticker, qty) {
  var pos = state.positions[ticker];
  if (!pos || pos.stopped) return;
  var q = Math.max(0, Math.floor(parseFloat(qty) || 0));
  pos.contracts = q;
  var half = getTradeSizing(ticker).halfEntry;
  if (q > half) {
    pos.fullIn = true;
    pos.halfIn = false;
  }
  savePersistedState();
}

function markEodSold(ticker, dateKey) {
  var pos = state.positions[ticker];
  if (!pos) return;
  pos.eodSold = dateKey;
  savePersistedState();
}

function logEvent(type, message) {
  var entry = { time: new Date().toISOString(), type: type, message: message };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log("[" + type + "] " + message);
}

module.exports = {
  getState: getState,
  resetDay: resetDay,
  setORB: setORB,
  getPosition: getPosition,
  openHalfPosition: openHalfPosition,
  setPositionLegs: setPositionLegs,
  reduceLegContracts: reduceLegContracts,
  setLegBreakEven: setLegBreakEven,
  markLegProfitTier: markLegProfitTier,
  addToLegs: addToLegs,
  addSecondHalf: addSecondHalf,
  setBreakEven: setBreakEven,
  markProfitTier: markProfitTier,
  reduceContracts: reduceContracts,
  closePosition: closePosition,
  setEntryPrice: setEntryPrice,
  applyOrderFill: applyOrderFill,
  setContractSize: setContractSize,
  getTradeSizing: getTradeSizing,
  getTradeSizingFromTotal: getTradeSizingFromTotal,
  phaseFromQty: phaseFromQty,
  inferPositionPhase: inferPositionPhase,
  importRhPosition: importRhPosition,
  syncPositionQty: syncPositionQty,
  markEodSold: markEodSold,
  logEvent: logEvent,
  etDateKey: etDateKey
};
