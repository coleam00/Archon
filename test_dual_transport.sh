#!/bin/bash
# Test script for dual transport MCP server
# CRITICAL: Uses port 8060 to avoid interfering with production Archon on port 8051

set -e

echo "🔍 Checking production Archon is still running..."
docker ps --filter "name=archon-mcp" --format "{{.Names}} - {{.Status}}" | grep "archon-mcp" || {
    echo "❌ ERROR: Production archon-mcp is not running!"
    exit 1
}
echo "✅ Production Archon MCP is running on port 8051 (unchanged)"
echo ""

echo "🧪 Starting TEST MCP server on port 8060..."
echo "   Transport endpoints:"
echo "   → Streamable HTTP: http://localhost:8060/mcp"
echo "   → SSE: http://localhost:8060/sse"
echo ""

# Export test port
export ARCHON_MCP_PORT=8060
export ARCHON_MCP_ENABLE_SSE=true
export ARCHON_MCP_ENABLE_STREAMABLE_HTTP=true

# Load other environment variables from .env
if [ -f .env ]; then
    export $(grep -v '^#' .env | grep -v '^$' | xargs)
fi

# Re-export test port (override any .env setting)
export ARCHON_MCP_PORT=8060

echo "🚀 Launching test MCP server..."
echo "   (Press Ctrl+C to stop)"
echo ""

cd python
python3 src/mcp_server/mcp_server.py
