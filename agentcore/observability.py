"""Metadata-only AgentCore traces. Never export message bodies or exception text."""
import os
from urllib.parse import parse_qs, unquote, urlparse

import botocore.session
from bedrock_agentcore.runtime import BedrockAgentCoreContext
from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter
from opentelemetry import propagate, trace
from opentelemetry.propagators.aws import AwsXRayPropagator
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator
from opentelemetry.instrumentation.botocore import BotocoreInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.starlette import StarletteInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status

# An allowlist also covers future framework attributes and error responses, which
# content-capture flags alone do not redact. Keep correlation, not user identity.
METADATA_ATTRIBUTES = frozenset({
    'session.id', 'gen_ai.operation.name', 'gen_ai.system', 'gen_ai.provider.name',
    'gen_ai.agent.name', 'gen_ai.request.model', 'gen_ai.response.model',
    'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.status',
    'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens',
    'gen_ai.usage.total_tokens', 'gen_ai.usage.prompt_tokens',
    'gen_ai.usage.completion_tokens', 'gen_ai.event.start_time', 'gen_ai.event.end_time',
    'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_write.input_tokens',
    'gen_ai.usage.cache_read_input_tokens', 'gen_ai.usage.cache_write_input_tokens',
    'http.method', 'http.request.method', 'http.status_code', 'http.response.status_code',
    'http.route', 'rpc.system', 'rpc.service', 'rpc.method', 'aws.region',
    'aws.request_id', 'aws.request.id', 'server.address', 'server.port',
})


class SessionSpanProcessor(SpanProcessor):
    """Attach session identity before export runs on a different thread."""

    def on_start(self, span, parent_context=None):
        session_id = BedrockAgentCoreContext.get_session_id()
        if session_id:
            span.set_attribute('session.id', session_id)


class MetadataOnlySpanExporter(OTLPAwsSpanExporter):
    """Filter before ADOT can extract content into a separate OTEL log stream."""

    def export(self, spans):
        return super().export([
            ReadableSpan(
                name=span.name, context=span.context, parent=span.parent,
                resource=span.resource, kind=span.kind,
                instrumentation_scope=span.instrumentation_scope,
                start_time=span.start_time, end_time=span.end_time,
                attributes={k: v for k, v in span.attributes.items() if k in METADATA_ATTRIBUTES},
                # Events, links and status descriptions can contain raw payloads.
                status=Status(span.status.status_code),
            )
            for span in spans
        ])


def configure_observability(app):
    """Own the exporter pipeline; do not also launch via opentelemetry-instrument."""
    region = os.environ['AWS_REGION']
    runtime_url = urlparse(os.environ['AGENTCORE_RUNTIME_URL'])
    runtime_arn = unquote(runtime_url.path.split('/runtimes/', 1)[1].split('/invocations', 1)[0])
    runtime_id = runtime_arn.rsplit('/', 1)[1]
    runtime_name = runtime_id.rsplit('-', 1)[0]
    endpoint = parse_qs(runtime_url.query).get('qualifier', ['DEFAULT'])[0]
    # DISABLE_ADOT_OBSERVABILITY also disables the platform's OTEL resource setup.
    # Reconstruct only trusted platform metadata, not ambient OTEL_RESOURCE_ATTRIBUTES.
    resource = Resource({
        'service.name': f'{runtime_name}.{endpoint}',
        'aws.service.type': 'gen_ai_agent',
        'cloud.provider': 'aws',
        'cloud.platform': 'aws_bedrock_agentcore',
        'cloud.region': region,
        'cloud.resource_id': f'{runtime_arn}/runtime-endpoint/{endpoint}:{endpoint}',
        'aws.log.group.names': f'/aws/bedrock-agentcore/runtimes/{runtime_id}-{endpoint}',
    })
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(SessionSpanProcessor())
    propagate.set_global_textmap(CompositePropagator([
        AwsXRayPropagator(), TraceContextTextMapPropagator(),
    ]))
    provider.add_span_processor(BatchSpanProcessor(MetadataOnlySpanExporter(
        aws_region=region, session=botocore.session.Session(),
        endpoint=f'https://xray.{region}.amazonaws.com/v1/traces',
    )))
    trace.set_tracer_provider(provider)
    StarletteInstrumentor.instrument_app(app, tracer_provider=provider)
    HTTPXClientInstrumentor().instrument(tracer_provider=provider)
    BotocoreInstrumentor().instrument(tracer_provider=provider)
