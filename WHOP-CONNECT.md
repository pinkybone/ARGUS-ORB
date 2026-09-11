# Connecting Whop to the customer build

There is no OAuth “connect Cursor to Whop” flow. You provide credentials once; we bake and test locally.

## What you send (seller only — never give customers the API key)

| Variable | Where | Who sets it |
|----------|-------|-------------|
| `WHOP_API_KEY` | Whop → **Developer → API keys** (Bearer) | You, at **zip build** time |
| `WHOP_LICENSE_KEY` | Buyer’s Whop order / license page | **Customer** on Railway |

**Product IDs** (`prod_…`) are seller-side — already configured for **TRADING CHEAT CODES** in `scripts/whop-customer-templates/whop-products.json`:

| Plan | Product ID |
|------|------------|
| AI Orb Trader Pro - Monthly | `prod_qp6ewBBRjFpze` |
| AI Orb Trader Pro - Quarterly | `prod_yRonAi2q3pr17` |
| AI Orb Trader Pro - Bi-Annual | `prod_Waf5KonDMGcc1` |
| AI Orb Trader Pro - Yearly | `prod_ffd2vAuWFMXaN` |

Company: **TRADING CHEAT CODES** (`biz_WtV0OPGXfsal8r`)

Customers do **not** paste product IDs — they paste their **license key** after purchase (any of the four plans above).

## How to share with the agent / build

**Option A — paste in chat (fastest for a test build)**

```
WHOP_API_KEY=your_bearer_token
TEST_LICENSE_KEY=XXXXXX-XXXXXX-XXXXXX
```

**Option B — Railway env on your seller/deploy project**

Set `WHOP_API_KEY` in Railway variables, then ask the agent to rebuild:

```bash
WHOP_API_KEY="$WHOP_API_KEY" bash scripts/build-whop-customer.sh
```

Output: `/opt/cursor/artifacts/orb-live-whop-customer.zip`

## Whop product setup checklist

1. Add **Software Licensing** to each product (or shared licensing experience).
2. Enable license keys for buyers.
3. Create a **test purchase** (or comp yourself) to get a real `XXXXXX-XXXXXX-XXXXXX` key.
4. Rebuild the zip with your real `WHOP_API_KEY` (not `REPLACE_ME_SELLER_API_KEY`).

## Customer experience

1. Buy any plan on Whop → copy license key.
2. Deploy zip on Railway with volume at `/data`.
3. Set `WHOP_LICENSE_KEY` + Robinhood env vars.
4. Boot validates license; device id saved to `/data/whop-device-id`.
5. Re-validates **8:30 ET** and **9:29 ET** each trading day; process exits if invalid.

## If a customer redeploys

Same volume → same device id → license still binds.  
New volume → Whop may treat as new machine; buyer resets metadata from their Whop order page if needed.
