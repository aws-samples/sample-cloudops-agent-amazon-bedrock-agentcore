#!/usr/bin/env bash
# Print a stable fingerprint of the inputs that determine the synthesized
# backend assembly, plus the deployment configuration that affects it. `make
# plan` records this; `make deploy` recomputes it and refuses to deploy a stale
# assembly if it changed. Read-only; prints only a hash.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

# Hash file contents of the source trees that become the deployed assembly,
# excluding generated/vendored directories. Region/model/EOL-table are folded in
# because they change the synthesized templates and IAM resources.
{
  find cdk/bin cdk/lib cdk/cdk.json cdk/package.json cdk/package-lock.json \
       agentcore mcp-servers/inventory lambda codebuild-scripts \
       -type f \
       ! -path '*/node_modules/*' ! -path '*/__pycache__/*' ! -path '*/.venv/*' \
       ! -path '*/.pytest_cache/*' ! -path '*/.hypothesis/*' ! -name '*.pyc' \
       -print0 2>/dev/null | LC_ALL=C sort -z | xargs -0 shasum -a 256
  echo "config region=${AWS_REGION:-${AWS_DEFAULT_REGION:-}} model=${BEDROCK_MODEL_ID:-default} eol=${EOL_TABLE_NAME:-default}"
} | shasum -a 256 | awk '{print $1}'
