#!/usr/bin/env bash
# Build a LIVE-ONLY Whop customer zip (no Discord paper trading).
# Output: /opt/cursor/artifacts/orb-live-whop-customer/ + .zip
# NOT published to GitHub as a customer repo — zip/folder only.
#
# Required to bake seller credentials:
#   WHOP_API_KEY   — Dashboard → Developer → API keys (Bearer token)
#   optional WHOP_PRODUCT_ID — single prod_… override
#   optional WHOP_PRODUCT_IDS — comma-separated prod_… list (default: whop-products.json)
#
# Buyer later sets only:
#   WHOP_LICENSE_KEY — from their Whop Software Licensing purchase

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_ROOT="${CUSTOMER_OUT:-/opt/cursor/artifacts}"
DEST="$OUT_ROOT/orb-live-whop-customer"
ZIP="$OUT_ROOT/orb-live-whop-customer.zip"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -z "${WHOP_API_KEY:-}" ]]; then
  echo "WARNING: WHOP_API_KEY not set — baking placeholder. Rebuild with a real key before selling."
  WHOP_API_KEY="REPLACE_ME_SELLER_API_KEY"
fi

rm -rf "$DEST"
mkdir -p "$DEST/utils" "$DEST/routes" "$DEST/dashboard" "$DEST/config" "$DEST/scripts"

# Core live runtime
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/railway.toml" "$DEST/" 2>/dev/null || cp "$ROOT/package.json" "$DEST/"
cp "$ROOT/server.js" "$DEST/"
cp -R "$ROOT/routes/." "$DEST/routes/"
cp -R "$ROOT/utils/." "$DEST/utils/"
cp -R "$ROOT/dashboard/." "$DEST/dashboard/"

# Whop license module
cp "$ROOT/scripts/whop-customer-templates/whopLicense.js" "$DEST/utils/whopLicense.js"

# Strip Discord paper trading from customer build
rm -f "$DEST/utils/discord.js" "$DEST/utils/paperLegs.js" "$DEST/utils/closeDigest.js"

# Neutralize Discord requires in alert.js / server.js without breaking live path
python3 - "$DEST" <<'PY'
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])

alert = root / "routes" / "alert.js"
t = alert.read_text()
t = re.sub(
    r'var discord = null;\ntry \{ discord = require\("\.\./utils/discord"\); \} catch \(e\) \{ discord = null; \}\n',
    "var discord = null; // Discord paper trading removed in Whop customer build\n",
    t,
)
t = t.replace(
"""async function notify(fn, args) {
  try {
    if (discord && typeof discord[fn] === "function") return await discord[fn].apply(null, args);
  } catch (e) { console.log("[DISCORD_NOTIFY_ERROR] " + fn + ": " + e.message); }
}""",
"""async function notify(fn, args) {
  return null; // Discord paper trading removed in Whop customer build
}""")
alert.write_text(t)

server = root / "server.js"
s = server.read_text()
s = s.replace('const discord = require("./utils/discord");\n',
              'const whopLicense = require("./utils/whopLicense");\n')
s = s.replace("  discord.initChannels(rh.getToken.bind(rh));\n",
              "  // Discord paper trading removed in Whop customer build\n")
if "whopLicense.startLicenseGate" not in s:
  s = s.replace(
    "app.listen(PORT, async () => {\n  console.log(\"ORB server listening on port \" + PORT);",
    "app.listen(PORT, async () => {\n  await whopLicense.startLicenseGate();\n  console.log(\"ORB server listening on port \" + PORT);"
  )
s = s.replace("var posted = await discord.postSundayPremarket(ch);",
              "var posted = [];")
s = s.replace("var posted = await discord.postExistingOrbs(force);",
              "var posted = [];")
server.write_text(s)
print("patched alert/server")
PY

# Stub remaining discord references for optional test routes
python3 - "$DEST" <<'PY'
import pathlib, sys
server = pathlib.Path(sys.argv[1]) / "server.js"
s = server.read_text()
if "discord." in s and "const discord =" not in s and "var discord =" not in s:
    s = s.replace(
        'const whopLicense = require("./utils/whopLicense");\n',
        'const whopLicense = require("./utils/whopLicense");\n'
        'const discord = { postSundayPremarket: async () => [], postExistingOrbs: async () => [], '
        'postGoodMorning: async () => {}, postDailySummary: async () => {}, postExpectedMoves: async () => {}, '
        'postCloseDigest: async () => {}, postOpenPositions: async () => {}, postEntry: async () => {}, '
        'postStopLoss: async () => {}, postProfitTier: async () => {}, getChannels: () => [], '
        'initChannels: () => {} };\n'
    )
if "await whopLicense.startLicenseGate()" not in s:
    s = s.replace(
        "app.listen(PORT, async () => {\n  console.log(\"ORB server listening on port \" + PORT);",
        "app.listen(PORT, async () => {\n  await whopLicense.startLicenseGate();\n  console.log(\"ORB server listening on port \" + PORT);"
    )
server.write_text(s)
print("server discord stub ready")
PY

python3 - "$DEST" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
trayd = root / "utils" / "trayd.js"
tt = trayd.read_text()
if "whopLicense" not in tt:
  tt = "var whopLicense = require(\"./whopLicense\");\n" + tt
  tt = tt.replace(
    "async function placeOrder(opts) {\n",
    "async function placeOrder(opts) {\n  whopLicense.requireLicense(\"place_order\");\n"
  )
  tt = tt.replace(
    "async function closePartialPosition(opts) {\n",
    "async function closePartialPosition(opts) {\n  whopLicense.requireLicense(\"close_order\");\n"
  )
  trayd.write_text(tt)

pm = root / "utils" / "profitmanager.js"
p = pm.read_text()
if "whopLicense" not in p:
  p = "var whopLicense = require(\"./whopLicense\");\n" + p
  p = p.replace(
    "async function checkProfitTiers() {\n  if (!exitlogic.isRegularMarketHours()) return;\n",
    "async function checkProfitTiers() {\n  if (!whopLicense.isLicensed()) return;\n  if (!exitlogic.isRegularMarketHours()) return;\n"
  )
  pm.write_text(p)
print("patched trayd/profitmanager")
PY

# Bake seller API key + integrity hash
python3 - <<PY
import json, hashlib, pathlib, os
dest = pathlib.Path("$DEST")
root = pathlib.Path("$ROOT")
lic = (dest / "utils" / "whopLicense.js").read_bytes()
sha = hashlib.sha256(lic).hexdigest()
catalog_path = root / "scripts" / "whop-customer-templates" / "whop-products.json"
catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {}

if os.environ.get("WHOP_PRODUCT_IDS"):
  product_ids = [p.strip() for p in os.environ["WHOP_PRODUCT_IDS"].split(",") if p.strip()]
elif os.environ.get("WHOP_PRODUCT_ID"):
  product_ids = [os.environ["WHOP_PRODUCT_ID"].strip()]
else:
  product_ids = [p["id"] for p in catalog.get("products", []) if p.get("id")]

company_id = catalog.get("companyId") or ""

cfg = {
  "apiKey": """$WHOP_API_KEY""",
  "productIds": product_ids,
  "productId": product_ids[0] if len(product_ids) == 1 else "",
  "companyId": company_id,
  "licenseModuleSha256": sha,
  "builtAt": "$STAMP",
  "build": "whop-customer-live"
}
(dest / "config" / "whop.baked.json").write_text(json.dumps(cfg, indent=2) + "\n")
print("baked whop config sha=", sha[:16], "products=", len(product_ids))
PY

# Customer env example + setup
cat > "$DEST/.env.example" <<'EOF'
# === Whop (required) ===
# Paste the license key from your Whop purchase (Software Licensing).
# Format: uppercase letters/numbers with dashes, e.g. T-D9825F-713A53FD-DD2E4CW
WHOP_LICENSE_KEY=

# === Robinhood ===
RH_TOKEN=
RH_REFRESH_TOKEN=
RH_DEVICE_TOKEN=
RH_ACCOUNT_NUMBER=

# === App ===
PORT=3000
WEBHOOK_SECRET=
# Optional: enable next-phase live tickers after you confirm RH chains
# LIVE_TICKERS=QQQ,SPX
EOF

cat > "$DEST/WHOP-SETUP.md" <<'EOF'
# ORB Live Trader — Whop Customer Build

Live Robinhood ORB trader only. **No Discord paper trading.**

## Keys you need (seller / Whop dashboard)

1. **API key** (Bearer) — Dashboard → **Developer → API keys**  
   Used at zip **build** time (`WHOP_API_KEY`). Baked into `config/whop.baked.json`.
2. **Software Licensing** — add the Software app on your Whop product and enable license keys.  
   Each buyer gets a **license key** after purchase.
3. **Product IDs** `prod_…` — baked at build from `scripts/whop-customer-templates/whop-products.json` (all AI Orb Trader Pro tiers).

Buyers only paste **`WHOP_LICENSE_KEY`** into Railway / `.env`.

> If your dashboard labels look like a “Token” and another credential, use the **API key** as `WHOP_API_KEY` when you rebuild the zip, and give customers their **license key**.

## Buyer install

1. Unzip and deploy (Railway recommended) with a volume at `/data`.
2. Set env from `.env.example` (especially `WHOP_LICENSE_KEY` + Robinhood tokens).
3. Start: `npm install && npm start`
4. On boot the app validates the license with Whop (binds a stable device id stored on your `/data` volume).
5. **Every trading day** at **8:30 AM ET** and **9:29 AM ET** the app re-validates with Whop.
6. If license fails or is revoked, the process **exits** and live orders are blocked.

## Anti-tamper (practical)

- License check on startup (process exits if invalid)
- Re-check **8:30 ET** and **9:29 ET** every trading day (process exits if invalid)
- Device id persisted at `/data/whop-device-id` (survives Railway redeploys on the same volume)
- Live place/close orders call `requireLicense`
- Profit manager no-ops if unlicensed
- `config/whop.baked.json` stores a SHA-256 of `utils/whopLicense.js` — if that file is edited/deleted, integrity fails and the app refuses to run

This is Node software: determined reverse-engineering can still bypass client checks. For stronger control, add a small license relay you host that holds the API key.

## Next phase (live QQQ / SPX)

Set `LIVE_TICKERS=QQQ,SPX` only after confirming Robinhood option chains and sizing for those symbols on the buyer account. SPX index options availability varies by RH account.
EOF

cat > "$DEST/README.md" <<'EOF'
# ORB Live Trader (Whop)

Live-only ORB auto-trader for Robinhood. Requires an active Whop license key.

See **WHOP-SETUP.md** for keys and deploy steps.

Before selling: open `config/whop.baked.json` and replace `REPLACE_ME_SELLER_API_KEY` with your Whop seller API key (`apik_…`), or run `bash inject-whop-api-key.sh` from this folder.
EOF

cp "$ROOT/scripts/inject-whop-api-key.sh" "$DEST/inject-whop-api-key.sh"
chmod +x "$DEST/inject-whop-api-key.sh"

# Zip
rm -f "$ZIP"
( cd "$OUT_ROOT" && zip -qr "$(basename "$ZIP")" "$(basename "$DEST")" )
echo "Built: $DEST"
echo "Zip:   $ZIP ($(du -h "$ZIP" | awk '{print $1}'))"
ls -la "$DEST/utils/whopLicense.js" "$DEST/config/whop.baked.json"
