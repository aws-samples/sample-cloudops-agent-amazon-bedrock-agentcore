#!/usr/bin/env bash
# `make frontend`: build and package the React app into cloudops-frontend.zip,
# then print the manual Amplify upload steps. CDK does NOT host the frontend —
# this archive is uploaded to AWS Amplify Hosting by hand.
#
# Login-first onboarding (issue #23): this bakes the deployment's FrontEndConfig
# into the bundle so users sign in without a setup screen. Baking is best-effort
# — if the backend is not deployed or not reachable, it builds a setup-form
# ("bring your own backend") bundle instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/make/common.sh
. "$HERE/common.sh"

banner "FRONTEND — build and package the React app"

cd "$REPO_ROOT/frontend"

echo "Installing frontend dependencies (npm ci)..."
npm ci

echo "Baking deployment config for login-first onboarding (best-effort)..."
if "$REPO_ROOT/scripts/generate-frontend-config.sh"; then
  BAKED=1
  echo "Baked deployment config into public/app-config.json — the app will be login-first."
else
  BAKED=0
  rm -f "$REPO_ROOT/frontend/public/app-config.json"
  warn "Could not bake deployment config (backend not deployed / unreachable). Building a setup-form bundle; users will enter settings manually."
fi

echo "Building and zipping the app (npm run zip)..."
npm run zip

ZIP="$REPO_ROOT/frontend/cloudops-frontend.zip"
[ -f "$ZIP" ] || die "Expected archive not found at ${ZIP}."

banner "FRONTEND PACKAGE READY"
echo "Archive: ${ZIP}"
if [ "$BAKED" -eq 1 ]; then
  echo "Onboarding: login-first (deployment config baked in)."
else
  echo "Onboarding: setup form (no baked config) — run 'make config' for the values to enter."
fi
echo ""
echo "CDK does not deploy this frontend. Upload it manually to AWS Amplify Hosting:"
note "1. Amplify console -> Create new app -> Deploy without Git provider."
note "2. Upload the archive above (cloudops-frontend.zip)."
note "3. Open the app URL Amplify returns and sign in (login-first when config was baked)."
note "4. Only if you built a setup-form bundle: run 'make config' for the Settings values."
echo ""
echo "See the README 'Getting started' section for the Amplify manual-deploy link."
