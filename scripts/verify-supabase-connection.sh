#!/bin/bash

echo "=== Archon → Supabase Connection Verification ==="
echo ""

echo "1. Checking Archon .env configuration..."
if [ ! -f ".env" ]; then
    echo "   ❌ .env file missing"
    exit 1
fi

source .env

if [ -z "$SUPABASE_URL" ]; then
    echo "   ❌ SUPABASE_URL not set in .env"
    exit 1
fi

if [ -z "$SUPABASE_SERVICE_KEY" ]; then
    echo "   ❌ SUPABASE_SERVICE_KEY not set in .env"
    exit 1
fi

echo "   ✅ SUPABASE_URL: $SUPABASE_URL"
echo "   ✅ SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY:0:20}..."

echo ""
echo "2. Testing Supabase REST API..."
RESPONSE=$(curl -s -o /dev/null -w '%{http_code}' "$SUPABASE_URL/rest/v1/")
if [ "$RESPONSE" = "200" ] || [ "$RESPONSE" = "401" ]; then
    echo "   ✅ Supabase REST API responding (HTTP $RESPONSE)"
elif [ "$RESPONSE" = "404" ]; then
    echo "   ❌ Supabase returning 404 - Check if Kong is running on correct port"
    echo "   Current SUPABASE_URL: $SUPABASE_URL"
    echo "   Expected: http://host.docker.internal:8000 (for local Supabase)"
    exit 1
else
    echo "   ❌ Supabase not responding (HTTP $RESPONSE)"
    exit 1
fi

echo ""
echo "3. Testing Supabase Auth API..."
RESPONSE=$(curl -s -o /dev/null -w '%{http_code}' "$SUPABASE_URL/auth/v1/health")
if [ "$RESPONSE" = "200" ]; then
    echo "   ✅ Supabase Auth API responding (HTTP $RESPONSE)"
else
    echo "   ⚠️  Supabase Auth API returned HTTP $RESPONSE"
fi

echo ""
echo "4. Testing authenticated request..."
RESPONSE=$(curl -s -w '\nHTTP_CODE:%{http_code}' \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  "$SUPABASE_URL/rest/v1/")

HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | grep -v "HTTP_CODE")

if [ "$HTTP_CODE" = "200" ]; then
    echo "   ✅ Authenticated request successful"
    echo "   Response: $BODY"
else
    echo "   ❌ Authenticated request failed (HTTP $HTTP_CODE)"
    echo "   Response: $BODY"
    exit 1
fi

echo ""
echo "5. Checking Supabase Kong gateway..."
if [ "$SUPABASE_URL" = "http://host.docker.internal:8000" ]; then
    KONG_STATUS=$(docker inspect --format='{{.State.Status}}'supabase-kong 2>/dev/null)
    if [ "$KONG_STATUS" = "running" ]; then
        echo "   ✅ Kong container is running"
    else
        echo "   ❌ Kong container not running: $KONG_STATUS"
        echo "   Start Supabase with: cd A:/Experiment/supabase/supabase-project && docker compose up -d"
        exit 1
    fi
else
    echo "   ℹ️  Using cloud Supabase (skipping local Kong check)"
fi

echo ""
echo "6. Checking Supabase analytics (optional)..."
if [ "$SUPABASE_URL" = "http://host.docker.internal:8000" ]; then
    ANALYTICS_HEALTH=$(docker inspect --format='{{.State.Health.Status}}'supabase-analytics 2>/dev/null)
    if [ "$ANALYTICS_HEALTH" = "healthy" ]; then
        echo "   ✅ Analytics container is healthy"
    else
        echo "   ⚠️  Analytics container status: $ANALYTICS_HEALTH"
        echo "   This may cause Kong 502 errors. Run fix script:"
        echo "   ./scripts/fix-supabase-analytics.sh"
    fi
fi

echo ""
echo "=== Verification Complete ==="
echo "Archon should be able to connect to Supabase successfully."
echo ""
echo "Next steps:"
echo "1. Start Archon services: docker compose up -d"
echo "2. Check Archon logs: docker compose logs -f archon-server"
echo "3. Access Archon UI: http://localhost:3737"
