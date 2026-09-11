// Direct Robinhood API - modern 2026 auth flow
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const persist = require("./persist");

const RH_BASE = "api.robinhood.com";
const AUTH_FILE = persist.filePath("rh-auth.json");
const LEGACY_REFRESH_FILE = persist.filePath("rh-refresh.json");
let _token = null;
let _deviceToken = null;

function readAuthFile() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      var d = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
      if (d && typeof d === "object") return d;
    }
  } catch (e) {}
  // One-time migration from older refresh-only file.
  try {
    if (fs.existsSync(LEGACY_REFRESH_FILE)) {
      var legacy = JSON.parse(fs.readFileSync(LEGACY_REFRESH_FILE, "utf8"));
      if (legacy && legacy.refresh_token) {
        var migrated = {
          refresh_token: legacy.refresh_token,
          device_token: process.env.RH_DEVICE_TOKEN || null,
          ts: legacy.ts || Date.now()
        };
        saveAuthSession(migrated);
        try { fs.unlinkSync(LEGACY_REFRESH_FILE); } catch (e) {}
        return migrated;
      }
    }
  } catch (e) {}
  return null;
}

function saveAuthSession(patch) {
  try {
    var cur = readAuthFile() || {};
    var next = Object.assign({}, cur, patch || {}, { ts: Date.now() });
    if (next.access_token) {
      var expMs = decodeJwtExp(next.access_token);
      if (expMs) next.expires_at = Math.floor(expMs / 1000);
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(next));
  } catch (e) {
    console.log("[AUTH] Could not persist auth session: " + e.message);
  }
}

var REFRESH_SKEW_MS = 24 * 60 * 60 * 1000;

function decodeJwtExp(token) {
  if (!token) return null;
  var parts = String(token).split(".");
  if (parts.length < 2) return null;
  try {
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var payload = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : null;
  } catch (e) {
    return null;
  }
}

function getAccessTokenExpiryMs() {
  var session = readAuthFile();
  if (session && session.expires_at) return session.expires_at * 1000;
  return decodeJwtExp(_token || process.env.RH_TOKEN);
}

function needsProactiveRefresh() {
  if (!getStoredRefreshToken()) return false;
  var exp = getAccessTokenExpiryMs();
  if (!exp) return true;
  return (exp - Date.now()) < REFRESH_SKEW_MS;
}

function clearAuthSession() {
  try { if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE); } catch (e) {}
  try { if (fs.existsSync(LEGACY_REFRESH_FILE)) fs.unlinkSync(LEGACY_REFRESH_FILE); } catch (e) {}
}

function ensureDeviceToken() {
  if (_deviceToken) return _deviceToken;
  var session = readAuthFile();
  if (session && session.device_token) {
    _deviceToken = session.device_token;
    return _deviceToken;
  }
  if (process.env.RH_DEVICE_TOKEN) {
    _deviceToken = process.env.RH_DEVICE_TOKEN;
    return _deviceToken;
  }
  return null;
}

function getStoredRefreshToken() {
  var session = readAuthFile();
  if (session && session.refresh_token) return session.refresh_token;
  return process.env.RH_REFRESH_TOKEN || null;
}

function getStoredDeviceToken() {
  return ensureDeviceToken();
}

function generateDeviceToken() {
  const rands = Array.from(crypto.randomBytes(16));
  const hexa = Array.from({length: 256}, (_, i) => (i + 256).toString(16).slice(1));
  let token = "";
  rands.forEach((r, i) => {
    token += hexa[r];
    if ([3, 5, 7, 9].includes(i)) token += "-";
  });
  return token;
}

function rawRequest(method, path, data, token, contentType) {
  return new Promise((resolve, reject) => {
    const isForm = contentType === "form";
    const body = data
      ? isForm
        ? Object.entries(data).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")
        : JSON.stringify(data)
      : null;

    const headers = {
      "Accept": "application/json",
      "Accept-Language": "en-US;q=1",
      "X-Robinhood-API-Version": "1.431.4",
      "Connection": "keep-alive",
      "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
    };
    if (isForm) {
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=utf-8";
    } else {
      headers["Content-Type"] = "application/json";
    }
    if (token) headers["Authorization"] = "Bearer " + token;
    if (body) headers["Content-Length"] = Buffer.byteLength(body);

    const options = { hostname: RH_BASE, path, method, headers };
    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch(e) { parsed = { raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// Backward-compatible: returns just the parsed body (used by auth/login flows).
function request(method, path, data, token, contentType) {
  return rawRequest(method, path, data, token, contentType).then(r => r.body);
}

// Did Robinhood reject us for auth reasons?
function isAuthError(r) {
  if (r.status === 401 || r.status === 403) return true;
  var b = r.body || {};
  var msg = (b.detail || b.error || b.error_description || "").toString().toLowerCase();
  return msg.indexOf("token") !== -1 && msg.indexOf("expired") !== -1
      || msg.indexOf("authentication credentials") !== -1
      || msg.indexOf("not provided") !== -1
      || msg.indexOf("unauthorized") !== -1
      || msg.indexOf("invalid token") !== -1;
}

// Force a token refresh using the freshest stored refresh token.
async function reauthorize() {
  var res = await refreshWithStoredTokens();
  if (res.ok) { console.log("[AUTH] reauthorize: token refreshed"); return true; }
  console.log("[AUTH] reauthorize failed: " + res.error);
  return false;
}

// Authed data request with one refresh-and-retry on token expiry. This is what
// keeps orders/quotes working when the access token lapses mid-session instead
// of silently failing the trade.
async function authedRequest(method, path, data, contentType) {
  var r = await rawRequest(method, path, data, _token, contentType);
  if (isAuthError(r)) {
    console.log("[AUTH] Access token rejected on " + method + " " + path + " — refreshing and retrying once");
    var ok = await reauthorize();
    if (ok) r = await rawRequest(method, path, data, _token, contentType);
  }
  return r.body;
}

async function login(email, password, mfa_code) {
  if (!_deviceToken) _deviceToken = ensureDeviceToken() || process.env.RH_DEVICE_TOKEN || generateDeviceToken();

  const payload = {
    client_id: "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS",
    expires_in: 86400,
    grant_type: "password",
    password: password,
    scope: "internal",
    username: email,
    device_token: _deviceToken,
    try_passkeys: false,
    token_request_path: "/login",
    create_read_only_secondary_token: true
  };
  if (mfa_code) payload.mfa_code = mfa_code;

  console.log("[AUTH] Attempting Robinhood login...");
  const data = await request("POST", "/oauth2/token/", payload, null, "form");

  if (data.access_token) {
    _token = data.access_token;
    saveAuthSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token || null,
      device_token: _deviceToken
    });
    console.log("[AUTH] Login successful");
    return { ok: true, token: _token };
  }

  if (data.verification_workflow) {
    const workflowId = data.verification_workflow.id;
    console.log("[AUTH] Verification required, workflow: " + workflowId);
    return { ok: false, verification_workflow: true, workflow_id: workflowId, device_token: _deviceToken, payload };
  }

  if (data.mfa_required) {
    console.log("[AUTH] MFA required");
    return { ok: false, mfa_required: true };
  }

  console.log("[AUTH_ERROR] " + JSON.stringify(data));
  return { ok: false, error: JSON.stringify(data) };
}

async function handleVerificationWorkflow(deviceToken, workflowId) {
  const pathfinderUrl = "/pathfinder/user_machine/";
  const machinePayload = { device_id: deviceToken, flow: "suv", input: { workflow_id: workflowId } };
  const machineData = await request("POST", pathfinderUrl, machinePayload, null, "json");
  const machineId = machineData.id;
  if (!machineId) throw new Error("No machine ID from pathfinder");
  console.log("[AUTH] Pathfinder machine ID: " + machineId);
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const inquiry = await request("GET", `/pathfinder/inquiries/${machineId}/user_view/`, null, null, "json");
    if (inquiry && inquiry.context && inquiry.context.sheriff_challenge) {
      const challenge = inquiry.context.sheriff_challenge;
      return { challenge_type: challenge.type, challenge_id: challenge.id, challenge_status: challenge.status, machine_id: machineId };
    }
  }
  throw new Error("Verification timeout");
}

async function completeWorkflow(machineId) {
  const payload = { sequence: 0, user_input: { status: "continue" } };
  for (let i = 0; i < 5; i++) {
    const res = await request("POST", `/pathfinder/inquiries/${machineId}/user_view/`, payload, null, "json");
    if (res && res.type_context && res.type_context.result === "workflow_status_approved") return true;
    await sleep(3000);
  }
  return true;
}

async function respondToSmsChallenge(challengeId, code) {
  return await request("POST", `/challenge/${challengeId}/respond/`, { response: code }, null, "json");
}

async function waitForPushApproval(challengeId) {
  const url = `/push/${challengeId}/get_prompts_status/`;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const res = await request("GET", url, null, null, "json");
    if (res && res.challenge_status === "validated") return true;
  }
  return false;
}

function setToken(token) { _token = token; }
function getToken() { return _token; }
function setDeviceToken(dt) { _deviceToken = dt; }

async function getQuote(ticker) {
  const res = await authedRequest("GET", `/quotes/${ticker}/`, null, "json");
  return parseFloat(res.last_trade_price || res.ask_price || 0);
}

// Find the nearest listed expiration for this chain/strike/type at or after the
// requested date (falls back to the latest available if none are later).
async function findNearestExpiry(ticker, strike, optionType, requested) {
  for (const offset of [0, 1, -1, 2, -2, 5, -5]) {
    const url = `/options/instruments/?chain_symbol=${ticker}&strike_price=${strike + offset}&type=${optionType}&state=active`;
    const res = await authedRequest("GET", url, null, "json");
    const results = res.results || [];
    if (results.length) {
      const dates = Array.from(new Set(results.map(r => r.expiration_date).filter(Boolean))).sort();
      if (dates.length) {
        const onOrAfter = dates.filter(d => d >= requested);
        return onOrAfter.length ? onOrAfter[0] : dates[dates.length - 1];
      }
    }
  }
  return null;
}

async function getOptionInstrument(ticker, expiry, strike, optionType) {
  async function tryExpiry(exp) {
    let url = `/options/instruments/?chain_symbol=${ticker}&expiration_dates=${exp}&strike_price=${strike}&type=${optionType}&state=active`;
    let res = await authedRequest("GET", url, null, "json");
    if (res.results && res.results.length > 0) return res.results[0];
    for (const offset of [1, -1, 2, -2, 5, -5]) {
      url = `/options/instruments/?chain_symbol=${ticker}&expiration_dates=${exp}&strike_price=${strike + offset}&type=${optionType}&state=active`;
      res = await authedRequest("GET", url, null, "json");
      if (res.results && res.results.length > 0) return res.results[0];
    }
    return null;
  }

  // 1) Requested expiry (with nearby-strike fallback)
  let inst = await tryExpiry(expiry);
  if (inst) return inst;

  // 2) Requested expiry isn't listed (e.g. SPY 0DTE on a non-listed day, or
  //    IWM 1DTE when no next-day expiry exists) → roll to nearest available.
  const alt = await findNearestExpiry(ticker, strike, optionType, expiry);
  if (alt && alt !== expiry) {
    console.log("[OPTION] " + ticker + " " + expiry + " not listed — rolling to nearest " + alt);
    inst = await tryExpiry(alt);
    if (inst) return inst;
  }
  return null;
}

async function placeOptionOrder(ticker, side, contracts, expiry, strike, optionType) {
  const instrument = await getOptionInstrument(ticker, expiry, strike, optionType);
  if (!instrument) throw new Error(`No option found: ${ticker} ${expiry} ${strike} ${optionType}`);

  const instrumentUrl = instrument.url;
  const quoteRes = await authedRequest("GET", `/marketdata/options/?instruments=${encodeURIComponent(instrumentUrl)}`, null, "json");
  const askPrice = quoteRes.results?.[0]?.ask_price || "1.00";
  const limitPrice = (parseFloat(askPrice) * 1.05).toFixed(2);

  const order = {
    account: `https://api.robinhood.com/accounts/${process.env.RH_ACCOUNT_NUMBER}/`,
    direction: "debit",
    legs: [{
      option: instrumentUrl,
      position_effect: "open",
      ratio_quantity: 1,
      side: "buy"
    }],
    override_day_trade_checks: false,
    override_dtbp_checks: false,
    price: limitPrice,
    quantity: String(contracts),
    time_in_force: "gfd",
    trigger: "immediate",
    type: "limit",
    ref_id: crypto.randomUUID()
  };

  console.log(`[ORDER] ${ticker} ${optionType} x${contracts} strike=${strike} expiry=${expiry} price=${limitPrice}`);
  const res = await authedRequest("POST", "/options/orders/", order, "json");
  if (res.id) {
    console.log(`[ORDER_OK] ${res.id}`);
    return {
      ok: true,
      order_id: res.id,
      price: limitPrice,
      instrumentUrl: instrumentUrl,
      strike: instrument.strike_price ? Math.round(parseFloat(instrument.strike_price)) : strike,
      expiry: instrument.expiration_date || expiry,
      optionType: optionType
    };
  }
  console.log("[ORDER_ERROR]", JSON.stringify(res));
  throw new Error(JSON.stringify(res));
}

function pickRhPosition(open, matchOpts) {
  matchOpts = matchOpts || {};
  if (matchOpts.instrumentUrl) {
    var byUrl = open.find(function(p) { return sameOptionUrl(p.option, matchOpts.instrumentUrl); });
    if (byUrl) return byUrl;
  }
  if (matchOpts.side) {
    var want = matchOpts.side;
    var bySide = open.find(function(p) {
      var t = ((p.option_type || p.type || "") + "").toLowerCase();
      var sideOk = t === want;
      var strikeOk = !matchOpts.strike || Math.round(parseFloat(p.strike_price)) === Math.round(parseFloat(matchOpts.strike));
      var expOk = !matchOpts.expiry || p.expiration_date === matchOpts.expiry;
      return sideOk && strikeOk && expOk;
    });
    if (bySide) return bySide;
  }
  return open.length === 1 ? open[0] : null;
}

async function closeOptionPosition(ticker, contracts, reason, matchOpts) {
  const fetched = await fetchOpenOptionPositions();
  if (!fetched.ok) return { ok: false, error: "positions_fetch_failed: " + (fetched.error || "unknown") };
  const matching = (fetched.positions || []).filter(p => p.chain_symbol === ticker && optionPositionQty(p) > 0);
  if (!matching.length) return { ok: false, error: "No open position found" };

  const pos = pickRhPosition(matching, matchOpts);
  if (!pos) return { ok: false, error: "No matching open position found" };

  // Use the open position's instrument URL directly — re-resolving via expiry/strike
  // can fail on 0DTE same-day contracts even though RH still holds the position.
  const instrumentUrl = pos.option || matchOpts.instrumentUrl || null;
  if (!instrumentUrl) return { ok: false, error: "No instrument URL on open position" };

  const quoteRes = await authedRequest("GET", `/marketdata/options/?instruments=${encodeURIComponent(instrumentUrl)}`, null, "json");
  const bidPrice = quoteRes.results?.[0]?.bid_price || "0.10";
  const limitPrice = (parseFloat(bidPrice) * 0.95).toFixed(2);

  const order = {
    account: `https://api.robinhood.com/accounts/${process.env.RH_ACCOUNT_NUMBER}/`,
    direction: "credit",
    legs: [{
      option: instrumentUrl,
      position_effect: "close",
      ratio_quantity: 1,
      side: "sell"
    }],
    price: limitPrice,
    quantity: String(contracts),
    time_in_force: "gfd",
    trigger: "immediate",
    type: "limit",
    ref_id: crypto.randomUUID()
  };

  console.log(`[CLOSE] ${ticker} selling ${contracts}c — ${reason}`);
  const res = await authedRequest("POST", "/options/orders/", order, "json");
  if (res.id) return { ok: true, order_id: res.id, contracts, reason };
  console.log("[CLOSE_ERROR]", JSON.stringify(res));
  throw new Error(JSON.stringify(res));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getOptionOrder(orderId) {
  return await authedRequest("GET", "/options/orders/" + orderId + "/", null, "json");
}

function optionContractMultiplier(source) {
  var m = parseFloat((source && source.trade_value_multiplier) || 100);
  return m > 0 ? m : 100;
}

function orderContractQuantity(order) {
  var q = parseFloat((order && (order.processed_quantity || order.quantity)) || 1);
  return q > 0 ? q : 1;
}

function pickPerShareOptionPrice(raw, markHint, multiplier) {
  var v = parseFloat(raw);
  if (!v || v <= 0) return 0;
  multiplier = multiplier || 100;
  var asTotal = v / multiplier;
  if (markHint && markHint > 0) {
    if (Math.abs(asTotal - markHint) < Math.abs(v - markHint)) return asTotal;
    return v;
  }
  if (v >= 10 && asTotal >= 0.01 && asTotal <= 50) return asTotal;
  return v;
}

function fillPriceFromOrder(order) {
  if (!order) return 0;
  var legs = order.legs || [];
  for (var i = 0; i < legs.length; i++) {
    var ex = legs[i].executions || [];
    for (var j = 0; j < ex.length; j++) {
      var p = parseFloat(ex[j].price || 0);
      if (p > 0) return p;
    }
  }
  var limit = parseFloat(order.price || 0);
  var mult = optionContractMultiplier(order);
  var qty = orderContractQuantity(order);
  var premium = parseFloat(order.processed_premium || 0);
  if (premium > 0) return premium / (mult * qty);
  if (limit > 0) return limit;
  var avg = parseFloat(order.average_price || 0);
  if (avg > 0) return pickPerShareOptionPrice(avg, null, mult);
  return 0;
}

function perShareFromRhPosition(rhPos, markHint) {
  if (!rhPos) return 0;
  var mult = optionContractMultiplier(rhPos);
  var avg = parseFloat(rhPos.average_price || rhPos.pending_average_price || 0);
  if (avg > 0) return pickPerShareOptionPrice(avg, markHint, mult);
  return markHint && markHint > 0 ? markHint : 0;
}

async function waitForFillPrice(orderId, instrumentUrl, opts) {
  opts = opts || {};
  var maxWait = opts.maxWaitMs || 15000;
  var interval = opts.intervalMs || 500;
  var deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      var order = await getOptionOrder(orderId);
      if (order) {
        var state = (order.state || "").toLowerCase();
        var avg = fillPriceFromOrder(order);
        if (state === "filled" && avg > 0) return avg;
        if (state === "cancelled" || state === "rejected" || state === "failed") break;
      }
    } catch (e) {}
    await sleep(interval);
  }
  if (instrumentUrl) {
    var positions = await getOpenOptionPositions();
    var pos = positions.find(function(p) { return p.option === instrumentUrl; });
    if (pos) {
      var fromPos = parseFloat(pos.average_price || pos.pending_average_price || 0);
      if (fromPos > 0) return perShareFromRhPosition(pos, null);
    }
  }
  return 0;
}

async function refreshToken(refreshTokenValue, opts) {
  opts = opts || {};
  var deviceToken = opts.deviceToken || ensureDeviceToken();
  if (!deviceToken) {
    return { ok: false, error: "missing_device_token", invalid_grant: false };
  }

  var payload = {
    client_id: "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS",
    expires_in: 86400,
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    scope: "internal",
    device_token: deviceToken
  };
  try {
    var data = await request("POST", "/oauth2/token/", payload, null, "form");
    if (data.access_token) {
      _token = data.access_token;
      saveAuthSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshTokenValue,
        device_token: deviceToken
      });
      if (data.refresh_token) process.env.RH_REFRESH_TOKEN = data.refresh_token;
      console.log("[AUTH] Token refreshed successfully");
      return { ok: true, token: _token };
    }
    var errText = JSON.stringify(data);
    var invalidGrant = !!(data && data.error === "invalid_grant");
    if (invalidGrant && !opts.skipClear) clearAuthSession();
    return { ok: false, error: errText, invalid_grant: invalidGrant };
  } catch(err) {
    return { ok: false, error: err.message, invalid_grant: false };
  }
}

async function refreshWithStoredTokens() {
  ensureDeviceToken();
  var fileSession = readAuthFile();
  var fileRt = fileSession && fileSession.refresh_token;
  if (fileRt) {
    var fromFile = await refreshToken(fileRt, { deviceToken: fileSession.device_token });
    if (fromFile.ok) return fromFile;
    if (fromFile.invalid_grant) {
      console.log("[AUTH] Persisted refresh token rejected — trying Railway RH_REFRESH_TOKEN");
    } else if (fromFile.error === "missing_device_token") {
      console.log("[AUTH] No device_token on file — set RH_DEVICE_TOKEN or reconnect via dashboard");
    } else {
      return fromFile;
    }
  }

  var envRt = process.env.RH_REFRESH_TOKEN;
  if (envRt && envRt !== fileRt) {
    return refreshToken(envRt, { skipClear: true });
  }
  if (fileRt && !envRt) {
    return { ok: false, error: '{"error":"invalid_grant"}', invalid_grant: true };
  }
  return { ok: false, error: "no_refresh_token", invalid_grant: false };
}

// Read-only option pricing for the paper feed (no order placement involved).
// Uses authedRequest so an expired access token auto-refreshes.
async function getOptionMark(ticker, side, strike, expiry) {
  const optionType = side === "call" ? "call" : "put";
  const instrument = await getOptionInstrument(ticker, expiry, strike, optionType);
  if (!instrument) return null;
  const price = await getOptionMarkByUrl(instrument.url);
  return {
    price: price,
    instrument: instrument.url,
    strike: instrument.strike_price ? Math.round(parseFloat(instrument.strike_price)) : strike,
    expiry: instrument.expiration_date || expiry
  };
}

async function getOptionMarkByUrl(instrumentUrl) {
  const quoteRes = await authedRequest("GET", `/marketdata/options/?instruments=${encodeURIComponent(instrumentUrl)}`, null, "json");
  const r = quoteRes && quoteRes.results && quoteRes.results[0];
  if (!r) return null;
  let p = parseFloat(r.mark_price || r.adjusted_mark_price || r.last_trade_price || 0);
  if (!p || isNaN(p)) {
    const bid = parseFloat(r.bid_price || 0), ask = parseFloat(r.ask_price || 0);
    if (bid && ask) p = (bid + ask) / 2;
  }
  return p && !isNaN(p) ? p : null;
}

var _authCache = { at: 0, result: null };

async function checkAuthStatus() {
  if (!_token) return { ok: false, reason: "no_token" };
  var now = Date.now();
  if (_authCache.result && (now - _authCache.at) < 60000) return _authCache.result;
  var acct = process.env.RH_ACCOUNT_NUMBER;
  var path = acct ? "/accounts/" + acct + "/" : "/accounts/";
  var r = await rawRequest("GET", path, null, _token);
  var result = isAuthError(r) ? { ok: false, reason: "token_rejected" } : { ok: true };
  _authCache = { at: now, result: result };
  return result;
}

async function getOpenOptionPositions() {
  var fetched = await fetchOpenOptionPositions();
  return fetched.positions || [];
}

async function fetchOpenOptionPositions() {
  var path = "/options/positions/?nonzero=true";
  var acct = process.env.RH_ACCOUNT_NUMBER;
  if (acct) path += "&account_numbers=" + encodeURIComponent(acct);
  var all = [];
  var guard = 0;
  while (path && guard < 10) {
    guard++;
    var r = await rawRequest("GET", path, null, _token);
    if (isAuthError(r)) {
      console.log("[AUTH] Access token rejected on GET " + path + " — refreshing and retrying once");
      var ok = await reauthorize();
      if (!ok) return { ok: false, error: "auth_failed", positions: [] };
      r = await rawRequest("GET", path, null, _token);
      if (isAuthError(r)) return { ok: false, error: "auth_failed", positions: [] };
    }
    if (r.status < 200 || r.status >= 300) {
      var detail = (r.body && (r.body.detail || r.body.error)) || ("http_" + r.status);
      return { ok: false, error: String(detail), positions: [] };
    }
    var body = r.body || {};
    if (!Array.isArray(body.results) && body.next == null && body.previous == null && Object.keys(body).length && !body.results) {
      // Unexpected payload — don't pretend the account is flat
      return { ok: false, error: "invalid_positions_payload", positions: [] };
    }
    var page = body.results || [];
    for (var i = 0; i < page.length; i++) all.push(page[i]);
    var next = body.next || null;
    if (next) {
      try {
        var u = new URL(next);
        path = u.pathname + u.search;
      } catch (e) {
        path = null;
      }
    } else {
      path = null;
    }
  }
  return { ok: true, positions: all, error: null };
}

function optionPositionQty(p) {
  if (!p) return 0;
  var q = parseFloat(p.quantity);
  if (q > 0) return q;
  var pending = parseFloat(p.pending_buy_quantity || 0);
  return pending > 0 ? pending : 0;
}

function sameOptionUrl(a, b) {
  if (!a || !b) return false;
  var na = String(a).replace(/\/+$/, "");
  var nb = String(b).replace(/\/+$/, "");
  return na === nb;
}

module.exports = {
  login, setToken, getToken, setDeviceToken, refreshToken, refreshWithStoredTokens,
  getStoredRefreshToken, getStoredDeviceToken, clearAuthSession, reauthorize, checkAuthStatus,
  decodeJwtExp, getAccessTokenExpiryMs, needsProactiveRefresh,
  handleVerificationWorkflow, completeWorkflow,
  respondToSmsChallenge, waitForPushApproval,
  getQuote, placeOptionOrder, closeOptionPosition,
  getOptionOrder, waitForFillPrice, fillPriceFromOrder, perShareFromRhPosition,
  getOptionMark, getOptionMarkByUrl, getOpenOptionPositions, fetchOpenOptionPositions,
  optionPositionQty, sameOptionUrl
};
