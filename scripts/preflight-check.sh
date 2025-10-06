#!/bin/bash

echo "=== Archon Pre-Flight Check ==="
echo ""

ERRORS=0
WARNINGS=0

# Check 1: .env file exists
echo "1. Checking .env file..."
if [ ! -f ".env" ]; then
    echo "   ❌ .env file not found"
    echo "      Create it from .env.example: cp .env.example .env"
    ERRORS=$((ERRORS + 1))
else
    echo "   ✅ .env file exists"
    
    # Check for required variables
    source .env
    
    if [ -z "$SUPABASE_URL" ]; then
        echo "   ❌ SUPABASE_URL not set in .env"
        ERRORS=$((ERRORS + 1))
    else
        echo "   ✅ SUPABASE_URL is set: $SUPABASE_URL"
    fi
    
    if [ -z "$SUPABASE_SERVICE_KEY" ]; then
        echo "   ❌ SUPABASE_SERVICE_KEY not set in .env"
        ERRORS=$((ERRORS + 1))
    else
        echo "   ✅ SUPABASE_SERVICE_KEY is set"
    fi
fi

echo ""
echo "2. Checking Docker..."
if ! command -v docker &> /dev/null; then
    echo "   ❌ Docker not found"
    ERRORS=$((ERRORS + 1))
else
    echo "   ✅ Docker is installed"
    
    if ! docker ps &> /dev/null; then
        echo "   ❌ Docker daemon not running"
        ERRORS=$((ERRORS + 1))
    else
        echo "   ✅ Docker daemon is running"
    fi
fi

echo ""
echo "3. Checking Supabase..."
KONG_CONTAINER=$(docker ps --filter "name=kong" --filter "ancestor=kong" --format "{{.Names}}" | head -1)

if [ -z "$KONG_CONTAINER" ]; then
    echo "   ❌ Supabase Kong container not running"
    echo "      Start Supabase first: cd supabase && supabase start"
    echo "      If issues persist, run: bash scripts/diagnose-network.sh"
    ERRORS=$((ERRORS + 1))
else
    echo "   ✅ Supabase Kong container is running: $KONG_CONTAINER"
    
    # Check Kong health
    KONG_HEALTH=$(docker inspect "$KONG_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null)
    if [ "$KONG_HEALTH" = "healthy" ]; then
        echo "   ✅ Kong is healthy"
    elif [ -z "$KONG_HEALTH" ]; then
        echo "   ⚠️  Kong has no health check configured. This is unusual."
        echo "      If you experience connection issues, run: bash scripts/diagnose-network.sh"
        WARNINGS=$((WARNINGS + 1))
    else
        echo "   ⚠️  Kong health status: $KONG_HEALTH. This might cause connection issues."
        echo "      If issues persist, run: bash scripts/diagnose-network.sh"
        WARNINGS=$((WARNINGS + 1))
    fi
fi

echo ""
echo "4. Checking Docker network configuration..."
if [ -n "$KONG_CONTAINER" ]; then
    NETWORKS=$(docker inspect "$KONG_CONTAINER" --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}} {{end}}')
    SUPABASE_NETWORK=$(echo $NETWORKS | awk '{print $1}')
    
    echo "   ✅ Supabase network detected: $SUPABASE_NETWORK"
    
    # Check if docker-compose.yml references this network
    if grep -q "$SUPABASE_NETWORK:" docker-compose.yml; then
        echo "   ✅ docker-compose.yml references correct network"
    else
        echo "   ❌ docker-compose.yml does not reference $SUPABASE_NETWORK"
        echo "      Run: bash scripts/auto-configure-supabase.sh"
        ERRORS=$((ERRORS + 1))
    fi
fi

echo ""
echo "5. Checking Supabase connectivity..."
if [ -n "$SUPABASE_URL" ] && [ -n "$KONG_CONTAINER" ]; then
    # Extract host from SUPABASE_URL
    SUPABASE_HOST=$(echo "$SUPABASE_URL" | sed 's|http://||' | sed 's|https://||' | cut -d: -f1)
    
    if [ "$SUPABASE_HOST" = "localhost" ] || [ "$SUPABASE_HOST" = "127.0.0.1" ]; then
        echo "   ⚠️  SUPABASE_URL uses localhost - this won't work from Docker containers"
        echo "      Run: bash scripts/auto-configure-supabase.sh"
        WARNINGS=$((WARNINGS + 1))
    elif [ "$SUPABASE_HOST" = "host.docker.internal" ]; then
        echo "   ⚠️  SUPABASE_URL uses host.docker.internal - network mode recommended"
        echo "      Run: bash scripts/auto-configure-supabase.sh"
        WARNINGS=$((WARNINGS + 1))
    else
        echo "   ✅ SUPABASE_URL uses service name: $SUPABASE_HOST"
        
        # Test connectivity from the Supabase network
        if [ -n "$SUPABASE_NETWORK" ]; then
            TEST_RESULT=$(docker run --rm --network "$SUPABASE_NETWORK" curlimages/curl:latest -s -o /dev/null -w "%{http_code}" "$SUPABASE_URL/rest/v1/" 2>&1)
            
            if [ "$TEST_RESULT" = "200" ] || [ "$TEST_RESULT" = "401" ]; then
                echo "   ✅ Supabase is accessible from Docker network (HTTP $TEST_RESULT)"
            else
                echo "   ❌ Supabase not accessible (HTTP $TEST_RESULT)"
                ERRORS=$((ERRORS + 1))
            fi
        fi
    fi
fi

echo ""
echo "6. Checking for port conflicts..."
PORTS=("8181" "8051" "8052" "3737")
PORT_NAMES=("ARCHON_SERVER" "ARCHON_MCP" "ARCHON_AGENTS" "ARCHON_UI")

for i in "${!PORTS[@]}"; do
    PORT="${PORTS[$i]}"
    NAME="${PORT_NAMES[$i]}"
    
    if netstat -ano 2>/dev/null | grep -q ":$PORT " || lsof -i ":$PORT" 2>/dev/null | grep -q LISTEN; then
        CONTAINER=$(docker ps --filter "publish=$PORT" --format "{{.Names}}" | head -1)
        if [ -n "$CONTAINER" ]; then
            echo "   ✅ Port $PORT ($NAME) in use by Docker container: $CONTAINER"
        else
            echo "   ⚠️  Port $PORT ($NAME) already in use by another process"
            WARNINGS=$((WARNINGS + 1))
        fi
    else
        echo "   ✅ Port $PORT ($NAME) is available"
    fi
done

echo ""
echo "=== Pre-Flight Check Summary ==="
echo ""
echo "Errors: $ERRORS"
echo "Warnings: $WARNINGS"
echo ""

if [ $ERRORS -gt 0 ]; then
    echo "❌ Pre-flight check FAILED"
    echo "   Please fix the errors above before starting Archon"
    exit 1
elif [ $WARNINGS -gt 0 ]; then
    echo "⚠️  Pre-flight check passed with warnings"
    echo "   Archon should start, but you may encounter issues"
    exit 0
else
    echo "✅ Pre-flight check PASSED"
    echo "   You can start Archon with: docker compose up -d"
    exit 0
fi
