#!/usr/bin/env bash
# Run once after unzipping the customer package — paste your seller Whop API key.
# Usage: bash inject-whop-api-key.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/config/whop.baked.json"
if [[ ! -f "$CFG" ]]; then
  echo "Error: config/whop.baked.json not found. Run this from the unzipped customer folder."
  exit 1
fi
echo "Paste your Whop seller API key (apik_…), then press Enter:"
read -r KEY
KEY="$(echo "$KEY" | tr -d '[:space:]')"
if [[ -z "$KEY" ]]; then
  echo "No key entered."
  exit 1
fi
python3 - "$CFG" "$KEY" <<'PY'
import json, sys
path, key = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
cfg["apiKey"] = key
json.dump(cfg, open(path, "w"), indent=2)
open(path, "a").write("\n")
print("Updated", path)
PY
echo "Done. Deploy this folder to Railway (or re-zip and upload to Whop)."
