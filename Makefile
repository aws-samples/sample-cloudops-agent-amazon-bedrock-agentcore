# CloudOps Agent on Amazon Bedrock AgentCore — provisioning workflow.
#
# This is a THIN wrapper: each target runs a small, reviewable bash helper in
# scripts/make/. The helpers encode the same clone-to-first-query flow the
# README "Getting started" documents, using the project's own tools (npx cdk,
# npm) — no global installs and no approval bypass.
#
# Typical order (after completing the manual prerequisites in the README):
#     export AWS_PROFILE=<profile>  AWS_REGION=<region>  COGNITO_ADMIN_EMAIL=<email>
#     make check      # verify tools / auth / prerequisites (no changes)
#     make plan       # build + synth once + template-only diff (no AWS changes)
#     make deploy     # bootstrap-if-needed + staged backend deploy + EOL verify
#     make frontend   # build/package the React app for manual Amplify upload
#     make config     # print the frontend setup values
#
# Guarantees:
#   - `make`, `make help`, `make check`, `make plan` make NO AWS mutations.
#   - CDK security-change prompts are preserved (no --require-approval never).
#   - `make deploy` reuses the exact assembly `make plan` synthesized and
#     refuses to run if the plan is missing or the sources/config changed.
#   - There is NO teardown target here; cleanup is manual and explicit
#     (see the README "Cleanup" section).

MK := scripts/make

.PHONY: help check plan deploy frontend config

# Default, non-mutating: print the workflow and remaining manual steps.
help:
	@bash $(MK)/help.sh

# Verify required tools, Docker, AWS auth/identity, region, and observability
# prerequisites. Prints actionable guidance; installs/configures nothing.
check:
	@bash $(MK)/check.sh

# Build project-local dependencies/artifacts, synthesize once, and show a
# template-only CDK diff against the selected account/Region. No AWS mutations.
plan:
	@bash $(MK)/plan.sh

# Deploy the reviewed assembly: bootstrap when needed, staged provisioning,
# wait for the main image build, remaining stacks, and initial EOL verification.
deploy:
	@bash $(MK)/deploy.sh

# Build and package the React app; print the archive path and manual Amplify
# upload instructions. CDK does not host the frontend.
frontend:
	@bash $(MK)/frontend.sh

# Retrieve the consolidated stack output and map each value to the frontend
# Settings controls (including the history endpoint).
config:
	@bash $(MK)/config.sh
