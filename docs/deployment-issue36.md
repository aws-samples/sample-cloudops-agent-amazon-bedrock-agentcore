# PR #38 targeted deployment evidence

Date: 2026-10-15. Region: **us-east-1**. Authorized demo profile: **aiops_demo**. Deployed source: **`ef7235906b06505fa14dcc49f1b5f74dceaae955`**. Evidence-only commits after this revision do not change the deployed application artifacts.

## Approved scope

The user approved the targeted rollout after reviewing a fresh `make plan` from an isolated checkout. The full Makefile deployment would rebuild all five MCP images and update unrelated authentication/policy Lambda artifacts; those changes were deliberately not applied.

Applied only:

- The existing main CodeBuild project built the committed runtime source under unique tag `issue36-ef72359-20261015`. No `latest` overwrite.
- The main AgentCore runtime moved from version **6** to **7** using an immutable image digest. Runtime and DEFAULT endpoint both report **READY**, with DEFAULT serving **7**.
- The missing configured conversation table was recreated empty, using the same name, string `userId` partition / `conversationId` sort keys, PAY_PER_REQUEST, default encryption, and **PITR enabled**. No listed backup was available. This did **not** recover deleted conversations or copy disposable local history.
- The history Lambda code was updated using its current RevisionId precondition; configuration and execution role were preserved.
- The existing Amplify `main` manual-hosting branch published the frontend. **Job 3: SUCCEED**; DEPLOY and VERIFY steps both succeeded.
- `auto-delete=no` was added and read back on the main runtime, its ECR repository, source bucket, main CodeBuild project, history Lambda, Amplify app/branch, and repaired table. Existing user/system tags were preserved. This does not claim that every untouched stack resource has the tag.

Cognito users, groups, passwords, IAM policies, Gateway/Cedar policy, Bedrock model, Memory configuration, the five MCP runtimes, and EOL resources were not changed. Unrelated local image/runtime-stack edits were excluded and hash-verified unchanged.

## Artifact and build identity

| Artifact | SHA-256 / identity |
| --- | --- |
| Runtime source ZIP | `60f47a3403bea0368b929bb477b18b90bc09a053519c1e8661ef0633c6fe9bb1` |
| New container digest | `sha256:34b6f38c3b1f729459339450d54c56b9a7dee1409c2c0726869978e78d4a8fb5` |
| Exact CodeBuild run | `cloudops-mainruntime-build:78b52dcc-7d7c-441c-8120-b56ab47371bf` — SUCCEEDED |
| History handler ZIP | `3838443817f84474e691fd7731a4c2deae70d3de693d126f77b30fb37ac34563` |
| Frontend ZIP | `c1b6b58af3d3b6a21c6ae82e74629073c461c303d9a245409ef62e14b52d03d3` |

The build installed Python 3.14, Strands **1.61.0**, AgentCore SDK **1.24.1**, MCP **1.30.0**, boto3 **1.43.114**, and ADOT **0.18.0**. A pre-rollout test run with Python 3.14/current SDKs passed **145**, skipped **7**, and deselected **14** live tests. This compatibility run is distinct from the successful ARM container build and deployed verification below. Dependency lower bounds remain unpinned; the recorded versions describe this particular build.

## Verified after publication

- Hosted `index.html`, `app-config.json`, JavaScript, and CSS returned **200** and matched the local production build byte-for-byte (four verified assets). The production transport's local-API branch is compiled to `false`; no media capture harness is included.
- Hosted sign-in page passed visible-text/username-control, console, page-error, and network QA. Credential fields remained empty. This checks onboarding rendering, not successful authentication.
- Anonymous history API request returned **401**, as expected.
- A direct IAM-authorized **read-only** history Lambda invocation returned handler **200** and an empty list against the repaired table. This uses a synthetic QA subject and does **not** prove Cognito-authenticated history CRUD or cross-user isolation.
- Table is **ACTIVE**, PITR **ENABLED**, and has zero records at verification. A selected-resource CFN drift check reports only the newly added cleanup tag for the recreated table.
- Runtime configuration was compared with its pre-rollout snapshot: role, network, model/Gateway/Memory environment, lifecycle, protocol, and metadata settings are unchanged. Lambda role/runtime/handler/memory/timeout/environment/architecture are unchanged; its code hash matches the uploaded archive.
- The previous ECR `latest` digest is unchanged. Only the unique new image is used by runtime version 7.

## Investigation smoke test: explicit limitation

An IAM-authorized AgentCore request **without a Cognito token** reached version 7 and received `text/event-stream`, followed by `run-start`, `discovering-tools`, and terminal `run-error: agent-error`. Server logs confirm the SigV4 fallback hit the unchanged **CUSTOM_JWT Gateway** and received **401 Unauthorized** during discovery. The request did not reach a model answer.

This proves the deployed SSE framing/error path is reachable, **not** successful text/tool streaming or an authenticated investigation. It is not a Gateway tool-policy denial, because JWT admission failed before a tool invocation. No permissions were changed to make this tokenless smoke check succeed.

Still required for end-to-end sign-off with the existing users:

1. Admin sign-in and a read-only operational investigation, showing incremental answer/tool receipt.
2. Non-admin billing, then the unavailable operational request; no restricted data or authorization workaround.
3. Supported live cost chart, raw-output inspection, save/reopen, and authenticated user isolation.
4. A separate genuine Gateway invocation-denial check with a valid non-admin identity, if required by final acceptance.

Local role/history evidence remains in [agentic-chat-qa.md](agentic-chat-qa.md), but it is not substituted for these deployed checks.

## Operational caveats and rollback

This is a deliberately scoped **direct-service rollout**, not a full CloudFormation update. Runtime image, Lambda code, and added cleanup tags can differ from the last applied CFN templates. A future CDK deployment must explicitly reconcile the image/version so it does not restore the old mutable `latest` artifact. The history table was restored under the existing configured physical name; old deleted data remains lost.

Private rollback snapshots/artifacts were saved before mutation: prior runtime configuration and immutable image digest, Lambda code ZIP, and prior successful Amplify bundle. Rollback should restore those application artifacts while **keeping the repaired table and any new history**. Do not delete resources or history automatically. Account IDs, deployment URLs, upload URLs, and credentials are intentionally omitted from this public evidence document.
