#!/bin/bash

SUPABASE_DIR="A:/Experiment/supabase/supabase-project"

echo "=== Supabase Analytics Diagnostics ===="
echo ""

echo "1. Checking if Supabase directory exists..."
if [ -d "$SUPABASE_DIR" ]; then
    echo "   ✅ Supabase directory found: $SUPABASE_DIR"
else
    echo "   ❌ Supabase directory not found: $SUPABASE_DIR"
    echo "   Please update SUPABASE_DIR variable in this script"
    exit 1
fi

cd "$SUPABASE_DIR" || exit 1

echo ""
echo "2. Checking if .env file exists..."
if [ -f ".env" ]; then
    echo "   ✅ .env file found"
else
    echo "   ❌ .env file missing - copy from .env.example and configure"
    echo "   Run: cd $SUPABASE_DIR && cp .env.example .env"
    echo "   Then edit .env and set secure passwords and LOGFLARE tokens"
    exit 1
fi

echo ""
echo "3. Checking analytics container status..."
docker compose ps analytics

echo ""
echo "4. Checking analytics container health..."
HEALTH=$(docker inspect --format='{{.State.Health.Status}}' supabase-analytics 2>/dev/null)
if [ "$HEALTH" = "healthy" ]; then
    echo "   ✅ Analytics container is healthy"
elif [ "$HEALTH" = "unhealthy" ]; then
    echo "   ❌ Analytics container is unhealthy"
    echo "   Last 3 health check results:"
    docker inspect --format='{{range .State.Health.Log}}{{.Output}}{{end}}' supabase-analytics | tail -3
else
    echo "   ⚠️  Analytics container not running or no health status"
fi

echo ""
echo "5. Checking database (analytics dependency)..."
DB_HEALTH=$(docker inspect --format='{{.State.Health.Status}}' supabase-db 2>/dev/null)
if [ "$DB_HEALTH" = "healthy" ]; then
    echo "   ✅ Database is healthy"
else
    echo "   ❌ Database is not healthy: $DB_HEALTH"
fi

echo ""
echo "6. Testing analytics HTTP endpoint..."
curl -f http://localhost:4000/health 2>/dev/null
if [ $? -eq 0 ]; then
    echo "   ✅ Analytics responding on port 4000"
else
    echo "   ❌ Analytics not responding on port 4000"
fi

echo ""
echo "7. Checking analytics logs (last 20 lines)..."
docker compose logs --tail=20 analytics

echo ""
echo "8. Checking Kong connectivity to analytics..."
docker exec supabase-kong curl -f http://analytics:4000/health 2>/dev/null
if [ $? -eq 0 ]; then
    echo "   ✅ Kong can reach analytics"
else
    echo "   ❌ Kong cannot reach analytics"
fi

echo ""
echo "=== Diagnostic Complete ===="
echo ""
echo "If issues found, run the fix script:"
echo "  ./scripts/fix-supabase-analytics.sh"
