#!/usr/bin/env bash
# Bake the deployed FrontEndConfig into the frontend bundle so the hosted app is
# login-first (issue #23): users open the URL and sign in without a setup screen.
#
# Writes frontend/public/app-config.json, which Vite copies to the site root at
# build time. Run this BEFORE building/zipping the frontend (e.g. before
# `npm run zip`). Read-only against AWS.
#
# The published file contains only non-secret values from the stack output
# (Cognito pool IDs, the AgentCore runtime ARN, the Conversation History API URL,
# and Regions). It must never contain passwords, tokens, or OAuth secrets.
#
# Usage:
#   AWS_REGION=<region> [AWS_PROFILE=<profile>] scripts/generate-frontend-config.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[ -n "$REGION" ] || { echo "ERROR: set AWS_REGION (or a default CLI region)." >&2; exit 1; }

echo "Reading FrontEndConfig from CloudOpsConversationHistoryStack (region ${REGION})..."
CFG="$(aws cloudformation describe-stacks --stack-name CloudOpsConversationHistoryStack --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontEndConfig'].OutputValue | [0]" --output text 2>/dev/null || true)"
{ [ -n "$CFG" ] && [ "$CFG" != "None" ]; } \
  || { echo "ERROR: FrontEndConfig output not found. Deploy the backend first (make deploy)." >&2; exit 1; }

OUT_DIR="$ROOT/frontend/public"
OUT="$OUT_DIR/app-config.json"
mkdir -p "$OUT_DIR"

# Validate it parses as JSON and pretty-print it. python3 also fails loudly if
# the output is not valid JSON, so we never write a malformed config file.
if ! printf '%s' "$CFG" | python3 -m json.tool > "$OUT" 2>/dev/null; then
  echo "ERROR: FrontEndConfig output is not valid JSON; refusing to write ${OUT}." >&2
  rm -f "$OUT"
  exit 1
fi

echo "Wrote ${OUT}"
echo "The next frontend build (npm run zip / make frontend) will include it, making the hosted app login-first."
