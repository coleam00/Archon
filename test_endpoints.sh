#!/bin/bash
# Test both MCP transport endpoints
# Tests the dual transport implementation on port 8060

set -e

TEST_PORT=8060
BASE_URL="http://localhost:${TEST_PORT}"

echo "🧪 Testing Dual Transport MCP Server on port ${TEST_PORT}"
echo "=================================================="
echo ""

# First verify production is untouched
echo "🔒 SAFETY CHECK: Verifying production Archon (port 8051) is still running..."
docker ps --filter "name=archon-mcp" --format "{{.Names}} - {{.Status}}" | grep "archon-mcp" || {
    echo "❌ ERROR: Production archon-mcp is not running!"
    exit 1
}
echo "✅ Production Archon MCP confirmed running on port 8051"
echo ""

# Test Streamable HTTP endpoint
echo "📡 Test 1: Streamable HTTP transport at /mcp"
echo "   Endpoint: ${BASE_URL}/mcp"
echo -n "   Testing connection... "

# Simple HTTP test
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/mcp" -H "Accept: application/json" 2>&1 || echo "ERROR")

if echo "$HTTP_RESPONSE" | tail -1 | grep -qE "^(200|400|405)$"; then
    echo "✅ Streamable HTTP endpoint responding"
else
    echo "⚠️  Response: $HTTP_RESPONSE"
fi
echo ""

# Test SSE endpoint
echo "📡 Test 2: SSE transport at /sse"
echo "   Endpoint: ${BASE_URL}/sse"
echo -n "   Testing connection... "

SSE_RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "${BASE_URL}/sse" -H "Accept: text/event-stream" 2>&1 || echo "ERROR")

if echo "$SSE_RESPONSE" | tail -1 | grep -qE "^(200|400|405)$"; then
    echo "✅ SSE endpoint responding"
else
    echo "⚠️  Response: $SSE_RESPONSE"
fi
echo ""

# Test MCP API config endpoint (from server)
echo "📡 Test 3: MCP API config endpoint"
echo "   Endpoint: http://localhost:8181/api/mcp/config"
echo -n "   Testing transport_endpoints field... "

CONFIG_RESPONSE=$(curl -s http://localhost:8181/api/mcp/config)
if echo "$CONFIG_RESPONSE" | grep -q "transport_endpoints"; then
    echo "✅ Config endpoint includes transport_endpoints"
    echo ""
    echo "   Response preview:"
    echo "$CONFIG_RESPONSE" | python3 -m json.tool 2>/dev/null | head -20 || echo "$CONFIG_RESPONSE"
else
    echo "⚠️  transport_endpoints field not found"
fi
echo ""

echo "=================================================="
echo "✅ Testing complete!"
echo ""
echo "Summary:"
echo "  - Production Archon (port 8051): ✅ Running"
echo "  - Test server (port 8060): Check results above"
echo ""
