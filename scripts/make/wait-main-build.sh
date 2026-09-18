#!/usr/bin/env bash
# Poll the main agent image build (CodeBuild project cloudops-mainruntime-build)
# until it reaches a terminal state. ImageStack triggers this build but does not
# wait for it, and stack completion alone does not prove the new image exists —
# so runtime deployment must gate on SUCCEEDED. Read-only (list/get builds).
#
# Usage: wait-main-build.sh <region>
# Exit 0 only on SUCCEEDED; non-zero on any failure/timeout.
set -euo pipefail

REGION="${1:?region required}"
PROJECT="cloudops-mainruntime-build"
TIMEOUT_SECONDS="${MAIN_BUILD_TIMEOUT_SECONDS:-2400}"   # 40 minutes
deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

echo "Locating the latest build for CodeBuild project '${PROJECT}'..."
build_id=""
while :; do
  build_id="$(aws codebuild list-builds-for-project --project-name "$PROJECT" \
    --sort-order DESCENDING --region "$REGION" --query 'ids[0]' --output text 2>/dev/null || true)"
  [ -n "$build_id" ] && [ "$build_id" != "None" ] && break
  [ "$(date +%s)" -lt "$deadline" ] || { echo "ERROR: no build found for '${PROJECT}' before timeout."; exit 1; }
  echo "  no build yet; waiting..."
  sleep 10
done
echo "Watching build: ${build_id}"

while :; do
  status="$(aws codebuild batch-get-builds --ids "$build_id" --region "$REGION" \
    --query 'builds[0].buildStatus' --output text 2>/dev/null || echo 'UNKNOWN')"
  case "$status" in
    SUCCEEDED)
      echo "Main agent image build SUCCEEDED."
      exit 0
      ;;
    IN_PROGRESS)
      echo "  build in progress..."
      ;;
    FAILED|FAULT|STOPPED|TIMED_OUT)
      echo "ERROR: main image build ${build_id} ended with status: ${status}"
      deep_link="$(aws codebuild batch-get-builds --ids "$build_id" --region "$REGION" \
        --query 'builds[0].logs.deepLink' --output text 2>/dev/null || true)"
      [ -n "$deep_link" ] && [ "$deep_link" != "None" ] && echo "Logs: ${deep_link}"
      echo "Fix the build before deploying runtime stacks that depend on this image."
      exit 1
      ;;
    *)
      echo "  status: ${status} (waiting)..."
      ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "ERROR: timed out waiting for build ${build_id}."; exit 1; }
  sleep 15
done
