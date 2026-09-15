"""Metadata-only AgentCore traces. Never export message bodies or exception text."""
import os

import botocore.session
from amazon.opentelemetry.distro.exporter.otlp.aws.traces.otlp_aws_span_exporter import OTLPAwsSpanExporter
from opentelemetry import trace
from opentelemetry.instrumentation.botocore import BotocoreInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.starlette import StarletteInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
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
    'http.method', 'http.request.method', 'http.status_code', 'http.response.status_code',
    'http.route', 'rpc.system', 'rpc.service', 'rpc.method', 'aws.region',
    'aws.request_id', 'aws.request.id', 'server.address', 'server.port',
})


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
    provider = TracerProvider(resource=Resource.create({}))
    provider.add_span_processor(BatchSpanProcessor(MetadataOnlySpanExporter(
        aws_region=region, session=botocore.session.Session(),
        endpoint=f'https://xray.{region}.amazonaws.com/v1/traces',
    )))
    trace.set_tracer_provider(provider)
    StarletteInstrumentor.instrument_app(app, tracer_provider=provider)
    HTTPXClientInstrumentor().instrument(tracer_provider=provider)
    BotocoreInstrumentor().instrument(tracer_provider=provider)
