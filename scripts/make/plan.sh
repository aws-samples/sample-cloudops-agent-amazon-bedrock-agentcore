#!/usr/bin/env bash
# `make plan`: prepare project-local dependencies/build artifacts, synthesize the
# cloud assembly ONCE, and show a template-only CDK diff against the selected
# account/Region.
#
# Makes NO AWS mutations: it does not bootstrap, publish assets, create
# CloudFormation change sets (uses `cdk diff --no-changeset`), start CodeBuild,
# invoke the scraper, or provision/delete anything. Local builds and read-only
# AWS lookups (describe stacks, context) are expected.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/make/common.sh
. "$HERE/common.sh"

require_aws_context
banner "PLAN — account ${ACCOUNT_ID} / region ${REGION}"

cd "$REPO_ROOT/cdk"

echo "Installing pinned CDK dependencies (npm ci)..."
npm ci

echo "Building CDK app (TypeScript)..."
npm run build

echo "Synthesizing the cloud assembly once into cdk.out..."
npx cdk synth --quiet

echo ""
echo "Template-only diff against the target account/Region (no change sets, no mutations):"
echo "------------------------------------------------------------"
# --no-changeset keeps this a pure template diff and avoids creating a
# CloudFormation change set. Differences make cdk diff exit non-zero; that is
# expected on a first deploy, so it must not fail the plan.
npx cdk diff --app cdk.out --no-changeset --all || true
echo "------------------------------------------------------------"

# Record the plan manifest so `make deploy` reuses THIS assembly (avoiding
# regenerated build-trigger timestamps) and can detect source/config drift.
"$HERE/plan-hash.sh" > cdk.out/.make-plan.hash
{
  echo "account=${ACCOUNT_ID}"
  echo "region=${REGION}"
  echo "model=${BEDROCK_MODEL_ID:-default}"
  echo "eol_table=${EOL_TABLE_NAME:-default}"
} > cdk.out/.make-plan.env

banner "PLAN COMPLETE"
echo "This was a CDK preview (a template diff) — not a Terraform-style saved plan"
echo "and not a guarantee of exact replacement behavior. Review the additions,"
echo "modifications, deletions, and any potential replacements above."
echo ""
echo "When you are satisfied, run:  make deploy"
