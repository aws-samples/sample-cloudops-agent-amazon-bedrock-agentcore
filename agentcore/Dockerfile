# Multi-stage build for FinOps Agent Runtime
FROM public.ecr.aws/docker/library/python:3.14-slim AS builder

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    make \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy requirements and install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Final stage
FROM public.ecr.aws/docker/library/python:3.14-slim

# Create non-root user for running the application
RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

# Set working directory
WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.14/site-packages /usr/local/lib/python3.14/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code
COPY agent_runtime.py .
COPY system_prompt.py .
COPY observability.py .
COPY streamable_http_sigv4.py .
# Bearer transport (per-user JWT forwarding) and the pure authorization model
# (role derivation + denial-response helpers) are imported by agent_runtime.py.
COPY streamable_http_bearer.py .
COPY authorization_model.py .

# Set ownership to non-root user
RUN chown -R appuser:appuser /app

# Set environment variables
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1
# One explicitly configured, metadata-only exporter; never add an unfiltered pipeline.
ENV DISABLE_ADOT_OBSERVABILITY=true
ENV OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=false
ENV OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental,gen_ai_unredacted_attributes=

# Switch to non-root user
USER appuser

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import sys; sys.exit(0)" || exit 1

# Run the agent runtime
CMD ["python", "agent_runtime.py"]
