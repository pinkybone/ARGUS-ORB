var rh = require("./robinhood");
var stateModule = require("./state");

var pendingWorkflow = null;

async function refreshAccessToken() {
  if (!rh.getStoredRefreshToken()) return false;
  try {
    stateModule.logEvent("AUTH", "Refreshing access token...");
    var result = await rh.refreshWithStoredTokens();
    if (result.ok) {
      stateModule.logEvent("AUTH", "Token refreshed successfully");
      return true;
    }
    if (result.invalid_grant) {
      stateModule.logEvent("AUTH_ERROR", "Refresh token expired — reconnect or paste fresh RH_TOKEN + RH_REFRESH_TOKEN + RH_DEVICE_TOKEN from the same login");
    } else if (result.error === "missing_device_token") {
      stateModule.logEvent("AUTH_ERROR", "Refresh needs RH_DEVICE_TOKEN — reconnect via dashboard or add it in Railway");
    } else {
      stateModule.logEvent("AUTH_ERROR", "Token refresh failed: " + result.error);
    }
    return false;
  } catch (err) {
    stateModule.logEvent("AUTH_ERROR", "Token refresh error: " + err.message);
    return false;
  }
}

async function verifyCurrentToken() {
  if (!rh.getToken()) return false;
  var status = await rh.checkAuthStatus();
  if (status.ok) return true;
  stateModule.logEvent("AUTH_ERROR", "Access token rejected — update RH_TOKEN or refresh token in Railway");
  rh.setToken(null);
  return false;
}

async function ensureLoggedIn() {
  rh.getStoredDeviceToken();

  var storedToken = process.env.RH_TOKEN;
  if (storedToken) {
    rh.setToken(storedToken);
    if (await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Using stored RH_TOKEN — verified");
      return true;
    }
    stateModule.logEvent("AUTH_ERROR", "RH_TOKEN in Railway is expired — trying refresh");
    rh.setToken(null);
  } else if (rh.getToken()) {
    if (await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Session verified");
      return true;
    }
    rh.setToken(null);
  }

  if (rh.getStoredRefreshToken()) {
    var refreshed = await refreshAccessToken();
    if (refreshed && await verifyCurrentToken()) return true;
  }

  if (storedToken) {
    rh.setToken(storedToken);
    if (await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Using stored RH_TOKEN — verified");
      return true;
    }
    stateModule.logEvent("AUTH_ERROR", "RH_TOKEN in Railway is expired — paste a fresh token");
  }

  var email = process.env.RH_EMAIL;
  var password = process.env.RH_PASSWORD;
  var mfa = process.env.RH_MFA_CODE;

  if (!email || !password) {
    stateModule.logEvent("AUTH_ERROR", "No valid token — set RH_TOKEN or RH_EMAIL/RH_PASSWORD in Railway");
    return false;
  }

  stateModule.logEvent("AUTH", "Logging into Robinhood...");
  var result = await rh.login(email, password, mfa);

  if (result.ok && await verifyCurrentToken()) {
    stateModule.logEvent("AUTH", "Login successful");
    pendingWorkflow = null;
    return true;
  }

  if (result.verification_workflow) {
    stateModule.logEvent("AUTH", "Robinhood verification required — checking for challenge...");
    try {
      var challenge = await rh.handleVerificationWorkflow(result.device_token, result.workflow_id);
      pendingWorkflow = {
        challenge_id: challenge.challenge_id,
        challenge_type: challenge.challenge_type,
        machine_id: challenge.machine_id,
        device_token: result.device_token,
        workflow_id: result.workflow_id,
        email: email,
        password: password
      };

      if (challenge.challenge_type === "prompt") {
        stateModule.logEvent("AUTH", "Push notification sent — tap Approve on your Robinhood app");
        var approved = await rh.waitForPushApproval(challenge.challenge_id);
        if (approved) {
          await rh.completeWorkflow(challenge.machine_id);
          var retry = await rh.login(email, password, mfa);
          if (retry.ok && await verifyCurrentToken()) {
            stateModule.logEvent("AUTH", "Login successful after push approval");
            pendingWorkflow = null;
            return true;
          }
        }
      } else if (challenge.challenge_type === "sms" || challenge.challenge_type === "email") {
        stateModule.logEvent("AUTH_CHALLENGE", "SMS/email code required — enter it in the dashboard");
      }
    } catch (err) {
      stateModule.logEvent("AUTH_ERROR", "Verification failed: " + err.message);
    }
    return false;
  }

  if (result.mfa_required) {
    stateModule.logEvent("AUTH_ERROR", "MFA required — add RH_MFA_CODE to Railway variables");
    return false;
  }

  stateModule.logEvent("AUTH_ERROR", "Login failed: " + (result.error || "unknown"));
  return false;
}

async function submitSmsCode(code) {
  if (!pendingWorkflow) return { ok: false, error: "No pending verification" };
  try {
    await rh.respondToSmsChallenge(pendingWorkflow.challenge_id, code);
    await rh.completeWorkflow(pendingWorkflow.machine_id);
    var retry = await rh.login(pendingWorkflow.email, pendingWorkflow.password);
    if (retry.ok && await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Login successful after SMS code");
      pendingWorkflow = null;
      return { ok: true };
    }
    return { ok: false, error: "Login failed after SMS code" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getPendingWorkflow() { return pendingWorkflow; }

function scheduleDailyReauth() {
  var exitlogic = require("./exitlogic");
  stateModule.logEvent("AUTH", "Daily reauth scheduler started (9:00 AM ET)");
  function scheduleNext() {
    var delay = exitlogic.msUntilNextTradingTimeET(9, 0);
    stateModule.logEvent("AUTH", "Next reauth in " + Math.round(delay / 60000) + " min");
    setTimeout(async function() {
      var refreshed = await refreshAccessToken();
      if (!refreshed) await ensureLoggedIn();
      else await verifyCurrentToken();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

function scheduleProactiveRefresh() {
  var CHECK_MS = 60 * 60 * 1000;
  var refreshBusy = false;
  async function check() {
    if (refreshBusy) return;
    if (!rh.needsProactiveRefresh()) return;
    refreshBusy = true;
    try {
      stateModule.logEvent("AUTH", "Proactive token refresh (expiring within 24h)");
      await refreshAccessToken();
    } finally {
      refreshBusy = false;
    }
  }
  setInterval(check, CHECK_MS);
  setTimeout(check, 15000);
  console.log("[AUTH] Proactive refresh check every " + (CHECK_MS / 60000) + " min");
}

async function getAuthInfo() {
  var pending = !!pendingWorkflow;
  var refreshReady = !!(rh.getStoredRefreshToken() && rh.getStoredDeviceToken());
  if (!rh.getToken()) {
    return {
      logged_in: false, verified: false, pending: pending,
      status: pending ? "pending_verification" : "disconnected",
      refresh_ready: refreshReady
    };
  }
  var status = await rh.checkAuthStatus();
  if (status.ok) {
    return {
      logged_in: true, verified: true, pending: pending, status: "connected",
      refresh_ready: refreshReady
    };
  }
  return {
    logged_in: false, verified: false, pending: pending, status: "token_expired",
    refresh_ready: refreshReady
  };
}

module.exports = {
  ensureLoggedIn: ensureLoggedIn,
  submitSmsCode: submitSmsCode,
  getPendingWorkflow: getPendingWorkflow,
  scheduleDailyReauth: scheduleDailyReauth,
  scheduleProactiveRefresh: scheduleProactiveRefresh,
  getAuthInfo: getAuthInfo,
  verifyCurrentToken: verifyCurrentToken
};
