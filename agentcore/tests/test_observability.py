"""Exercise the real Strands tracer at the OTLP export boundary; no AWS calls."""
import subprocess
import sys
from pathlib import Path


def test_export_keeps_trace_metadata_without_prompts_tokens_or_errors():
    # A subprocess isolates OpenTelemetry's set-once global provider from other tests.
    script = r'''
from unittest.mock import patch
import os
from opentelemetry import trace
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from observability import configure_observability

captured = []
class Response:
    status_code = 200
    ok = True
    text = ''
    reason = 'OK'

def receive(_session, url, **kwargs):
    message = ExportTraceServiceRequest()
    message.ParseFromString(kwargs['data'])
    captured.append(message)
    return Response()

from starlette.applications import Starlette
os.environ['AWS_REGION'] = 'us-east-1'
os.environ['AGENTCORE_RUNTIME_URL'] = 'https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/arn%3Aaws%3Abedrock-agentcore%3Aus-east-1%3A123456789012%3Aruntime%2Fcloudops_runtime-test/invocations'
# Exercise the production setup; substitute only its HTTP export boundary.
configure_observability(Starlette())
provider = trace.get_tracer_provider()
from strands.telemetry.tracer import Tracer
tracer = Tracer()
from bedrock_agentcore.runtime import BedrockAgentCoreContext
BedrockAgentCoreContext.set_request_context('test-request', 'test-session')
with patch('requests.Session.post', receive):
    parent = trace.get_tracer('test').start_span('request', attributes={
        'session.id': 'test-session', 'http.request.header.authorization': 'TOKEN_SENTINEL',
        'unexpected.attribute': 'UNKNOWN_SENTINEL',
    })
    with trace.use_span(parent):
        agent = tracer.start_agent_span(
            messages=[{'role': 'user', 'content': [{'text': 'PROMPT_SENTINEL'}]}],
            agent_name='CloudOps Agent', model_id='test-model',
        )
        tracer.end_agent_span(agent)
    span = tracer.start_model_invoke_span(
        messages=[{'role': 'user', 'content': [{'text': 'PROMPT_SENTINEL'}]}],
        parent_span=parent, model_id='test-model', system_prompt='SYSTEM_SENTINEL',
    )
    tracer.end_model_invoke_span(span,
        message={'role': 'assistant', 'content': [{'text': 'OUTPUT_SENTINEL'}]},
        usage={'inputTokens': 5, 'outputTokens': 3, 'totalTokens': 8},
        metrics={'latencyMs': 1}, stop_reason='end_turn',
    )
    tool = tracer.start_tool_call_span(
        {'name': 'test_tool', 'toolUseId': 'tool-1', 'input': {'secret': 'TOOL_INPUT_SENTINEL'}},
        parent_span=parent,
    )
    tracer.end_tool_call_span(tool, {'toolUseId': 'tool-1', 'status': 'success',
        'content': [{'text': 'TOOL_OUTPUT_SENTINEL'}]})
    failed = tracer.start_tool_call_span(
        {'name': 'test_tool', 'toolUseId': 'tool-2', 'input': {}}, parent_span=parent,
    )
    tracer.end_tool_call_span(failed, {'toolUseId': 'tool-2', 'status': 'error',
        'content': [{'text': 'ERROR_SENTINEL'}]}, error=RuntimeError('EXCEPTION_SENTINEL'))
    with trace.use_span(parent):
        # Botocore model CLIENT spans are what the console counts for usage.
        with trace.get_tracer('botocore').start_as_current_span('ConverseStream', kind=trace.SpanKind.CLIENT) as client:
            client.set_attribute('gen_ai.usage.input_tokens', 5)
            client.set_attribute('gen_ai.usage.output_tokens', 3)
    parent.end()
    provider.force_flush()

wire = '\n'.join(str(message) for message in captured)
assert captured, 'No spans exported'
for resource in [resource for message in captured for resource in message.resource_spans]:
    attrs = {a.key: a.value.string_value for a in resource.resource.attributes}
    assert attrs['service.name'] == 'cloudops_runtime.DEFAULT', attrs
    assert 'user.email' not in attrs
    assert attrs['aws.service.type'] == 'gen_ai_agent', attrs
    assert attrs['cloud.resource_id'] == 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/cloudops_runtime-test/runtime-endpoint/DEFAULT:DEFAULT', attrs
for sentinel in ['TOKEN', 'UNKNOWN', 'PROMPT', 'SYSTEM', 'OUTPUT', 'TOOL_INPUT', 'TOOL_OUTPUT', 'ERROR', 'EXCEPTION']:
    assert sentinel + '_SENTINEL' not in wire, f'{sentinel} content leaked'
for expected in ['test_tool', 'test-model', 'gen_ai.usage.input_tokens', 'test-session', 'STATUS_CODE_ERROR']:
    assert expected in wire, f'Metadata missing: {expected}'
spans = [span for message in captured for resource in message.resource_spans
         for scope in resource.scope_spans for span in scope.spans]
assert len(spans) == 6, f'Expected six exported spans, got {len(spans)}'
for span in spans:
    attrs = {a.key: a.value for a in span.attributes}
    assert attrs['session.id'].string_value == 'test-session', 'Session missing on a child/model span'
client_spans = [s for s in spans if s.kind == 3]  # OTLP SpanKind.CLIENT
assert sum(next(a.value.int_value for a in s.attributes if a.key == 'gen_ai.usage.input_tokens')
           for s in client_spans) == 5, 'Console-counted model usage missing'
assert len({span.trace_id for span in spans}) == 1, 'Trace correlation lost'
assert all(not span.events for span in spans), 'Content-bearing events exported'
assert all(not span.status.message for span in spans), 'Error text exported'
print('PASS: correlated model/tool spans, usage and error status; no sensitive content on OTLP wire')
'''
    result = subprocess.run(
        [sys.executable, '-c', script], cwd=Path(__file__).resolve().parents[1],
        text=True, capture_output=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
