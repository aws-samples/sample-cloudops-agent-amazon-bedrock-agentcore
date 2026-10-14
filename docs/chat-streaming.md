# Chat streaming and structured results

The frontend uses `@assistant-ui/react`'s external-store runtime with the
application-owned conversation state. React 18, Vite, Cognito sign-in, settings,
SigV4 invocation, and the separate ID-token-authenticated history API remain in
place. No hosted chat service or additional agent runtime is required. The
source-owned DataTable/Chart adapters in `frontend/src/components/tool-ui` reduce
the Tool UI presentation patterns to native, accessible elements and the selected
bounded schemas. They omit the upstream table's React-19-only context, generated
actions, sorting, and styling dependencies; the MIT attribution is retained.

## Wire contract

Send `responseMode: "stream-v1"`, a UUID `runId`, and a UUID `messageId` alongside
the existing prompt, session ID, and access token. Callers without this explicit
mode still receive the original final JSON response. The frontend also accepts
final JSON from an older backend during staged deployment.

The AgentCore SDK serializes each yielded dictionary as UTF-8 SSE:

```text
data: {"version":1,"runId":"…","messageId":"…","sequence":1,"type":"run-start"}

```

All events have that envelope. Sequence values begin at 1 and increase per run.
Supported event types and extra fields:

| Event | Extra fields |
| --- | --- |
| `run-start` | None |
| `text-delta` | `text` (Strands text, never reasoning) |
| `tool-start` | `toolCallId`, `name` (no arguments) |
| `tool-complete` | `toolCallId`, optional validated `presentation` |
| `tool-failure` | `toolCallId` (no raw error/result) |
| `run-complete` | None |
| `run-failure` | Fixed safe `message`; frontend shows its own generic retry notice |

HTTP chunk boundaries are not event boundaries. The parser retains incomplete
SSE frames and UTF-8 sequences, accepts CRLF framing, ignores stale/duplicate
events, and rejects sequence gaps or malformed frames. EOF without a terminal
completion is a failed/incomplete response, not success. There is no automatic
retry or reconnection. Local Stop aborts receipt and marks partial content and
unfinished tools interrupted; it does not assert remote cancellation. Interrupted
answers remain in the current in-memory conversation but are not saved as
completed history. The default receipt timeout is two minutes.

The runtime keeps each user's identity-scoped MCP client open for discovery and
the entire agent stream. Gateway discovery filtering/Cedar enforcement, verified
memory actor selection, callback suppression, and the metadata-only exporter are
unchanged. Only selected presentation data is emitted, not raw Strands events,
tool arguments, exceptions, credentials, or reasoning.

Tool states come from Strands `BeforeToolCallEvent`/`AfterToolCallEvent` hooks,
not from the model beginning to generate tool arguments. A bounded async queue
multiplexes those boundaries and text deltas while preserving backpressure; the
producer is cancelled/awaited before closing its MCP scope on disconnect.

## Selected results and limits

- Resource tables: inventory `list_eks_clusters`, `list_rds_instances`,
  `list_msk_clusters`, `list_elasticache_clusters`, and `list_opensearch_domains`.
  Only name, region, status, version, engine, and instance class are selected;
  known identifier aliases become `name`. FastMCP JSON blocks and its typed
  `{result: [...]}` envelope are supported. ARN/account/tag/endpoint fields are
  intentionally excluded.
- Cost charts: the pinned billing MCP `cost-explorer` success/data envelope
  containing `ResultsByTime[].Total.UnblendedCost`, or the same native response
  from `get_cost_and_usage`. The chart displays period start, signed numeric
  amount, and currency, plus an exact-value table. USD/EUR/GBP/JPY are supported;
  mixed units, non-finite amounts, grouped-only totals, SQL-offload sentinels,
  unknown shapes, and errors get a readable preview-unavailable fallback. No
  Markdown is scraped to invent a chart.
- Each preview has at most 50 rows/points and bounded text cells. Raw preview
  parsing is limited to 64,000 characters; emitted previews have a combined
  40,000-byte budget per run. Further previews fall back without failing the agent.
- A run allows 50 tools and 100,000 text characters. Tool IDs/names are bounded
  to 200 characters. Frames are capped at 128,000 characters. These bounds apply
  to presentation, not to permission grants or to which tools users may invoke.

Completed responses save one optional `partsVersion: 1`/`tools` snapshot alongside
their text fallback. Legacy history stays readable. The client and history API
validate presentation shapes; unknown parts are never interpreted as component
names, HTML, JSX, or code. The history API caps tool snapshots at 64,000 bytes,
appends at 160,000 bytes, and conversation message JSON at 340,000 bytes; a full
history returns an actionable save notice. Decimal JSON cost values are parsed
as DynamoDB-compatible Decimal values. Conditional updates cannot recreate a
deleted record. User/final saves for a run are serialized; cross-tab concurrent
history append conflict resolution remains outside this feature.

## Offline verification

Use the repository's Node 22+ prerequisite (React remains 18):

```sh
cd frontend
npm ci
npm test
npm run build
```

With the runtime requirements, pytest, hypothesis, and pytest-asyncio installed:

```sh
python -m pytest agentcore/tests -m 'not integration' -q
python -m pytest cdk/lambda/conversations/test_handler.py --import-mode=importlib -q
```

Rendered workflow tests use real providers, the real external-store adapter,
the signed invocation service, and the actual stream parser, mocking only auth
and external HTTP responses. Backend tests exercise the entrypoint and installed
AgentCore SDK SSE/JSON dispatch, MCP lifetime, identity/memory isolation, actual
FastMCP-to-Strands content conversion, safe failures, and history request handling.
An additional offline test runs the installed Strands agent/tool executor with
a deterministic local model and tool, verifying actual hook registration and
the start/completion/text event sequence without calling Bedrock.

Offline tests do **not** establish deployed incremental delivery. Before a
deployment is considered verified, an authorized maintainer should check an
early text delta before completion through AgentCore, an allowed tool's progress,
non-admin denial with no denied data, rich-history reopen, and Stop's incomplete
state. No deployment, paid model invocation, or AWS permission change is needed
to run the offline tests.
