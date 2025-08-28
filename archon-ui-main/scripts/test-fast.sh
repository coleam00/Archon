#!/bin/bash
set -e

# Fast test execution script for Archon frontend
# Uses optimized Vitest configuration for maximum speed during development

echo "🚀 Running fast frontend tests..."

# Change to frontend directory
cd "$(dirname "$0")/.."

# Export environment variables for performance
export NODE_ENV=test
export VITE_TEST_MODE=true
export VITE_DISABLE_ANIMATIONS=true
export VITE_DISABLE_LAZY_LOADING=true

# Run tests with fast configuration
echo "⚡ Executing unit tests with optimized Vitest config..."

npx vitest run \
    --config vitest-fast.config.ts \
    --reporter=basic \
    --no-coverage \
    "$@"

echo "✅ Fast frontend tests completed!"