#!/usr/bin/env bash
# `make check`: verify prerequisites for provisioning this sample.
#
# This is a preflight only — it inspects tools, AWS authentication/identity, the
# selected Region, and the CloudWatch Transaction Search prerequisite, and
# prints actionable guidance. It installs nothing, configures nothing, and makes
# no AWS mutations. Hard prerequisites (tools/auth/region) fail the check;
# account-level items it cannot safely change (model access, Transaction Search)
# are reported as warnings.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/make/common.sh
. "$HERE/common.sh"

banner "CHECK — prerequisites (no changes are made)"

fail=0

# --- Required command-line tools ---
echo "Tools:"
for tool in node npm aws uv zip git python3; do
  if have "$tool"; then
    note "OK    $tool ($($tool --version 2>&1 | head -1))"
  else
    note "MISS  $tool — install it (see the README Prerequisites)."
    fail=1
  fi
done

# Node major version (README targets Node 22 LTS).
if have node; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "${node_major:-0}" -lt 18 ] 2>/dev/null; then
    note "MISS  Node $node_major is too old; use Node 22 LTS."
    fail=1
  elif [ "${node_major:-0}" -ne 22 ] 2>/dev/null; then
    warn "Node major is $node_major; the sample is validated on Node 22 LTS."
  fi
fi

# Container runtime for CDK asset bundling — OPTIONAL for this sample.
# The only Docker-bundled asset (the EOL scraper Lambda) has a local bundling
# fallback that installs its pure-Python deps with python3/pip, so CDK only
# falls back to a container when local bundling is unavailable. The four MCP
# images build in CodeBuild, not locally. So a running container runtime is
# nice-to-have, not required — this is reported as a warning, never a failure.
echo ""
echo "Container runtime (optional — EOL scraper bundles locally via python3/pip):"
if [ -n "${CDK_DOCKER:-}" ]; then
  note "INFO  CDK_DOCKER=${CDK_DOCKER} (CDK will use this runtime for any container bundling)"
  if [ "${CDK_DOCKER}" = "finch" ]; then
    if have finch && finch vm status 2>/dev/null | grep -qi 'running'; then
      note "OK    finch VM is running"
    else
      warn "CDK_DOCKER=finch but the Finch VM is not running. Run 'finch vm init' (first time) or 'finch vm start'. Not required unless local Python bundling is unavailable."
    fi
  fi
elif have docker && docker info >/dev/null 2>&1; then
  note "OK    docker daemon is running"
else
  # python3 + pip make local bundling work without any container runtime.
  if have python3 && python3 -m pip --version >/dev/null 2>&1; then
    note "OK    no running container runtime, but python3 + pip are available for local bundling"
  else
    warn "No running container runtime AND python3/pip is unavailable. Install pip (python3 -m ensurepip), start Docker/Colima, or set CDK_DOCKER=finch — otherwise EOL scraper bundling has no path."
  fi
fi

# --- AWS authentication and Region ---
echo ""
echo "AWS:"
REGION="$(resolve_region)"
if [ -z "$REGION" ]; then
  note "MISS  region not set — export AWS_REGION=<region> or 'aws configure set region <region>'."
  fail=1
else
  note "OK    region: $REGION"
fi

CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text 2>/dev/null || true)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ -n "$CALLER_ARN" ] && [ "$CALLER_ARN" != "None" ]; then
  note "OK    identity: $CALLER_ARN"
  note "OK    account:  $ACCOUNT_ID"
else
  note "MISS  AWS credentials not usable — run 'aws configure' or SSO login (and set AWS_PROFILE if needed)."
  fail=1
fi

# --- Configuration hints (non-fatal) ---
echo ""
echo "Configuration:"
[ -n "${COGNITO_ADMIN_EMAIL:-}" ] \
  && note "OK    COGNITO_ADMIN_EMAIL is set" \
  || warn "COGNITO_ADMIN_EMAIL is not set — export it before 'make deploy' (the admin user's temp password is emailed there)."
[ -n "${BEDROCK_MODEL_ID:-}" ] \
  && note "OK    BEDROCK_MODEL_ID override: ${BEDROCK_MODEL_ID}" \
  || note "INFO  BEDROCK_MODEL_ID not set — the default model will be used. Ensure model access is enabled in this Region."

# --- CloudWatch Transaction Search (account-level; warn only) ---
echo ""
echo "Observability (CloudWatch Transaction Search):"
if [ -n "$REGION" ] && [ -n "$CALLER_ARN" ] && [ "$CALLER_ARN" != "None" ]; then
  DEST="$(aws xray get-trace-segment-destination --region "$REGION" --query 'Destination' --output text 2>/dev/null || echo '')"
  STATUS="$(aws xray get-trace-segment-destination --region "$REGION" --query 'Status' --output text 2>/dev/null || echo '')"
  if [ "$DEST" = "CloudWatchLogs" ] && [ "$STATUS" = "ACTIVE" ]; then
    note "OK    Transaction Search: Destination=CloudWatchLogs, Status=ACTIVE"
  else
    warn "Transaction Search not fully enabled (Destination='${DEST:-?}', Status='${STATUS:-?}'). Enable it once per account/Region before relying on traces — see the README. This sample configures trace deliveries, not account-wide enablement."
  fi
else
  warn "Skipped Transaction Search check (region/credentials unavailable)."
fi

echo ""
if [ "$fail" -ne 0 ]; then
  banner "CHECK FAILED — resolve the MISS items above, then re-run 'make check'"
  exit 1
fi
banner "CHECK PASSED — you can proceed with 'make plan'"
