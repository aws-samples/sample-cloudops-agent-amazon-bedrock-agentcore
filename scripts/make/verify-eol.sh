#!/usr/bin/env bash
# Populate and verify the EOL lookup table after the backend is deployed.
#
# A Lambda StatusCode of 200 only means the invocation protocol completed — it
# does NOT prove the data was populated. This checks the function's actual
# result: no FunctionError, a nonzero unique_records count, per-service coverage,
# and a nonzero row count in the DynamoDB table.
#
# Usage: verify-eol.sh <region>
set -euo pipefail

REGION="${1:?region required}"

echo "Resolving EOL scraper function from CloudOpsMCPRuntimeStack outputs..."
FN="$(aws cloudformation describe-stacks --stack-name CloudOpsMCPRuntimeStack --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='EolScraperFunctionName'].OutputValue | [0]" --output text 2>/dev/null || true)"
{ [ -n "$FN" ] && [ "$FN" != "None" ]; } \
  || { echo "ERROR: EolScraperFunctionName output not found. Is the backend fully deployed?"; exit 1; }
echo "EOL scraper: ${FN}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Invoking the scraper once to populate the table..."
# Force --output json so the invoke *metadata* is JSON regardless of the caller's
# configured default output format. With a `text` default the CLI prints the
# metadata as "$LATEST<TAB>200", which is not JSON and previously broke the
# verification below.
aws lambda invoke --function-name "$FN" --region "$REGION" --output json "$TMP/result.json" > "$TMP/invoke.json"

echo "Verifying the function result (not just HTTP 200)..."
python3 - "$TMP" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
meta = json.loads((root / 'invoke.json').read_text())
result = json.loads((root / 'result.json').read_text())
assert 'FunctionError' not in meta, f"Lambda reported FunctionError: {meta}"
assert result.get('unique_records', 0) > 0, f"No EOL records were populated: {result}"
required = ('eks', 'rds', 'elasticache', 'opensearch', 'msk')
missing = [s for s in required if result.get('by_service', {}).get(s, 0) <= 0]
assert not missing, f"Missing EOL coverage for services {missing}; result={result}"
print(json.dumps(result, indent=2))
PY

echo "Confirming the DynamoDB table has rows..."
TABLE="$(aws lambda get-function-configuration --function-name "$FN" --region "$REGION" \
  --query 'Environment.Variables.EOL_TABLE_NAME' --output text 2>/dev/null || true)"
{ [ -n "$TABLE" ] && [ "$TABLE" != "None" ]; } \
  || { echo "ERROR: could not resolve EOL_TABLE_NAME from the function configuration."; exit 1; }
COUNT="$(aws dynamodb scan --table-name "$TABLE" --region "$REGION" --select COUNT --query 'Count' --output text 2>/dev/null || echo 0)"
echo "EOL table ${TABLE} row count: ${COUNT}"
{ [ "$COUNT" -gt 0 ]; } 2>/dev/null \
  || { echo "ERROR: EOL table '${TABLE}' is empty after invocation."; exit 1; }

echo "EOL verification passed."
