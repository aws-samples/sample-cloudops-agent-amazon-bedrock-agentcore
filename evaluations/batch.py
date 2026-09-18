"""Publish approved synthetic traces and run console-visible AgentCore batch jobs."""
import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import time
import uuid
from typing import Any

import boto3

from runner import METRICS, ROOT, digest, ensure_safe, evaluation_request, load_dataset, summarize

SERVICE = "cloudops_fixture_evaluation"


def batch_request(dataset, run, name, log_group, sanity):
    summarize(dataset["cases"], run["records"])
    records = {r["id"]: r for r in run["records"]}
    targets, references = [], []
    for case in dataset["cases"]:
        if bool(case.get("sanity")) != sanity:
            continue
        record = records[case["id"]]
        evaluation_request(case, record, "Builtin.Correctness")
        targets.append({"sessionId": record["sessionId"], "traceIds": [record["traceId"]]})
        references.append({
            "sessionId": record["sessionId"], "testScenarioId": case["id"],
            "groundTruth": {"inline": {"turns": [{
                "input": {"prompt": case["prompts"][-1]},
                "expectedResponse": {"text": case["expectedResponse"]},
            }]}},
        })
    return {
        "batchEvaluationName": name, "clientToken": str(uuid.uuid4()),
        "description": "Synthetic CloudOps fixtures; " + ("wrong-answer sanity only" if sanity else "12-case baseline; excludes sanity"),
        "evaluators": [{"evaluatorId": metric} for metric in METRICS],
        "dataSourceConfig": {"cloudWatchLogs": {
            "serviceNames": [SERVICE], "logGroupNames": [log_group],
            "filterConfig": {"sessionTraceIds": targets},
        }},
        "evaluationMetadata": {"sessionMetadata": references},
    }


def write_local(path, value):
    # Job ARNs contain the caller's account. Keep this file in gitignored runs/.
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, default=str) + "\n")
    temporary.replace(path)


def check_batch(job, expected):
    stats = job.get("evaluationResults", {})
    summaries = stats.get("evaluatorSummaries", [])
    if (job["status"] != "COMPLETED" or stats.get("numberOfSessionsCompleted") != expected
            or stats.get("totalNumberOfSessions") != expected
            or stats.get("numberOfSessionsFailed") != 0 or stats.get("numberOfSessionsIgnored") != 0
            or len(summaries) != len(METRICS)
            or {s["evaluatorId"] for s in summaries} != set(METRICS)
            or any(s["totalEvaluated"] != expected or s["totalFailed"] != 0 for s in summaries)):
        raise ValueError("incomplete batch results; inspect job errors")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--allow-paid", required=True, action="store_true")
    args = parser.parse_args()
    if args.output.exists():
        parser.error("choose a new output path")
    run = json.loads(args.input.read_text())
    ensure_safe(run)
    if run["mode"] != "synthetic-fixtures" or run["datasetSha256"] != digest(ROOT / "dataset.json"):
        raise ValueError("fixture mode/dataset mismatch")
    dataset = load_dataset()
    suffix = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    group = f"/cloudops/evaluations/fixtures/{suffix}"
    requests = [batch_request(dataset, run, f"cloudops_{kind}_{suffix}", group, sanity)
                for kind, sanity in (("baseline", False), ("sanity", True))]
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    identity = session.client("sts").get_caller_identity()
    print(f"Account: {identity['Account']}; Region: {args.region}", flush=True)
    logs = session.client("logs")
    client = session.client("bedrock-agentcore")
    logs.create_log_group(logGroupName=group, tags={"purpose": "cloudops-synthetic-evaluations"})
    logs.put_retention_policy(logGroupName=group, retentionInDays=7)
    logs.create_log_stream(logGroupName=group, logStreamName="synthetic-spans")
    events: list[dict[str, Any]] = []
    timestamp = int(time.time() * 1000)
    for record in run["records"]:
        for original in record["spans"]:
            span = copy.deepcopy(original)
            span["resource"] = {"attributes": {"service.name": SERVICE}}
            span["attributes"]["aws.local.service"] = SERVICE
            ensure_safe(span)
            events.append({"timestamp": timestamp, "message": json.dumps(span)})
    # Each approved dataset fits below the 1 MiB PutLogEvents limit; fail before
    # upload if a future dataset grows past it instead of dropping records.
    if sum(len(e["message"].encode()) + 26 for e in events) > 1_048_576:
        raise ValueError("trace upload exceeds one CloudWatch batch")
    uploaded = logs.put_log_events(logGroupName=group, logStreamName="synthetic-spans", logEvents=events)
    if uploaded.get("rejectedLogEventsInfo"):
        raise ValueError("CloudWatch rejected input events")
    evidence = {"region": args.region, "logGroup": group, "uploadedSpans": len(events),
                "sourceSha256": digest(args.input), "jobs": []}
    write_local(args.output, evidence)
    # Poll actual query visibility rather than assuming a fixed ingestion delay.
    for attempt in range(60):
        query_id = logs.start_query(
            logGroupName=group, startTime=timestamp // 1000 - 60,
            endTime=int(time.time()) + 60,
            queryString='filter ispresent(scope.name) and ispresent(spanId) | stats count(*) as spans',
        )["queryId"]
        for _ in range(30):
            response = logs.get_query_results(queryId=query_id)
            if response["status"] not in {"Scheduled", "Running"}:
                break
            time.sleep(1)
        visible = sum(int(f["value"]) for row in response.get("results", [])
                      for f in row if f["field"] == "spans")
        if response["status"] == "Complete" and visible == len(events):
            break
        print(f"Telemetry visible: {visible}/{len(events)}", flush=True)
        time.sleep(5)
    else:
        raise TimeoutError("telemetry ingestion incomplete")
    for request in requests:
        job = client.start_batch_evaluation(**request)
        job.pop("ResponseMetadata", None)
        evidence["jobs"].append(job)
        write_local(args.output, evidence)
        print(f"Started {job['batchEvaluationId']}", flush=True)
    for index, job in enumerate(evidence["jobs"]):
        for attempt in range(120):
            result = client.get_batch_evaluation(batchEvaluationId=job["batchEvaluationId"])
            result.pop("ResponseMetadata", None)
            evidence["jobs"][index] = result
            write_local(args.output, evidence)
            print(f"{result['batchEvaluationName']}: {result['status']}", flush=True)
            if result["status"] not in {"PENDING", "IN_PROGRESS"}:
                break
            time.sleep(10)
        else:
            raise TimeoutError("job still running; inspect saved batch ID")
    for job, request in zip(evidence["jobs"], requests, strict=True):
        expected = len(request["evaluationMetadata"]["sessionMetadata"])
        check_batch(job, expected)
        output = job["outputConfig"]["cloudWatchConfig"]
        for attempt in range(60):
            details: list[dict[str, Any]] = []
            token = None
            while True:
                params = {"logGroupName": output["logGroupName"],
                          "logStreamName": output["logStreamName"], "startFromHead": True}
                if token:
                    params["nextToken"] = token
                page = logs.get_log_events(**params)
                details.extend(json.loads(e["message"]) for e in page["events"])
                if page["nextForwardToken"] == token:
                    break
                token = page["nextForwardToken"]
            wanted = {(t["sessionId"], t["traceIds"][0], metric)
                      for t in request["dataSourceConfig"]["cloudWatchLogs"]["filterConfig"]["sessionTraceIds"]
                      for metric in METRICS}
            actual = {(e["attributes"].get("session.id"), e.get("traceId"),
                       e["attributes"].get("gen_ai.evaluation.name")) for e in details}
            if actual == wanted and len(details) == len(wanted):
                break
            time.sleep(5)
        else:
            raise ValueError("missing or mismatched per-session output")
        job["perSessionResults"] = details
        write_local(args.output, evidence)


if __name__ == "__main__":
    main()
