#!/usr/bin/env bash
# Shared helpers for the Makefile-driven workflow. Sourced by scripts/make/*.sh.
#
# Region and account are resolved from the environment / AWS CLI profile and are
# never hard-coded. Nothing here mutates AWS or installs tooling.

# Repository root (two levels up from scripts/make/).
COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$COMMON_DIR/../.." && pwd)"
export REPO_ROOT

die()  { echo "ERROR: $*" >&2; exit 1; }
warn() { echo "WARN:  $*" >&2; }
note() { echo "  $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

banner() {
  echo ""
  echo "============================================================"
  echo "  $*"
  echo "============================================================"
}

# Resolve the target Region from env or the active CLI profile.
resolve_region() {
  local r="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
  [ -n "$r" ] || r="$(aws configure get region 2>/dev/null || true)"
  echo "$r"
}

# Resolve REGION + ACCOUNT_ID (exported) or fail with actionable guidance.
# Prints only the account id and region — never any credential/token material.
require_aws_context() {
  REGION="$(resolve_region)"
  [ -n "$REGION" ] || die "AWS region not set. Export AWS_REGION=<region> (and optionally AWS_PROFILE), or run 'aws configure set region <region>'."
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
  { [ -n "$ACCOUNT_ID" ] && [ "$ACCOUNT_ID" != "None" ]; } \
    || die "AWS credentials are not usable. Configure credentials (aws configure / SSO login) and retry. Run 'make check' for details."
  export REGION ACCOUNT_ID
}
