"""Offline checks at the evaluation request/report boundary."""
import pytest

from runner import evaluation_request, summarize, safe_spans, validate_content


def test_correctness_reference_targets_the_followup_trace():
    case = {"id": "followup", "expectedResponse": "There are two alarms."}
    record = {"sessionId": "session-one", "traceId": "trace-two", "spans": [{
        "traceId": "trace-two", "attributes": {"session.id": "session-one", "gen_ai.operation.name": "invoke_agent"},
        "events": [{"name": "gen_ai.user.message", "attributes": {"content": "How many?"}},
                   {"name": "gen_ai.choice", "attributes": {"message": "Two alarms."}}],
    }]}
    request = evaluation_request(case, record, "Builtin.Correctness")
    assert request["evaluationTarget"] == {"traceIds": ["trace-two"]}
    assert request["evaluationReferenceInputs"] == [{
        "context": {"spanContext": {"sessionId": "session-one", "traceId": "trace-two"}},
        "expectedResponse": {"text": "There are two alarms."},
    }]
    assert "evaluationReferenceInputs" not in evaluation_request(case, record, "Builtin.Helpfulness")
    with pytest.raises(ValueError, match="ground truth"):
        evaluation_request({"id": "missing"}, record, "Builtin.Correctness")


def test_report_counts_missing_and_wrong_target_results_not_just_successes():
    cases = [{"id": name} for name in ("ok", "missing", "wrong", "sanity")]
    records = [{"id": c["id"], "sessionId": c["id"], "traceId": "trace", "results": {}}
               for c in cases]
    result = {"evaluatorId": "Builtin.Correctness", "value": 1.0, "label": "Correct",
              "context": {"spanContext": {"sessionId": "ok", "traceId": "trace"}}}
    records[0]["results"] = {"Builtin.Correctness": {"evaluationResults": [result]}}
    records[2]["results"] = records[0]["results"]
    cases[3]["sanity"] = True
    report = summarize(cases, records)
    assert report["baseline"]["Builtin.Correctness"] == {
        "expected": 3, "completed": 1, "failed": 2, "skipped": 0,
        "mean": 1.0, "labels": {"Correct": 1},
    }
    assert report["sanity"]["Builtin.Correctness"]["expected"] == 1


def test_export_only_keeps_approved_strands_content_and_rejects_secrets():
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    with provider.get_tracer("strands.telemetry.tracer").start_as_current_span("invoke_agent") as span:
        span.set_attribute("gen_ai.operation.name", "invoke_agent")
        span.set_attribute("http.headers", "private-marker")
        span.add_event("exception", {"exception.message": "private-marker"})
        span.add_event("gen_ai.user.message", {"content": "How many alarms?", "secret": "private-marker"})
        span.add_event("gen_ai.choice", {"message": "Two alarms."})
    exported = safe_spans(exporter.get_finished_spans(), "session")
    assert "private-marker" not in str(exported)
    assert exported[0]["attributes"]["session.id"] == "session"
    validate_content(exported, exported[0]["traceId"])
    exported[0]["events"] = []
    with pytest.raises(ValueError, match="content"):
        validate_content(exported, exported[0]["traceId"])
    with provider.get_tracer("strands.telemetry.tracer").start_as_current_span("invoke_agent") as span:
        span.add_event("gen_ai.choice", {"message": "Bearer eyJhbGciOiJIUzI1NiJ9.abcdef.signature"})
    with pytest.raises(ValueError, match="sensitive"):
        safe_spans(exporter.get_finished_spans(), "session")


def test_evaluation_refuses_incomplete_or_cross_session_content():
    case = {"id": "one", "expectedResponse": "Two alarms."}
    record = {"sessionId": "one", "traceId": "trace", "spans": []}
    with pytest.raises(ValueError, match="content"):
        evaluation_request(case, record, "Builtin.Correctness")
    record["spans"] = [{"traceId": "trace", "attributes": {
        "session.id": "other", "gen_ai.operation.name": "invoke_agent",
    }, "events": [{"name": "gen_ai.user.message", "attributes": {"content": "How many?"}},
                  {"name": "gen_ai.choice", "attributes": {"message": "Two alarms."}}]}]
    with pytest.raises(ValueError, match="session"):
        evaluation_request(case, record, "Builtin.Correctness")


@pytest.mark.parametrize("field", ["ignoredReferenceInputFields", "errorCode"])
def test_report_does_not_accept_ignored_ground_truth_or_service_errors(field):
    result = {"evaluatorId": "Builtin.Correctness", "value": 1.0, "label": "Correct",
              "context": {"spanContext": {"sessionId": "one", "traceId": "trace"}},
              field: ["expectedResponse"] if field == "ignoredReferenceInputFields" else "InternalError"}
    record = {"id": "one", "sessionId": "one", "traceId": "trace",
              "results": {"Builtin.Correctness": {"evaluationResults": [result]}}}
    stats = summarize([{"id": "one"}], [record])["baseline"]["Builtin.Correctness"]
    assert stats["completed"] == 0
    assert stats["failed"] == 1
    assert stats["mean"] is None
