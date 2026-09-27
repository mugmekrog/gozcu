# ------------------------------------------------------------------------------
# Google Cloud Run (Free Tier) Backend Container
# ------------------------------------------------------------------------------
# Optimized for:
# - Minimal image footprint using python:3.12-slim
# - Fast cold-start (< 200ms) with pre-baked pipeline fixtures
# - Stateless operation listening on $PORT (default 8080)
# - Scale-to-zero compatibility
# ------------------------------------------------------------------------------

FROM python:3.12-slim

# Prevent Python from writing .pyc files & enable unbuffered logging
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    PYTHONPATH="/app/libs:/app/services/api" \
    FIXTURES_DIR="/app/web/public/fixtures"

WORKDIR /app

# Install system dependencies if required
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first for optimal Docker layer caching
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy application libraries, services, scripts and data
COPY libs/ /app/libs/
COPY services/ /app/services/
COPY stage2/ /app/stage2/
COPY bounding_boxes.csv /app/bounding_boxes.csv
COPY goru.yaml /app/goru.yaml
COPY web/scripts/ /app/web/scripts/

# Pre-bake deterministic pipeline fixtures during image build for instant cold start
RUN mkdir -p /app/web/public/fixtures && \
    python web/scripts/export_fixtures.py

# Create a non-privileged user for Cloud Run security best practices
RUN mkdir -p /app/data/processed && \
    useradd -m -u 1000 appuser && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8080

# Cloud Run injects $PORT environment variable at runtime
CMD exec uvicorn app.api.rest:app --host 0.0.0.0 --port ${PORT} --workers 1
