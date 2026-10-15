#!/usr/bin/env bash
# Run the actual new UI, agent entrypoint, and history handler without deploying AWS.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/common.sh"
require_aws_context
banner "LOCAL DEV — AWS account ${ACCOUNT_ID} / region ${REGION}"
echo "Live services: Cognito, Bedrock, Gateway, Memory. Model/tool calls may incur charges."
echo "Local: UI :5173, AgentCore/history :8080, disposable DynamoDB history."
echo "No cloud resources are created or deployed. History resets on backend restart."
export AWS_REGION="$REGION"
export VITE_LOCAL_API=1
cd "$REPO_ROOT"

cleanup() {
  kill "${FRONTEND_PID:-}" "${BACKEND_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
uv run --directory "$HERE/../dev" --locked uvicorn local_dev:create_app --factory \
  --app-dir "$REPO_ROOT/scripts" --host 127.0.0.1 --port 8080 \
  --reload --reload-dir "$REPO_ROOT/agentcore" --reload-dir "$REPO_ROOT/cdk/lambda/conversations" \
  --reload-dir "$REPO_ROOT/scripts" --no-access-log &
BACKEND_PID=$!
npm --prefix "$REPO_ROOT/frontend" run dev -- --host 127.0.0.1 --port 5173 &
FRONTEND_PID=$!
# Bash 3 (macOS) has no wait -n; monitor only these owned server processes.
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
