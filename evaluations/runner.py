"""Opt-in, fixture-backed CloudOps evaluation using real AgentCore judges."""
from collections import Counter
from statistics import mean
import math
from typing import Any
import json
import re
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import logging
import os
from pathlib import Path
import subprocess
import sys
import uuid

METRICS = ("Builtin.Helpfulness", "Builtin.Faithfulness", "Builtin.Correctness")
ATTRIBUTES = {
    "gen_ai.operation.name", "gen_ai.system", "gen_ai.agent.name", "gen_ai.agent.tools",
    "gen_ai.request.model", "gen_ai.tool.name", "gen_ai.tool.call.id", "gen_ai.tool.status",
    "gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens", "gen_ai.usage.total_tokens",
}
EVENTS = {"gen_ai.user.message", "gen_ai.assistant.message", "gen_ai.tool.message", "gen_ai.choice"}
SENSITIVE = re.compile(
    r"(?i)\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"
    r"|\bBearer\s+\S+|\b\d{12}\b|-----BEGIN .*PRIVATE KEY-----"
    r"|accessToken|access_token|refresh_token|client_secret|secret_access_key|authorization"
)


def ensure_safe(value):
    # Defense in depth, not a general customer-data scrubber: only fixtures are accepted.
    if SENSITIVE.search(json.dumps(value, default=str)):
        raise ValueError("potentially sensitive content; refusing export")


def safe_spans(spans, session_id):
    result = []
    for span in spans:
        if span.instrumentation_scope.name != "strands.telemetry.tracer":
            continue
        record = {
            "traceId": format(span.context.trace_id, "032x"),
            "spanId": format(span.context.span_id, "016x"),
            "name": span.name, "kind": span.kind.name,
            "scope": {"name": "strands.telemetry.tracer"},
            "startTimeUnixNano": span.start_time, "endTimeUnixNano": span.end_time,
            "attributes": {k: v for k, v in span.attributes.items() if k in ATTRIBUTES},
            "events": [{"name": e.name, "attributes": {
                k: v for k, v in e.attributes.items()
                if k in {"content", "message", "role", "id", "finish_reason"}
            }} for e in span.events if e.name in EVENTS],
        }
        record["attributes"]["session.id"] = session_id
        if span.parent:
            record["parentSpanId"] = format(span.parent.span_id, "016x")
        result.append(record)
    ensure_safe(result)
    return result


def validate_content(spans, trace_id):
    target = [s for s in spans if s["traceId"] == trace_id]
    agents = [s for s in target if s["attributes"].get("gen_ai.operation.name") == "invoke_agent"]
    if len(agents) != 1:
        raise ValueError("missing or ambiguous agent content")
    for span in target:
        operation = span["attributes"].get("gen_ai.operation.name")
        if operation not in {"invoke_agent", "execute_tool"}:
            continue
        events = span.get("events", [])
        incoming = "gen_ai.user.message" if operation == "invoke_agent" else "gen_ai.tool.message"
        for name, field in ((incoming, "content"), ("gen_ai.choice", "message")):
            if not any(e["name"] == name and e["attributes"].get(field) for e in events):
                raise ValueError(f"incomplete {operation} content")


def evaluation_request(case, record, metric):
    reference = case.get("expectedResponse")
    if not isinstance(reference, str) or not reference.strip():
        raise ValueError(f"{case['id']}: missing ground truth")
    ensure_safe(record["spans"])
    validate_content(record["spans"], record["traceId"])
    if any(s["attributes"].get("session.id") != record["sessionId"] for s in record["spans"]):
        raise ValueError("span session mismatch")
    request = {
        "evaluatorId": metric,
        "evaluationInput": {"sessionSpans": record["spans"]},
        "evaluationTarget": {"traceIds": [record["traceId"]]},
    }
    if metric == "Builtin.Correctness":
        request["evaluationReferenceInputs"] = [{
            "context": {"spanContext": {"sessionId": record["sessionId"], "traceId": record["traceId"]}},
            "expectedResponse": {"text": reference},
        }]
    return request


def checked_result(record, metric):
    response = record.get("results", {}).get(metric, {})
    results = response.get("evaluationResults", [])
    if len(results) != 1:
        raise ValueError("missing or duplicate results")
    result = results[0]
    if result.get("context", {}).get("spanContext") != {
        "sessionId": record["sessionId"], "traceId": record["traceId"],
    } or result.get("evaluatorId") != metric:
        raise ValueError("result target mismatch")
    if result.get("errorCode") or result.get("errorMessage"):
        raise ValueError("service result error")
    if response.get("ignoredReferenceInputFields") or result.get("ignoredReferenceInputFields"):
        raise ValueError("ground truth ignored")
    value = result.get("value")
    if not isinstance(value, (int, float)) or not math.isfinite(value) or not result.get("label"):
        raise ValueError("missing score or label")
    if not 0 <= value <= (6 if metric == "Builtin.Helpfulness" else 1):
        raise ValueError("score outside native scale")
    return result


def summarize(cases, records):
    by_id = {r["id"]: r for r in records}
    if len(by_id) != len(records) or set(by_id) - {c["id"] for c in cases}:
        raise ValueError("duplicate or unknown case records")
    report: dict[str, Any] = {}
    for group, sanity in (("baseline", False), ("sanity", True)):
        selected = [c for c in cases if bool(c.get("sanity")) == sanity]
        report[group] = {}
        for metric in METRICS:
            results = []
            for case in selected:
                try:
                    results.append(checked_result(by_id.get(case["id"], {}), metric))
                except (ValueError, KeyError):
                    pass
            report[group][metric] = {
                "expected": len(selected), "completed": len(results),
                "failed": len(selected) - len(results), "skipped": 0,
                "mean": mean(r["value"] for r in results) if results else None,
                "labels": dict(Counter(r["label"] for r in results)),
            }
    return report


ROOT = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_dataset():
    dataset = json.loads((ROOT / "dataset.json").read_text())
    cases = dataset["cases"]
    if len(cases) < 12 or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("dataset needs 12+ unique cases")
    for case in cases:
        for field in ("id", "prompts", "role", "preconditions", "fixture", "expectedResponse", "evidence"):
            if not case.get(field):
                raise ValueError(f"case missing {field}")
    ensure_safe(dataset)
    sanity = copy.deepcopy(cases[0])
    sanity.update(id="sanity-wrong-cost", sanity=True)
    cases.append(sanity)
    return dataset


def save(path, value):
    ensure_safe(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, default=str) + "\n")
    temporary.replace(path)


def invoke_cases(args, dataset):
    # Standalone process only. No production app imports, OTLP exporters, HTTP
    # instrumentation, Gateway tokens, memory, account inventory, or live tools.
    os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"] = ""
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    import boto3
    from botocore.config import Config
    from strands import Agent, tool
    from strands.models import BedrockModel

    sys.path.insert(0, str(ROOT.parent / "agentcore"))
    from system_prompt import build_system_prompt

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    model = BedrockModel(
        model_id=args.model, boto_session=session, temperature=0, max_tokens=1024,
        boto_client_config=Config(read_timeout=180, retries={"max_attempts": 2, "mode": "standard"}),
    )
    run = {
        "mode": dataset["mode"], "datasetVersion": dataset["version"],
        "datasetSha256": digest(ROOT / "dataset.json"),
        "testedCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceDirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()),
        "runnerSha256": digest(ROOT / "runner.py"),
        "promptSha256": digest(ROOT.parent / "agentcore/system_prompt.py"),
        "lockSha256": digest(ROOT / "uv.lock"),
        "date": datetime.now(timezone.utc).isoformat(), "region": args.region,
        "model": args.model, "temperature": 0, "maxTokens": 1024,
        "clock": dataset["clock"], "records": [],
    }
    prefixes = {"billing": "billingMcp___", "pricing": "pricingMcp__",
                "cloudwatch": "cloudwatchMcp___", "cloudtrail": "cloudtrailMcp___", "inventory": "inventoryMcp__"}
    for case in dataset["cases"]:
        if case.get("sanity"):
            source = run["records"][0]
            record = copy.deepcopy(source)
            record.update(id=case["id"], sanity=True, results={})
            if not record.get("error"):
                old_trace = record["traceId"]
                record["traceId"] = uuid.uuid4().hex
                record["turnTraceIds"] = [record["traceId"]]
                record["sessionId"] = str(uuid.uuid4())
                record["response"] = "The total cost was USD 9999 and S3 was the largest service at USD 9000."
                for span in record["spans"]:
                    span["attributes"]["session.id"] = record["sessionId"]
                    if span["traceId"] == old_trace:
                        span["traceId"] = record["traceId"]
                        if span["attributes"].get("gen_ai.operation.name") == "invoke_agent":
                            for event in span["events"]:
                                if event["name"] == "gen_ai.choice":
                                    event["attributes"]["message"] = json.dumps([{"text": record["response"]}])
                record["counterfactual"] = "Copied cost-total trace; only final agent answer deliberately corrupted. Not a model invocation."
            run["records"].append(record)
            save(args.output, run)
            continue
        record = {"id": case["id"], "sessionId": str(uuid.uuid4()), "results": {}}
        exporter.clear()
        name = prefixes[case["domain"]] + "get_demo_data"

        @tool(name=name)
        def get_demo_data(query: str) -> str:
            """Retrieve the complete fixed demo snapshot for this case. query describes the requested data."""
            return json.dumps(case["fixture"])

        @tool
        def x_amz_bedrock_agentcore_search(query: str) -> str:
            """Discover the available demo data tool by describing the requested data."""
            return json.dumps({"tool": name, "description": "Complete synthetic snapshot; call with query describing requested data."})

        try:
            agent = Agent(
                model=model, tools=[get_demo_data, x_amz_bedrock_agentcore_search],
                system_prompt=build_system_prompt(dataset["clock"]), callback_handler=None,
                trace_attributes={"session.id": record["sessionId"]},
            )
            for prompt in case["prompts"]:
                result = agent(prompt)
            if not provider.force_flush(timeout_millis=10000):
                raise ValueError("local telemetry flush timed out")
            record["spans"] = safe_spans(exporter.get_finished_spans(), record["sessionId"])
            agents = [s for s in record["spans"] if s["attributes"].get("gen_ai.operation.name") == "invoke_agent"]
            if len(agents) != len(case["prompts"]):
                raise ValueError("missing turn trace")
            record["traceId"] = agents[-1]["traceId"]
            record["turnTraceIds"] = [s["traceId"] for s in agents]
            record["response"] = str(result)
            # Strands invoke_agent usage aggregates its child model calls. Count
            # this once per turn, never add child/chat usage again.
            record["agentTokenUsage"] = {
                key: sum(s["attributes"].get(f"gen_ai.usage.{key}_tokens", 0) for s in agents)
                for key in ("input", "output", "total")
            }
            validate_content(record["spans"], record["traceId"])
            ensure_safe(record)
        except Exception as exc:
            # SDK messages can echo inputs/headers. Save exception class only.
            record = {"id": case["id"], "sessionId": record["sessionId"], "error": type(exc).__name__, "results": {}}
        run["records"].append(record)
        save(args.output, run)
        print(f"{case['id']}: {'FAILED ' + record['error'] if record.get('error') else 'captured'}", flush=True)
    return run


def score_cases(args, dataset, run):
    import boto3
    from botocore.config import Config

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    config = Config(read_timeout=300, retries={"max_attempts": 2, "mode": "standard"})
    client = session.client("bedrock-agentcore", config=config)
    control = session.client("bedrock-agentcore-control", config=config)
    run["evaluationDate"] = datetime.now(timezone.utc).isoformat()
    run["evaluationRegion"] = args.region
    run["scorerSha256"] = digest(ROOT / "runner.py")
    run["evaluators"] = {}
    for metric in METRICS:
        metadata = control.get_evaluator(evaluatorId=metric)
        metadata.pop("ResponseMetadata", None)
        run["evaluators"][metric] = metadata
    by_id = {r["id"]: r for r in run["records"]}
    summarize(dataset["cases"], run["records"])  # Reject ambiguous mappings before paid calls.
    for case in dataset["cases"]:
        record = by_id.get(case["id"])
        if record is None:
            record = {"id": case["id"], "error": "MissingCapture", "results": {}}
            run["records"].append(record)
        if record.get("error"):
            continue
        record["results"] = {}
        record.pop("evaluationErrors", None)
        for metric in METRICS:
            try:
                ensure_safe(record["spans"])
                validate_content(record["spans"], record["traceId"])
                response = client.evaluate(**evaluation_request(case, record, metric))
                response.pop("ResponseMetadata", None)
                ensure_safe(response)
                record["results"][metric] = response
                checked_result(record, metric)
            except Exception as exc:
                record.setdefault("evaluationErrors", {})[metric] = type(exc).__name__
            save(args.output, run)
            print(f"{case['id']} {metric}: {'FAILED' if metric in record.get('evaluationErrors', {}) else 'scored'}", flush=True)
    return run


def report_run(dataset, run):
    summary = summarize(dataset["cases"], run["records"])
    lines = ["# Fixture-backed evaluation results", "", f"Dataset: `{run['datasetVersion']}` / `{run['datasetSha256']}`",
             f"Tested commit: `{run['testedCommit']}` (dirty: {run['sourceDirty']})", "",
             "Means use successful case scores only; failures remain in expected counts. No pass threshold or overall score.", ""]
    for group, metrics in summary.items():
        lines += [f"## {group.title()}", "", "| Metric | Scale | Completed / expected | Failed | Skipped | Mean | Labels |",
                  "| --- | --- | --- | --- | --- | --- | --- |"]
        for metric, stats in metrics.items():
            score = "n/a" if stats["mean"] is None else f"{stats['mean']:.4f}"
            lines.append(f"| {metric} | {'0–6' if metric.endswith('Helpfulness') else '0–1'} | {stats['completed']} / {stats['expected']} | {stats['failed']} | {stats['skipped']} | {score} | {json.dumps(stats['labels'], sort_keys=True)} |")
        lines.append("")
    return summary, "\n".join(lines) + "\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("invoke", "score", "report"))
    parser.add_argument("--profile", help="Explicit AWS named profile; never defaults to the maintainer account")
    parser.add_argument("--region", help="Region supporting AgentCore Evaluations and the selected model")
    parser.add_argument("--model", help="Bedrock model or inference-profile ID available to your account")
    parser.add_argument("--allow-paid", action="store_true", help="Acknowledge model/judge charges and cross-Region processing")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("output already exists; choose a fresh path to preserve evidence")
    if args.command != "report" and not (args.profile and args.region and args.allow_paid):
        parser.error("paid commands require --profile, --region and --allow-paid")
    if args.command == "invoke" and not args.model:
        parser.error("invoke requires --model")
    if args.command != "invoke" and not args.input:
        parser.error("score/report require --input")
    logging.disable(logging.CRITICAL)
    dataset = load_dataset()
    if args.command == "invoke":
        run = invoke_cases(args, dataset)
        return int(any(r.get("error") for r in run["records"]))
    run = json.loads(args.input.read_text())
    ensure_safe(run)
    if run["mode"] != "synthetic-fixtures" or run["datasetSha256"] != digest(ROOT / "dataset.json"):
        raise ValueError("fixture mode/dataset hash mismatch; do not score stale references")
    if args.command == "score":
        run = score_cases(args, dataset, run)
    summary, markdown = report_run(dataset, run)
    if args.command == "report":
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(markdown)
    else:
        run["summary"] = summary
        save(args.output, run)
    print(markdown)
    return int(any(s["failed"] for group in summary.values() for s in group.values()))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Evaluation stopped: {type(error).__name__}. Check profile, Region, model access and input validity.", file=sys.stderr)
        raise SystemExit(1)
