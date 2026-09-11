// utils/webhookQueue.js — durable webhook queue with retry backoff.

var fs = require("fs");
var crypto = require("crypto");
var persist = require("./persist");
var stateModule = require("./state");

var FILE = persist.filePath("webhook-queue.json");
var RETRY_DELAYS_MS = [5000, 30000, 120000, 600000];
var MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

var queue = { items: [] };
var workerTimer = null;
var workerBusy = false;
var processFn = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      var data = JSON.parse(fs.readFileSync(FILE, "utf8"));
      if (data && Array.isArray(data.items)) queue = data;
    }
  } catch (e) {
    console.log("[WEBHOOK_QUEUE] load failed: " + e.message);
  }
}

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(queue)); }
  catch (e) { console.log("[WEBHOOK_QUEUE] save failed: " + e.message); }
}

function summary() {
  var counts = { pending: 0, retry: 0, processing: 0, done: 0, failed: 0 };
  queue.items.forEach(function(it) {
    if (counts[it.status] !== undefined) counts[it.status]++;
  });
  return {
    counts: counts,
    total: queue.items.length,
    recent: queue.items.slice(-8).reverse()
  };
}

function enqueue(payload) {
  var item = {
    id: crypto.randomUUID(),
    payload: payload,
    status: "pending",
    attempts: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    nextAttemptAt: Date.now(),
    lastError: null,
    result: null
  };
  queue.items.push(item);
  if (queue.items.length > 200) queue.items = queue.items.slice(-200);
  save();
  stateModule.logEvent("WEBHOOK_Q", "Queued " + (payload.ticker || "?") + " " + (payload.event || "?"));
  return item;
}

function scheduleRetry(item, errMsg) {
  item.attempts += 1;
  item.lastError = errMsg || "unknown";
  item.updatedAt = Date.now();
  if (item.attempts >= MAX_ATTEMPTS) {
    item.status = "failed";
    item.nextAttemptAt = null;
    stateModule.logEvent("WEBHOOK_Q_FAIL", item.id.slice(0, 8) + " " + (item.payload.ticker || "") + " " + (item.payload.event || "") + " — " + item.lastError);
  } else {
    item.status = "retry";
    item.nextAttemptAt = Date.now() + RETRY_DELAYS_MS[item.attempts - 1];
    stateModule.logEvent("WEBHOOK_Q_RETRY", item.id.slice(0, 8) + " attempt " + item.attempts + " in " + Math.round(RETRY_DELAYS_MS[item.attempts - 1] / 1000) + "s");
  }
  save();
}

function markDone(item, result) {
  item.status = "done";
  item.result = result || { ok: true };
  item.updatedAt = Date.now();
  item.nextAttemptAt = null;
  save();
}

function dueItems() {
  var now = Date.now();
  return queue.items.filter(function(it) {
    return (it.status === "pending" || it.status === "retry") && it.nextAttemptAt <= now;
  });
}

async function processItem(item) {
  if (!processFn) throw new Error("webhook queue processor not configured");
  item.status = "processing";
  item.updatedAt = Date.now();
  save();
  try {
    var result = await processFn(item.payload);
    if (result && result.retryable) {
      scheduleRetry(item, result.message || result.error || "retryable failure");
      return;
    }
    if (result && result.ok === false) {
      scheduleRetry(item, result.message || "handler returned not ok");
      return;
    }
    markDone(item, result);
  } catch (err) {
    scheduleRetry(item, err.message || String(err));
  }
}

async function tick() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    var due = dueItems();
    for (var i = 0; i < due.length; i++) await processItem(due[i]);
  } catch (e) {
    console.log("[WEBHOOK_QUEUE] worker error: " + e.message);
  } finally {
    workerBusy = false;
  }
}

function startWorker(handler, intervalMs) {
  processFn = handler;
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = setInterval(tick, intervalMs || 2000);
  setImmediate(tick);
  console.log("[WEBHOOK_QUEUE] worker started (interval " + (intervalMs || 2000) + "ms)");
}

load();

module.exports = {
  enqueue: enqueue,
  startWorker: startWorker,
  summary: summary,
  tick: tick
};
