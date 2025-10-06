#!/bin/bash

set -e

echo "=== Automatic Supabase Configuration ==="
echo ""

SUPABASE_DIR=${SUPABASE_PROJECT_DIR:-"../supabase/supabase-project"}
ARCHON_DIR="$(pwd)"

# Detect Supabase network
echo "Step 1: Detecting Supabase network configuration..."
# Try to find the Kong container using specific names first, then fall back to a generic name.
# This multi-step process supports different Supabase project naming conventions.
echo "   INFO: Looking for Supabase Kong container..."

KONG_CONTAINER=""
# First, try the most specific name 'supabase_kong_archon'
for container in $(docker ps --filter "name=supabase_kong_archon" --format "{{.Names}}"); do
    KONG_CONTAINER=$container
    break
done

# If not found, try the common 'supabase-kong' name
if [ -z "$KONG_CONTAINER" ]; then
    echo "   INFO: Could not find 'supabase_kong_archon', trying 'supabase-kong'..."
    for container in $(docker ps --filter "name=supabase-kong" --format "{{.Names}}"); do
        KONG_CONTAINER=$container
        break
    done
fi

# As a final fallback, try a generic 'kong' name
if [ -z "$KONG_CONTAINER" ]; then
    echo "   INFO: Could not find 'supabase-kong', trying generic 'kong'..."
    for container in $(docker ps --filter "name=kong" --format "{{.Names}}"); do
        KONG_CONTAINER=$container
        break
    done
fi


if [ -z "$KONG_CONTAINER" ]; then
    echo "❌ No Kong container found. Please start Supabase first:"
    echo "   cd $SUPABASE_DIR && docker compose up -d"
    exit 1
fi

echo "✅ Found Kong container: $KONG_CONTAINER"

# Get network name
NETWORKS=$(docker inspect "$KONG_CONTAINER" --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}} {{end}}')
SUPABASE_NETWORK=$(echo $NETWORKS | awk '{print $1}')
echo "✅ Detected network: $SUPABASE_NETWORK"

# Get Kong service name
cd "$SUPABASE_DIR" || exit 1
KONG_SERVICE=$(docker compose ps --format json | grep -i kong | head -1 | grep -o '"Service":"[^"]*' | cut -d'"' -f4)
if [ -z "$KONG_SERVICE" ]; then
    KONG_SERVICE="$KONG_CONTAINER"
fi
echo "✅ Detected Kong service: $KONG_SERVICE"

cd "$ARCHON_DIR" || exit 1

echo ""
echo "Step 2: Updating .env file..."
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Please create it from .env.example first:"
    echo "   cp .env.example .env"
    exit 1
fi

# Backup .env
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)
echo "✅ Created backup of .env"

# Update SUPABASE_URL in .env
if grep -q "^SUPABASE_URL=" .env; then
    # Use portable sed command
    sed "s|^SUPABASE_URL=.*|SUPABASE_URL=http://$KONG_SERVICE:8000|" .env > .env.tmp && mv .env.tmp .env
    echo "✅ Updated SUPABASE_URL in .env"
else
    echo "SUPABASE_URL=http://$KONG_SERVICE:8000" >> .env
    echo "✅ Added SUPABASE_URL to .env"
fi

echo ""
echo "Step 3: Updating docker-compose.yml..."
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ docker-compose.yml not found"
    exit 1
fi

# Backup docker-compose.yml
cp docker-compose.yml docker-compose.yml.backup.$(date +%Y%m%d_%H%M%S)
echo "✅ Created backup of docker-compose.yml"

# Check if the network is already configured
if grep -q "$SUPABASE_NETWORK:" docker-compose.yml; then
    echo "✅ Network $SUPABASE_NETWORK already configured in docker-compose.yml"
else
    # Update the networks section and service references
    # Use portable sed command with multiple expressions
    sed -e "s/supabase_default:/$SUPABASE_NETWORK:/g" -e "s/- supabase_default/- $SUPABASE_NETWORK/g" docker-compose.yml > docker-compose.yml.tmp && mv docker-compose.yml.tmp docker-compose.yml
    echo "✅ Updated network name in docker-compose.yml"
fi

# Verification step requested by user
grep -R "supabase_default" docker-compose.yml || echo "✅ No stale references to supabase_default found."

echo ""
echo "Step 4: Verifying configuration..."
echo "   SUPABASE_URL: http://$KONG_SERVICE:8000"
echo "   Network: $SUPABASE_NETWORK"

echo ""
echo "Step 5: Testing connectivity..."
TEST_RESULT=$(docker run --rm --network "$SUPABASE_NETWORK" curlimages/curl:latest -s -o /dev/null -w "%{http_code}" "http://$KONG_SERVICE:8000/rest/v1/" 2>&1)

if [ "$TEST_RESULT" = "200" ] || [ "$TEST_RESULT" = "401" ]; then
    echo "✅ Supabase is accessible (HTTP $TEST_RESULT)"
else
    echo "⚠️  Supabase returned HTTP $TEST_RESULT (may still work)"
fi

echo ""
echo "=== Configuration Complete ==="
echo ""
echo "Your Archon setup has been configured to connect to Supabase."
echo ""
echo "Next steps:"
echo "1. Review the changes in .env and docker-compose.yml"
echo "2. Start Archon services: docker compose up -d"
echo "3. Check logs: docker compose logs -f archon-server"
echo ""
echo "If you need to revert changes, backups are available:"
echo "  - .env.backup.*"
echo "  - docker-compose.yml.backup.*"
