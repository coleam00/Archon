#!/bin/bash
# Basic HTTPS setup verification tests

set -e

echo "🧪 Testing HTTPS Setup Configuration..."

# Test 1: Verify Caddyfile exists and has basic structure
echo "✅ Test 1: Checking Caddyfile structure..."
if [ -f "Caddyfile" ]; then
    echo "✅ Caddyfile exists"
    if grep -q "{\$DOMAIN}" Caddyfile && grep -q "reverse_proxy" Caddyfile; then
        echo "✅ Caddyfile has required HTTPS configuration"
    else
        echo "❌ Caddyfile missing required configuration"
        exit 1
    fi
else
    echo "❌ Caddyfile not found"
    exit 1
fi

# Test 2: Verify Docker Compose syntax
echo "✅ Test 2: Validating docker-compose.yml..."
if docker compose config > /dev/null 2>&1; then
    echo "✅ docker-compose.yml syntax is valid"
else
    echo "❌ docker-compose.yml validation failed"
    exit 1
fi

# Test 3: Verify environment variable parsing
echo "✅ Test 3: Testing environment variable parsing..."
export DOMAIN="test-domain.com"
export ARCHON_SERVER_PORT="8181"

if docker compose config | grep -q "test-domain.com"; then
    echo "✅ DOMAIN environment variable is properly parsed"
else
    echo "❌ DOMAIN environment variable parsing failed"
    exit 1
fi

# Test 4: Verify HTTPS service networking
echo "✅ Test 4: Checking HTTPS service configuration..."
if docker compose config | grep -q "caddy"; then
    echo "✅ Caddy service is properly configured"
else
    echo "❌ Caddy service configuration missing"
    exit 1
fi

if docker compose config | grep -q '"443"'; then
    echo "✅ HTTPS port mapping is configured"
else
    echo "❌ HTTPS port mapping missing"
    exit 1
fi

# Test 5: Verify volumes for certificate persistence
echo "✅ Test 5: Checking certificate storage volumes..."
if docker compose config | grep -q "caddy_data"; then
    echo "✅ Certificate storage volumes configured"
else
    echo "❌ Certificate storage volumes missing"
    exit 1
fi

echo ""
echo "🎉 All HTTPS configuration tests passed!"
echo "ℹ️  Note: Actual SSL certificate tests require a real domain and DNS setup"