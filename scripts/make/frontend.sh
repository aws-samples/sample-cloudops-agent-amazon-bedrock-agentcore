#!/usr/bin/env bash
# `make frontend`: build and package the React app into cloudops-frontend.zip,
# then print the manual Amplify upload steps. CDK does NOT host the frontend —
# this archive is uploaded to AWS Amplify Hosting by hand. No AWS calls.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/make/common.sh
. "$HERE/common.sh"

banner "FRONTEND — build and package the React app"

cd "$REPO_ROOT/frontend"

echo "Installing frontend dependencies (npm ci)..."
npm ci

echo "Building and zipping the app (npm run zip)..."
npm run zip

ZIP="$REPO_ROOT/frontend/cloudops-frontend.zip"
[ -f "$ZIP" ] || die "Expected archive not found at ${ZIP}."

banner "FRONTEND PACKAGE READY"
echo "Archive: ${ZIP}"
echo ""
echo "CDK does not deploy this frontend. Upload it manually to AWS Amplify Hosting:"
note "1. Amplify console -> Create new app -> Deploy without Git provider."
note "2. Upload the archive above (cloudops-frontend.zip)."
note "3. Open the app URL Amplify returns."
note "4. Run 'make config' to get the values for the Settings screen."
echo ""
echo "See the README 'Getting started' section for the Amplify manual-deploy link."
