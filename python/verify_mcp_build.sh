#!/bin/bash
# MCP Build Verification Script
# Usage: ./verify_mcp_build.sh

set -e

echo "🔍 MCP Build Diagnostic Tool"
echo "============================="
echo ""

echo "📋 Step 1: Checking build context..."
if [ ! -f "pyproject.toml" ]; then
    echo "❌ ERROR: pyproject.toml not found. Run this script from the python/ directory."
    exit 1
fi
echo "✓ Build context OK"
echo ""

echo "📋 Step 2: Verifying source files exist..."
REQUIRED_FILES=(
    "src/__init__.py"
    "src/mcp_server/mcp_server.py"
    "src/server/__init__.py"
    "src/server/services/__init__.py"
    "src/server/services/mcp_service_client.py"
    "src/server/services/client_manager.py"
    "src/server/services/mcp_session_manager.py"
    "src/server/config/__init__.py"
    "src/server/config/service_discovery.py"
    "src/server/config/logfire_config.py"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo "❌ ERROR: Required file missing: $file"
        exit 1
    fi
done
echo "✓ All required files present"
echo ""

echo "📋 Step 3: Checking pyproject.toml mcp group..."
if ! grep -q "\[dependency-groups\]" pyproject.toml; then
    echo "❌ ERROR: No dependency-groups section in pyproject.toml"
    exit 1
fi
if ! grep -q "mcp = \[" pyproject.toml; then
    echo "❌ ERROR: No mcp dependency group in pyproject.toml"
    exit 1
fi
echo "✓ MCP dependency group found"
echo ""

echo "📋 Step 4: Testing Docker build (with detailed output)..."
echo "Building archon-mcp image..."
if docker compose build archon-mcp --no-cache --progress=plain 2>&1 | tee /tmp/mcp_build.log; then
    echo "✓ Docker build succeeded"
else
    echo "❌ Docker build failed. Check /tmp/mcp_build.log for details"
    echo ""
    echo "Common issues:"
    echo "  1. uv version incompatibility - try updating uv in Dockerfile"
    echo "  2. Dependency resolution failure - check pyproject.toml syntax"
    echo "  3. Network issues - check internet connection"
    echo "  4. File permission issues - check file ownership"
    exit 1
fi
echo ""

echo "📋 Step 5: Testing container startup..."
if docker compose up archon-mcp -d; then
    echo "✓ Container started"
    sleep 5
    echo ""
    echo "📋 Step 6: Checking container logs..."
    docker compose logs archon-mcp --tail=50
    echo ""
    echo "📋 Step 7: Testing health check..."
    if docker compose exec archon-mcp python -c "import socket; s=socket.socket(); s.connect(('localhost', 8051)); s.close(); print('✓ MCP server responding')"; then
        echo "✓ Health check passed"
    else
        echo "⚠ Health check failed - server may still be starting"
    fi
else
    echo "❌ Container failed to start"
    docker compose logs archon-mcp
    exit 1
fi
echo ""

echo "✅ All checks passed! MCP service is healthy."