#!/usr/bin/env bash
# `make config`: retrieve the consolidated FrontEndConfig stack output and map
# each value to the app's individual Settings controls (the setup screen uses
# individual fields, NOT a JSON import). Read-only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/make/common.sh
. "$HERE/common.sh"

require_aws_context
banner "CONFIG — frontend setup values (account ${ACCOUNT_ID} / region ${REGION})"

CFG="$(aws cloudformation describe-stacks --stack-name CloudOpsConversationHistoryStack --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontEndConfig'].OutputValue | [0]" --output text 2>/dev/null || true)"
{ [ -n "$CFG" ] && [ "$CFG" != "None" ]; } \
  || die "FrontEndConfig output not found on CloudOpsConversationHistoryStack. Is the backend deployed ('make deploy')?"

echo "FrontEndConfig:"
echo "------------------------------------------------------------"
# Pretty-print when possible; fall back to the raw value.
echo "$CFG" | python3 -m json.tool 2>/dev/null || echo "$CFG"
echo "------------------------------------------------------------"
echo ""
echo "Enter these into the app's Settings screen (individual fields, NOT a JSON import):"
note "cognito.userPoolId        -> Amazon Cognito: User Pool ID"
note "cognito.userPoolClientId  -> Amazon Cognito: User Pool Client ID"
note "cognito.identityPoolId    -> Amazon Cognito: Identity Pool ID"
note "cognito.region            -> Cognito Region"
note "agentcore.agentArn        -> AgentCore: AgentCore Runtime ARN"
note "agentcore.region          -> AgentCore Region"
note "conversationApi.endpoint  -> Conversation History API: API Endpoint URL (required)"
echo ""
echo "Then: sign in as 'admin' (temporary password emailed to COGNITO_ADMIN_EMAIL),"
echo "complete the password change, and click 'New Conversation' before sending the first message."
