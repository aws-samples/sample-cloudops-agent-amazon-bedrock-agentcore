#!/usr/bin/env bash
# `make help` (default target): print the short workflow and the steps that
# remain manual. Non-mutating.
set -euo pipefail

cat <<'EOF'
CloudOps Agent on Amazon Bedrock AgentCore — provisioning workflow

Complete the manual prerequisites in the README first (Node 22 + npm, AWS CLI v2,
uv, Docker running, zip, an authorized AWS profile, Bedrock model access, and
CloudWatch Transaction Search enabled once per account/Region). Then select your
environment and run the targets in order:

  export AWS_PROFILE="<your-profile>"
  export AWS_REGION="<your-region>"
  export COGNITO_ADMIN_EMAIL="<your-email>"

  make check       Verify tools, Docker, AWS auth/identity, Region, and the
                   Transaction Search prerequisite. Changes nothing.
  make plan        npm ci + build + synth once, then a template-only CDK diff
                   against the target account/Region. Makes NO AWS changes.
  make deploy      Bootstrap (if needed) + staged backend deploy that waits for
                   the main image build, then the remaining stacks, then EOL
                   population/verification. CDK approval prompts are preserved.
  make frontend    Build/package the React app (cloudops-frontend.zip) and print
                   the manual Amplify upload steps. CDK does not host the frontend.
  make config      Print the deployment's FrontEndConfig and map each value to
                   the app's Settings controls.

Still manual (by design):
  - Enabling the Bedrock model and CloudWatch Transaction Search (account-level).
  - Uploading cloudops-frontend.zip to AWS Amplify Hosting.
  - Entering the setup values, changing the first-login password, and clicking
    "New Conversation" before the first message.
  - Cleanup: this Makefile has no teardown target. See the README "Cleanup"
    section (cdk destroy is destructive and stays a deliberate manual step).

Notes:
  - `make plan` is a CDK preview (a template diff), not a Terraform-style saved
    plan or a guarantee of exact replacement behavior.
  - `make deploy` reuses the exact assembly `make plan` synthesized and refuses
    to run if that plan is missing or the sources/config changed since.
EOF
