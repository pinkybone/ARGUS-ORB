// API routes use WEBHOOK_SECRET / API_SECRET when set.
// Grok feed routes also accept GROK_API_SECRET (falls back to WEBHOOK_SECRET).
// TradingView POST /webhook is always open — no secret required.

function getSecret() {
  return process.env.WEBHOOK_SECRET || process.env.API_SECRET || null;
}

function getGrokSecret() {
  return process.env.GROK_API_SECRET || process.env.WEBHOOK_SECRET || process.env.API_SECRET || null;
}

function extractSecret(req) {
  return req.query.secret || req.headers["x-webhook-secret"] || req.headers["x-api-secret"] || null;
}

function requireSecret(req, res, next) {
  var secret = getSecret();
  if (!secret) return next();
  if (extractSecret(req) === secret) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function requireGrokSecret(req, res, next) {
  var secret = getGrokSecret();
  if (!secret) return next();
  if (extractSecret(req) === secret) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function allowTestRoutes() {
  return process.env.ALLOW_TEST_ROUTES === "1" || process.env.NODE_ENV !== "production";
}

module.exports = {
  requireSecret: requireSecret,
  requireGrokSecret: requireGrokSecret,
  allowTestRoutes: allowTestRoutes,
  getSecret: getSecret,
  getGrokSecret: getGrokSecret
};
