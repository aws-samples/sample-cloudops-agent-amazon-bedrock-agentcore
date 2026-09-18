#!/usr/bin/env bash
# `make deploy`: deploy the reviewed assembly that `make plan` produced.
#
# - Requires a prior `make plan` and refuses to run if the plan is missing, is
#   for a different account/Region, or the sources/config changed since (which
#   would mean deploying something you did not review).
# - Reuses the exact synthesized assembly (cdk deploy --app cdk.out) across both
#   provisioning stages so build-trigger timestamps are not regenerated.
# - Bootstraps only when needed, gates runtime stacks on the main image build,
#   and finishes with EOL population/verification.
# - Preserves CDK security-change prompts (no --require-approval never) and
#   performs no teardown.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/make/common.sh
. "$HERE/common.sh"

require_aws_context
banner "DEPLOY — account ${ACCOUNT_ID} / region ${REGION}"

cd "$REPO_ROOT/cdk"

# --- Gate on a fresh, matching plan ---
[ -d cdk.out ]                || die "No synthesized assembly (cdk.out). Run 'make plan' first."
[ -f cdk.out/.make-plan.hash ] || die "No plan manifest. Run 'make plan' first."

if [ -f cdk.out/.make-plan.env ]; then
  planned_account="$(sed -n 's/^account=//p' cdk.out/.make-plan.env)"
  planned_region="$(sed -n 's/^region=//p' cdk.out/.make-plan.env)"
  [ "$planned_account" = "$ACCOUNT_ID" ] || die "Plan was for account ${planned_account}, but you are on ${ACCOUNT_ID}. Re-run 'make plan'."
  [ "$planned_region" = "$REGION" ]      || die "Plan was for region ${planned_region}, but you are on ${REGION}. Re-run 'make plan'."
fi

current_hash="$("$HERE/plan-hash.sh")"
planned_hash="$(cat cdk.out/.make-plan.hash)"
[ "$current_hash" = "$planned_hash" ] \
  || die "Sources or deployment configuration changed since 'make plan'. Re-run 'make plan' and review the diff before deploying."

# --- Bootstrap only if the environment is not already bootstrapped ---
if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
  echo "CDK environment already bootstrapped."
else
  banner "CDK bootstrap (one-time) — aws://${ACCOUNT_ID}/${REGION}"
  echo "Bootstrap provisions the CDK toolkit resources; it is separate from the application template diff."
  npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"
fi

# --- Stage 1: image + auth (reused assembly; approval prompts preserved) ---
banner "Stage 1/3 — CloudOpsImageStack + CloudOpsAuthStack"
echo "Review CDK's security-change prompts before approving."
npx cdk deploy --app cdk.out CloudOpsImageStack CloudOpsAuthStack --exclusively

# --- Stage 2: gate on the main agent image build ---
banner "Stage 2/3 — waiting for the main agent image build to succeed"
"$HERE/wait-main-build.sh" "$REGION"

# --- Stage 3: remaining stacks (same assembly) ---
banner "Stage 3/3 — remaining stacks (cdk deploy --all)"
npx cdk deploy --app cdk.out --all

# --- Initial EOL population + verification ---
banner "EOL data — populate and verify"
"$HERE/verify-eol.sh" "$REGION"

banner "BACKEND DEPLOY COMPLETE"
echo "Next:"
echo "  make frontend   # build/package the React app for manual Amplify upload"
echo "  make config     # print the setup values for the app's Settings screen"
