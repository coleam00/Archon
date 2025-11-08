"""OpenTelemetry tracing configuration."""

import os
from typing import Optional

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def setup_tracing(app) -> Optional[TracerProvider]:
    """
    Configure OpenTelemetry tracing for FastAPI application.

    This function sets up distributed tracing using the OpenTelemetry standard.
    Traces are exported to an OTLP endpoint (compatible with Logfire, Jaeger, etc.).

    Args:
        app: FastAPI application instance to instrument

    Returns:
        TracerProvider instance if tracing is enabled, None otherwise

    Environment Variables:
        TESTING: Skip tracing setup if set (for test environment)
        OTEL_EXPORTER_OTLP_ENDPOINT: OTLP endpoint URL (default: http://localhost:4317)
    """
    if os.getenv("TESTING"):
        return None

    resource = Resource(attributes={SERVICE_NAME: "archon-server"})

    provider = TracerProvider(resource=resource)

    otlp_exporter = OTLPSpanExporter(
        endpoint=os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4317"),
        insecure=True,
    )

    provider.add_span_processor(BatchSpanProcessor(otlp_exporter))
    trace.set_tracer_provider(provider)

    FastAPIInstrumentor.instrument_app(app)

    return provider
