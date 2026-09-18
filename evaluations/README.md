# CloudOps answer-quality evaluations

This opt-in benchmark uses real Bedrock inference and real AgentCore `Evaluate`
calls. Tool results are fixed synthetic fixtures, identical in every account.
It does **not** measure live inventory, current AWS prices, Gateway discovery,
Cognito/Cedar enforcement, deployed Runtime health, or persistent Memory.
The agent uses the production system prompt and Strands loop; fixture tools replace
the deployed MCP tools. Search returns the case's fixture tool. There is no live-data mode.

## Metrics and references

- `Builtin.Helpfulness` (0–6): usefulness to the user. Not proof of facts.
- `Builtin.Faithfulness` (0–1): consistency with conversation and tool context.
- `Builtin.Correctness` (0–1): agreement with the reviewed reference supplied as
  `evaluationReferenceInputs[].expectedResponse.text`, scoped to session **and trace**.

Each dimension is reported separately as an arithmetic mean over successfully
evaluated cases, with label distribution and completed/expected, failed and skipped
counts. There is no overall score or pass threshold. Any missing result fails the
command. One explicit trace target per API call stays below the service's ten-result
limit. The multi-turn case grades its final trace while retaining the first turn's
context. Missing references, incomplete content, wrong targets and ignored reference
fields are errors, never a fallback to reference-free Correctness.

[`dataset.json`](dataset.json) contains 12 stable case IDs across cost/pricing,
CloudWatch, CloudTrail and inventory/EOL, including empty data, unavailable data,
synthetic denial and a two-turn follow-up. Every reference has explicit fixture
evidence and preconditions. Arithmetic and date comparisons establish the expected
facts independently of the generated answer. Prices and lifecycle dates are invented
demo values, not current AWS guidance. Maintainers should review references when
changing the dataset and bump its version. The runner also records its SHA-256 hash.

A thirteenth, separately reported sanity case copies the cost-total trace and changes
only its final answer to a deliberately false cost/leading service. It is a labeled
counterfactual, not a model response, and never enters baseline statistics. Inspect
its Correctness result; failure to penalize it invalidates confidence in the judge.

## Prerequisites and account portability

Use Python 3.12–3.14, `uv`, and your own authenticated AWS named profile. Commands
require profile, Region and model explicitly. No maintainer account, runtime ARN,
log group, role ARN or resource inventory is embedded in the runner.

Choose a Region supporting [AgentCore Evaluations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html)
and your [Bedrock model](https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html).
An inference profile beginning `us.` is not portable to every Region. Supply your
deployment's model ID or a compatible profile available in your geography; results
are comparable only when model/configuration/dataset match. Complete provider model
access/Marketplace prerequisites, including Anthropic use-case submission if required.

The caller needs `bedrock-agentcore:GetEvaluator`, `bedrock-agentcore:Evaluate`,
and `bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` for the chosen
model and inference profile/destination model resources. SCPs must permit any
cross-Region inference destinations. No IAM changes are made by the runner.
Built-in judges do not require creating a custom evaluator or passing a service role.

[Built-in judge inference can cross Regions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/evaluations-cross-region-inference.html).
`--allow-paid` acknowledges charges and this processing. Do not submit private data.
The [AWS hosted telemetry walkthrough](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/getting-started-on-demand.html)
uses CloudWatch Transaction Search and requires waiting for ingestion. This isolated
runner instead captures supported Strands inline-event spans locally, flushes the
synchronous exporter, validates content and submits spans directly to Evaluate.
It does not query or export to CloudWatch, and needs no polling or shared-log access.
It leaves account-wide Transaction Search settings unchanged.

## Copyable workflow

From the repository root, substitute your own values:

```bash
export EVAL_PROFILE="your-profile"
export EVAL_REGION="your-region"
export EVAL_MODEL="your-model-or-inference-profile-id"
aws sts get-caller-identity --profile "$EVAL_PROFILE"
uv sync --directory evaluations --locked

# Offline checks: never call AWS or spend money.
uv run --directory evaluations --locked pytest -q
uv run --directory evaluations --locked mypy runner.py

# Paid: invoke all 12 cases (13 turns), capture spans and flush local telemetry.
uv run --directory evaluations --locked runner.py invoke \
  --profile "$EVAL_PROFILE" --region "$EVAL_REGION" --model "$EVAL_MODEL" \
  --allow-paid --output runs/traces.json

# Paid: 39 judge calls, including the separate three-metric sanity check.
uv run --directory evaluations --locked runner.py score \
  --profile "$EVAL_PROFILE" --region "$EVAL_REGION" --allow-paid \
  --input runs/traces.json --output runs/results.json

# Free: regenerate tables, including all failed/missing cases.
uv run --directory evaluations --locked runner.py report \
  --input runs/results.json --output runs/report.md

# Paid: re-score the saved traces without invoking the agent again.
uv run --directory evaluations --locked runner.py score \
  --profile "$EVAL_PROFILE" --region "$EVAL_REGION" --allow-paid \
  --input runs/traces.json --output runs/rescored.json
```

Paths above resolve under `evaluations/` because `uv --directory` changes the working
directory. Choose a fresh output name each time; existing evidence is never overwritten.
Capture and scoring checkpoint after each case/call. SDK retries are bounded for
transient failures; they may incur additional charges. A nonzero exit means inspect
the artifact, not that no results were written. Failed captures record only exception
classes to avoid copying SDK payloads into evidence. For diagnosis, check credentials,
Region/model access and quota first. Refresh credentials and rerun capture to a new
path for failed cases; re-scoring cannot repair a missing capture.

The report command also exits nonzero for incomplete runs while still writing its
tables. Compare native scores, evaluator metadata, model, prompt hash, dataset hash,
lock hash and run date; AWS manages built-in judge prompts/models, so source pinning
does not pin their behavior. A service score is evidence, not a deterministic test.

## Cost, content safety and retention

There are 13 agent turns (tool loops can make multiple model calls) and 39 judge
requests. At an illustrative 5,000 input / 300 output tokens per judge, expect
195,000 input and 11,700 output judge tokens. At the September 2026 published
built-in rates of $2.40/M input and $12/M output tokens this is approximately
$0.61 for judges, **plus agent inference**. Actual usage varies; consult
[current AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) and
[Bedrock pricing](https://aws.amazon.com/bedrock/pricing/). No fixed dollar cap is
enforced. Model output is limited to 1,024 tokens per inference, not per full tool loop.
Results retain judge `tokenUsage`; traces record agent usage without double-counting
child spans. The sanity trace reuses agent tokens and must not be charged twice in
your own summaries.

The standalone runner never imports the production runtime, obtains a JWT, reads
customer resources or enables raw HTTP logging. Only Strands span/event allowlists
are exported; headers, exception text, links and arbitrary resource attributes are
excluded. A second check rejects AWS key IDs, JWTs, bearer tokens, account numbers,
private keys and credential-field markers. This is defense in depth, **not** a general
PII/customer-data anonymizer. Only the committed synthetic fixtures are approved.
Do not replace them with customer exports or feed arbitrary traces to this runner.
Reference answers go only to judges, never into agent prompts/tool results.

`runs/` is gitignored. Before publishing, review prompts, responses, tool events,
judge explanations and all IDs. Published correlation IDs here belong only to local
synthetic traces, not production sessions. Preserve full actual Evaluate result bodies
(minus HTTP response metadata) for audit. If content is unsafe, do not publish it.
There is no evaluation service, online config, runtime, log group or other cloud
resource created by this workflow to destroy. Delete your exact local run directory
when no longer needed; retain published baseline evidence with the source revision.
AWS service-side processing/retention is governed by AWS, not local file deletion.

## API references

- [Evaluate](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_Evaluate.html)
- [Ground-truth references and fallback behavior](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/ground-truth-evaluations.html)
- [Strands span/event schema](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/supported-frameworks-strands.html)
- [Built-in judge rubrics](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/prompt-templates-builtin.html)
