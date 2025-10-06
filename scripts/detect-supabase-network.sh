#!/bin/bash

echo "=== Supabase Network Detection ==="
echo ""

SUPABASE_DIR=${SUPABASE_PROJECT_DIR:-"../supabase/supabase-project"}

# Check if Supabase directory exists
if [ ! -d "$SUPABASE_DIR" ]; then
    echo "❌ Supabase directory not found: $SUPABASE_DIR"
    echo "   Please update SUPABASE_DIR in this script"
    exit 1
fi

echo "1. Detecting Supabase containers..."
KONG_CONTAINER=$(docker ps --filter "name=supabase_kong_archon" --format "{{.Names}}")

if [ -z "$KONG_CONTAINER" ]; then
    echo "   ❌ No Kong container found"
    echo "   Is Supabase running? Start it with:"
    echo "   cd $SUPABASE_DIR && docker compose up -d"
    exit 1
fi

echo "   ✅ Found Kong container: $KONG_CONTAINER"

echo ""
echo "2. Detecting Docker networks..."
NETWORKS=$(docker inspect "$KONG_CONTAINER" --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}} {{end}}')

if [ -z "$NETWORKS" ]; then
    echo "   ❌ Kong container has no networks attached"
    exit 1
fi

echo "   ✅ Kong is connected to networks: $NETWORKS"

# Get the first network (usually the project network)
SUPABASE_NETWORK=$(echo $NETWORKS | awk '{print $1}')
echo "   📡 Primary network: $SUPABASE_NETWORK"

echo ""
echo "3. Detecting Kong service name..."
# Get the service name from docker compose
cd "$SUPABASE_DIR" || exit 1
KONG_SERVICE=$(docker compose ps --format json | grep -i kong | head -1 | grep -o '"Service":"[^"]*' | cut -d'"' -f4)

if [ -z "$KONG_SERVICE" ]; then
    # Fallback: use container name
    KONG_SERVICE="$KONG_CONTAINER"
fi

echo "   ✅ Kong service name: $KONG_SERVICE"

echo ""
echo "4. Testing Kong connectivity from network..."
KONG_IP=$(docker inspect "$KONG_CONTAINER" --format "{{.NetworkSettings.Networks.$SUPABASE_NETWORK.IPAddress}}")
echo "   Kong IP on $SUPABASE_NETWORK: $KONG_IP"

# Test if we can reach Kong from a temporary container on the same network
echo "   Testing HTTP connectivity..."
TEST_RESULT=$(docker run --rm --network "$SUPABASE_NETWORK" curlimages/curl:latest -s -o /dev/null -w "%{http_code}" "http://$KONG_SERVICE:8000/rest/v1/" 2>&1)

if [ "$TEST_RESULT" = "200" ] || [ "$TEST_RESULT" = "401" ]; then
    echo "   ✅ Kong is accessible on the network (HTTP $TEST_RESULT)"
else
    echo "   ⚠️  Kong returned HTTP $TEST_RESULT"
fi

echo ""
echo "=== Configuration Summary ==="
echo ""
echo "Add this to your Archon .env file:"
echo "SUPABASE_URL=http://$KONG_SERVICE:8000"
echo ""
echo "Update docker-compose.yml networks section:"
echo "networks:"
echo "  app-network:"
echo "    driver: bridge"
echo "  $SUPABASE_NETWORK:"
echo "    external: true"
echo ""
echo "Ensure archon-server service includes:"
echo "networks:"
echo "  - app-network"
echo "  - $SUPABASE_NETWORK"
echo ""
echo "=== Next Steps ==="
echo "1. Update .env with the SUPABASE_URL above"
echo "2. Update docker-compose.yml with the network configuration"
echo "3. Restart Archon: docker compose down && docker compose up -d"
