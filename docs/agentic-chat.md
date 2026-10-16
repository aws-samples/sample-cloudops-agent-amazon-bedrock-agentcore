# Agentic chat

The React/Vite frontend uses assistant-ui with an external-store adapter. The application owns authentication, per-conversation state, execution, and history. The UI library requires no hosted service. Selected Tool UI schemas/presentations are adapted locally; their provenance and MIT notice live alongside the components.

## Interface baseline

The complete workspace is adapted from assistant-ui's official default/minimal starter, pinned at revision `325a3cd47a5ea114033879d2da8c66d6749dcf09`. Source mappings, adaptations, and the MIT license are recorded in the frontend's `components/assistant-ui/UPSTREAM.md`. `PRODUCT.md` and `DESIGN.md` define the product and replacement visual system.

The old sidebar, header, composer, error components, purple authentication theme, and CSS token set are removed. Existing state/auth services remain behind the new source-owned UI. Searchable history, keyboard-accessible menus, the responsive sidebar sheet, and consistent settings/authentication styling use the same components and tokens.

Gateway discovery already loads the complete permitted tool catalogue for each request. The request-specific prompt describes only those capabilities and calls their exact registered tool names; it no longer requires an unavailable semantic-search tool or advertises operational tools to non-admin users. Suggested prompts use the token's exact `admin` claim as a UI hint only. Non-admin users see billing/pricing suggestions plus a lock-marked "Check CloudWatch alarms (admin-only)" example to explore the restriction UX. Selecting it fills the composer; it neither sends automatically nor fabricates a denial. Catalogue unavailability is not proof that Gateway policy denied an invocation. Discovery and invocation authorization remain server-side and unchanged.

The local `report_access_restricted` tool checks whether a requested capability is present in that discovered catalogue. It reports availability only and never invokes or authorizes an AWS tool. A catalogue-based restriction explains that no restricted tool was invoked. A genuine authorization denial uses the familiar "Access restricted" state with no Retry; an unregistered tool uses the separate "Capability unavailable" state. Safe raw JSON remains inspectable and copyable in each tool state.

## Streaming contract

The existing AgentCore invocation accepts optional `responseMode: "stream-v1"`. Callers omitting it retain the final JSON response. The frontend requests streaming but also accepts legacy JSON for staged deployments. AgentCore's SDK converts yielded dictionaries to UTF-8 SSE frames (`data: <JSON>` followed by a blank line); HTTP chunks are not event boundaries.

Every event contains:

- `version`: `1`.
- `runId`, `messageId`: server-generated stable IDs for the invocation and answer.
- `sequence`: consecutive zero-based integer, starting with `run-start`.
- `type`: `run-start`, `run-stage`, `text-delta`, `tool-start`, `tool-complete`, `tool-error`, `run-complete`, or `run-error`.

`run-stage` carries an allowlisted `stage`: `discovering-tools`, `waiting-model`, or `model-retry`. These events come from the actual Gateway/model boundaries and Strands throttling events, not a timer or simulated progress. The client stops receiving after 130 seconds without a validated event or a 10-minute total run limit; those limits have distinct recovery messages. Neither limit automatically retries the request.

Text deltas carry `text`. Tool events carry `toolCallId` and `toolName`; terminal tool results carry an inspectable `output` with JSON text plus `redacted`/`truncated` flags. Successful results may also carry a typed `presentation`. Tool codes distinguish `access-denied`, `capability-unavailable`, and `tool-unavailable`. Run-level errors expose only an allowlisted code (`access-denied`, `agent-error`, `incomplete`), not exception strings. No reasoning events are sent.

Tool events derive from finalized Strands tool-use/result messages. With the minimum supported Strands version, parallel tool completions may arrive together in one result message; this is not a per-tool timing profiler. Model argument deltas are not shown as execution progress.

The client rejects malformed frames, sequence gaps, inconsistent tool lifecycles, unfinished tools at completion, excessive events/payloads, and EOF without a terminal event. Duplicate sequence numbers and events from another run/message are ignored. A failure preserves partial output marked incomplete. Stop aborts local receipt; it does not prove remote execution cancellation. Neither disconnection nor retry automatically resumes/reruns tools.

## Structured results and history

- Resource previews support known inventory listing tools and a fixed set of descriptive fields, bounded to 50 rows. Truncation is labeled.
- Active-alarm previews project CloudWatch's metric/composite alarms into a table with name, state, namespace, metric, and update time. Empty results say "No active alarms found"; partial results are labeled. Raw reasons and dimensions are not persisted in the preview.
- Cost previews support Cost Explorer `ResultsByTime` data, including the billing server's success/data envelope, in one currency and at most 30 points. SQL-stored/unsupported results fall back to the agent answer rather than guessing at totals or units.
- Every newly captured tool result can be expanded as formatted **Raw JSON** and copied, including tools without a dedicated preview. It preserves the tool-result envelope and unrecognized non-credential fields. Tables/charts supplement this output; they do not replace it.
- Known credential keys, bearer/JWT/private-key patterns, and signed-URL credentials are redacted server-side before transmission. Authorization-denial payloads are withheld. Raw inspection is limited to 24,000 JSON characters per tool with a 48,000-character run budget; depth/item/string limits and truncation are labeled. This is best-effort credential redaction, not a general sensitive-data classifier. Do not use the trace as a secret store.
- JSON is rendered as inert text, never generated HTML, scripts, components, actions, or styles. The history API validates the output envelope and JSON syntax/size. Existing messages without captured output explain that a new tool run is needed.
- Text-only history remains valid. Rich snapshots add `partsVersion: 1` and `parts` containing text/tool entries, including blocked and unavailable tool states and restricted answers. The client validates stored data and marks restored nonterminal states interrupted; reopening never invokes a tool.
- The history API parses decimal costs without floating-point serialization errors, accepts bounded snapshots, and returns a visible save failure when the batch/conversation budget is exhausted. It does not store token-by-token deltas. A late append cannot recreate a deleted record.

Limits intentionally keep this sample within the existing single-record history model. Starting a new conversation is the recovery when history is full; moving to event storage or large artifact storage is outside this feature.

## Complete local development

Run the new frontend and actual AgentCore SDK entrypoint locally:

```sh
AWS_PROFILE=aiops_demo AWS_REGION=us-east-1 make dev
```

Open **http://127.0.0.1:5173** and sign in with an existing Cognito user. The backend binds only to `127.0.0.1:8080`; Vite proxies local API calls without buffering SSE. Source edits reload the servers. Stop with Ctrl+C.

- **Local:** new React UI, AgentCore ASGI runtime, real conversation-history Lambda handler, disposable DynamoDB emulator. Local history resets when the backend reloads/restarts.
- **Live AWS:** existing Cognito, Bedrock model, Gateway/MCP tools, AgentCore Memory. Calls incur normal AWS costs; this is local execution, not an offline model or AWS service emulator.
- **No deployment:** the launcher reads existing stack/runtime configuration. It does not create cloud resources, reset passwords, change policy, or publish images.
- **Authentication:** unlike hosted AgentCore/API Gateway, a bare local ASGI server has no managed authorizer. The local wrapper verifies Cognito signatures, issuer, expiry, client, and token use, then forwards the verified access token to the agent. History uses the verified ID-token subject. Credentials are not sent to the local agent as AWS signing keys.
- **Production isolation:** `VITE_LOCAL_API=1` only affects Vite development mode. Production builds continue using signed AgentCore calls and the deployed history endpoint.

The AgentCore `dev` workflow uses this same SDK ASGI app. This repository imports it through Uvicorn so local JWT verification and history can run alongside the existing entrypoint without adopting a new CLI project layout. Dependencies are locked under `scripts/dev`.

## Validation and deployment

Primary acceptance tests render the app with real state/providers, adapter, and transport parsing, substituting only authentication and HTTP responses. Backend tests use the invocation boundary with a deterministic agent source. History tests exercise the HTTP handler against Moto DynamoDB.

Focused commands:

```sh
cd frontend
npx tsc --noEmit
npm test -- src/ChatWorkflow.test.tsx
npm run build
```

```sh
uv run --with pytest --with hypothesis --with boto3 --with httpx --with requests-aws4auth --with mcp pytest agentcore/tests/test_agent_stream.py -q
uv run --with pytest --with boto3 --with 'moto[dynamodb]' pytest cdk/lambda/conversations/test_rich_history.py -q
```

Deploy the runtime image (including the streaming, presentation, and raw-output modules), the history Lambda, and the frontend. Use the repository's plan/deploy workflow and inspect its diff before applying to the selected account. A local or mocked test is not evidence that the deployed AgentCore transport streams incrementally.

For deployed QA use the existing admin and non-admin users. Verify actual incremental text/tool receipt, supported rich results, final snapshot reload, local stop, expired-session handling, and mobile/keyboard behavior. Repeat an allowed billing request as non-admin and confirm restricted inventory/CloudWatch behavior remains denied with no restricted payload. Do not reset passwords, create users, or change authorization to make QA pass.

Durable approval/resume workflows, arbitrary generative layouts, hosted persistence, and server-side cancellation guarantees are not included.
