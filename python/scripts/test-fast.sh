#!/bin/bash
set -e

# Fast test execution script for Archon backend
# Uses optimized configurations for maximum speed during development

echo "🚀 Running fast backend tests..."

# Change to python directory
cd "$(dirname "$0")/.."

# Export test environment variables for performance
export PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
export PYTHONDONTWRITEBYTECODE=1
export PYTHONUNBUFFERED=1
export LOG_LEVEL=ERROR
export PYTHONPATH="${PYTHONPATH}:$(pwd)"

# Run tests with fast configuration
echo "⚡ Executing unit tests with parallel processing..."

uv run pytest \
    -c pytest-fast.ini \
    --tb=line \
    --no-header \
    -q \
    --durations=5 \
    --maxfail=3 \
    "$@"

echo "✅ Fast tests completed!"