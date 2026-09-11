// Whop Software Licensing gate for the customer live ORB trader build.
// Buyer sets WHOP_LICENSE_KEY. Seller API key is baked at zip build time.
//
// Docs: https://docs.whop.com/supported-business-models/saas
// POST https://api.whop.com/api/v2/memberships/{licenseKey}/validate_license

var https = require("https");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

function reqUtil(name) {
  try {
    return require("./" + name);
  } catch (e) {
    return require(path.join(__dirname, "../../utils/" + name));
  }
}

var persist = reqUtil("persist");
var marketCal = reqUtil("marketCalendar");

var LICENSE_KEY_RE = /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
var DEVICE_ID_FILE = "whop-device-id";
var MARKET_OPEN_MIN = 9 * 60 + 30;   // 9:30 AM ET
var CHECK_T60_MIN = MARKET_OPEN_MIN - 60; // 8:30 AM ET
var CHECK_T1_MIN = MARKET_OPEN_MIN - 1;   // 9:29 AM ET

var _ok = false;
var _lastCheck = 0;
var _lastError = null;
var _scheduleTimer = null;
var _ranToday = {}; // ymd -> { t60: bool, t1: bool }

function readBakedConfig() {
  try {
    return require("../config/whop.baked.json");
  } catch (e) {
    return {};
  }
}

function allowedProductIds() {
  var baked = readBakedConfig();
  var ids = [];
  if (Array.isArray(baked.productIds)) ids = ids.concat(baked.productIds);
  else if (baked.productId) ids.push(baked.productId);
  return ids.filter(Boolean);
}

function isAllowedProductId(productId) {
  var allowed = allowedProductIds();
  if (!allowed.length) return true;
  return allowed.indexOf(productId) !== -1;
}

function etParts(date) {
  var d = date || new Date();
  var ymd = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  var time = d.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
  var parts = time.split(":");
  var hour = parseInt(parts[0], 10);
  if (hour === 24) hour = 0;
  return {
    ymd: ymd,
    minutes: hour * 60 + parseInt(parts[1], 10)
  };
}

function loadOrCreateDeviceId() {
  var fp = persist.filePath(DEVICE_ID_FILE);
  try {
    if (fs.existsSync(fp)) {
      var existing = fs.readFileSync(fp, "utf8").trim();
      if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
    }
  } catch (e) {}
  var id = crypto.randomBytes(16).toString("hex");
  try {
    fs.writeFileSync(fp, id + "\n");
    console.log("[LICENSE] Device id persisted at " + fp);
  } catch (e) {
    console.log("[LICENSE] Could not persist device id — using ephemeral id");
  }
  return id;
}

function machineId() {
  return loadOrCreateDeviceId();
}

function apiKey() {
  var baked = readBakedConfig();
  return process.env.WHOP_API_KEY || baked.apiKey || null;
}

function licenseKey() {
  return (process.env.WHOP_LICENSE_KEY || "").trim().toUpperCase();
}

function isLicenseKeyFormat(key) {
  return !!(key && LICENSE_KEY_RE.test(key));
}

function postValidate(license, token, metadata) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ metadata: metadata || {} });
    var req = https.request({
      hostname: "api.whop.com",
      path: "/api/v2/memberships/" + encodeURIComponent(license) + "/validate_license",
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, function(res) {
      var raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function getMembership(license, token) {
  return new Promise(function(resolve, reject) {
    var req = https.request({
      hostname: "api.whop.com",
      path: "/api/v2/memberships/" + encodeURIComponent(license),
      method: "GET",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json"
      }
    }, function(res) {
      var raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function moduleFingerprint() {
  try {
    var p = path.join(__dirname, "whopLicense.js");
    var buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch (e) {
    return null;
  }
}

function verifyIntegrity() {
  var baked = readBakedConfig();
  if (!baked.licenseModuleSha256) return true;
  var fp = moduleFingerprint();
  if (!fp || fp !== baked.licenseModuleSha256) {
    _lastError = "license_module_tampered";
    _ok = false;
    return false;
  }
  return true;
}

function parseMembershipStatus(body) {
  if (!body) return null;
  if (body.valid === false && body.status) return String(body.status).toLowerCase();
  if (body.status) return String(body.status).toLowerCase();
  if (body.membership && body.membership.status) return String(body.membership.status).toLowerCase();
  return null;
}

function parseProductId(body) {
  if (!body) return null;
  return body.product_id || body.product || body.access_pass ||
    (body.membership && (body.membership.product_id || body.membership.product)) || null;
}

function statusIsActive(st) {
  if (!st) return true;
  return st === "active" || st === "completed" || st === "trialing" || st === "valid";
}

async function validateNow() {
  if (!verifyIntegrity()) return false;
  var key = licenseKey();
  var token = apiKey();
  if (!key) {
    _ok = false;
    _lastError = "missing_WHOP_LICENSE_KEY";
    return false;
  }
  if (!isLicenseKeyFormat(key)) {
    _ok = false;
    _lastError = "invalid_WHOP_LICENSE_KEY_format";
    return false;
  }
  if (!token || token === "REPLACE_ME_SELLER_API_KEY") {
    _ok = false;
    _lastError = "missing_WHOP_API_KEY";
    return false;
  }
  try {
    var pre = await getMembership(key, token);
    if (pre.status === 200 && pre.body) {
      var preSt = parseMembershipStatus(pre.body);
      if (!statusIsActive(preSt)) {
        _ok = false;
        _lastError = "membership_status_" + (preSt || "unknown");
        _lastCheck = Date.now();
        return false;
      }
      var preProduct = parseProductId(pre.body);
      if (preProduct && !isAllowedProductId(preProduct)) {
        _ok = false;
        _lastError = "product_not_allowed_" + preProduct;
        _lastCheck = Date.now();
        return false;
      }
    }

    var res = await postValidate(key, token, {
      hwid: machineId(),
      app: "orb-live-trader",
      deploy: "railway"
    });
    if (res.status === 201 || res.status === 200) {
      var st = parseMembershipStatus(res.body);
      if (!statusIsActive(st)) {
        _ok = false;
        _lastError = "membership_status_" + (st || "unknown");
        _lastCheck = Date.now();
        return false;
      }
      var productId = parseProductId(res.body);
      if (!productId && allowedProductIds().length) {
        var mem = pre.status === 200 ? pre : await getMembership(key, token);
        if (mem.status === 200 && mem.body) {
          productId = parseProductId(mem.body);
          st = parseMembershipStatus(mem.body) || st;
          if (!statusIsActive(st)) {
            _ok = false;
            _lastError = "membership_status_" + (st || "unknown");
            _lastCheck = Date.now();
            return false;
          }
        }
      }
      if (productId && !isAllowedProductId(productId)) {
        _ok = false;
        _lastError = "product_not_allowed_" + productId;
        _lastCheck = Date.now();
        return false;
      }
      _ok = true;
      _lastError = null;
      _lastCheck = Date.now();
      return true;
    }
    _ok = false;
    var errRaw = (res.body && (res.body.error || res.body.message)) || "";
    var errMsg = typeof errRaw === "object" ? (errRaw.message || JSON.stringify(errRaw)) : String(errRaw);
    _lastError = "whop_http_" + res.status + (errMsg ? (":" + errMsg) : "");
    _lastCheck = Date.now();
    return false;
  } catch (e) {
    _ok = false;
    _lastError = e.message || "whop_network_error";
    _lastCheck = Date.now();
    return false;
  }
}

function isLicensed() {
  return !!_ok;
}

function lastError() {
  return _lastError;
}

function requireLicense(action) {
  if (!verifyIntegrity() || !_ok) {
    var err = new Error("Whop license required" + (_lastError ? (" (" + _lastError + ")") : "")
      + (action ? (" — blocked: " + action) : ""));
    err.code = "WHOP_LICENSE";
    throw err;
  }
}

function todayChecks(ymd) {
  if (!_ranToday[ymd]) _ranToday[ymd] = { t60: false, t1: false };
  return _ranToday[ymd];
}

function slotDue(minutesNow, targetMin, alreadyRan) {
  return !alreadyRan && minutesNow >= targetMin && minutesNow < targetMin + 2;
}

async function tickPremarketChecks() {
  var now = new Date();
  if (!marketCal.isTradingDayET(now)) return;
  var ep = etParts(now);
  var ran = todayChecks(ep.ymd);
  if (slotDue(ep.minutes, CHECK_T60_MIN, ran.t60)) {
    ran.t60 = true;
    await runScheduledCheck({ ymd: ep.ymd, tag: "t60", label: "T-60m (8:30 ET)" });
    return;
  }
  if (slotDue(ep.minutes, CHECK_T1_MIN, ran.t1)) {
    ran.t1 = true;
    await runScheduledCheck({ ymd: ep.ymd, tag: "t1", label: "T-1m (9:29 ET)" });
  }
}

async function runScheduledCheck(meta) {
  console.log("[LICENSE] Premarket Whop validation (" + (meta && meta.label ? meta.label : "scheduled") + ")");
  var still = await validateNow();
  if (!still) {
    console.error("[LICENSE] Validation failed: " + (_lastError || "unknown") + " — shutting down");
    process.exit(1);
  }
  console.log("[LICENSE] Premarket validation OK");
}

async function startLicenseGate() {
  var ok = await validateNow();
  if (!ok) {
    console.error("[LICENSE] Whop validation failed: " + (_lastError || "unknown"));
    console.error("[LICENSE] Set WHOP_LICENSE_KEY from your Whop purchase (dash-separated, uppercase).");
    process.exit(1);
  }
  console.log("[LICENSE] Whop license OK (device id on volume: " + machineId().slice(0, 8) + "…)");
  console.log("[LICENSE] Daily checks at 8:30 ET and 9:29 ET on trading days");
  if (_scheduleTimer) clearInterval(_scheduleTimer);
  _scheduleTimer = setInterval(function() {
    tickPremarketChecks().catch(function(e) {
      console.error("[LICENSE] Premarket tick error: " + e.message);
    });
  }, 30 * 1000);
  return true;
}

module.exports = {
  startLicenseGate: startLicenseGate,
  validateNow: validateNow,
  requireLicense: requireLicense,
  isLicensed: isLicensed,
  lastError: lastError,
  machineId: machineId,
  moduleFingerprint: moduleFingerprint,
  verifyIntegrity: verifyIntegrity,
  isLicenseKeyFormat: isLicenseKeyFormat,
  isAllowedProductId: isAllowedProductId,
  allowedProductIds: allowedProductIds,
  slotDue: slotDue,
  etParts: etParts,
  LICENSE_KEY_RE: LICENSE_KEY_RE,
  CHECK_T60_MIN: CHECK_T60_MIN,
  CHECK_T1_MIN: CHECK_T1_MIN
};
