#!/bin/bash

set -e

SUPABASE_DIR="A:/Experiment/supabase/supabase-project"

echo "=== Supabase Analytics Fix Script ==="
echo ""

echo "Checking Supabase directory..."
if [ ! -d "$SUPABASE_DIR" ]; then
    echo "   ❌ Supabase directory not found: $SUPABASE_DIR"
    echo "   Please update SUPABASE_DIR variable in this script"
    exit 1
fi

cd "$SUPABASE_DIR" || exit 1
echo "   Working in: $(pwd)"

echo ""
echo "Step 1: Stopping all Supabase services..."
docker compose down

echo ""
echo "Step 2: Checking .env file..."
if [ ! -f ".env" ]; then
    echo "   Creating .env from .env.example..."
    cp .env.example .env
    echo "   ⚠️  IMPORTANT: Edit .env and set secure passwords and tokens!"
    echo "   Required changes:"
    echo "     - POSTGRES_PASSWORD (secure, 32+ chars)"
    echo "     - JWT_SECRET (secure, 32+ chars)"
    echo "     - SECRET_KEY_BASE (secure, 32+ chars)"
    echo "     - VAULT_ENC_KEY (secure, 32+ chars)"
    echo "     - LOGFLARE_PUBLIC_ACCESS_TOKEN (unique token)"
    echo "     - LOGFLARE_PRIVATE_ACCESS_TOKEN (different unique token)"
    echo "     - DASHBOARD_PASSWORD (secure password)"
    echo ""
    echo "   Opening .env file for editing..."
    
    # Try to open with common editors
    if command -v code &> /dev/null; then
        code .env
    elif command -v notepad &> /dev/null; then
        notepad .env
    else
        echo "   Please edit .env manually: $SUPABASE_DIR/.env"
    fi
    
    echo ""
    read -p "Press Enter after editing .env file..."
fi

echo ""
echo "Step 3: Validating LOGFLARE tokens..."
source .env
if [ "$LOGFLARE_PUBLIC_ACCESS_TOKEN" = "$LOGFLARE_PRIVATE_ACCESS_TOKEN" ]; then
    echo "   ❌ ERROR: LOGFLARE_PUBLIC_ACCESS_TOKEN and LOGFLARE_PRIVATE_ACCESS_TOKEN must be different!"
    exit 1
fi
if [ "$LOGFLARE_PUBLIC_ACCESS_TOKEN" = "your-super-secret-and-long-logflare-key-public" ]; then
    echo "   ❌ ERROR: LOGFLARE_PUBLIC_ACCESS_TOKEN still has default value!"
    exit 1
fi
echo "   ✅ LOGFLARE tokens configured"

echo ""
echo "Step 4: Removing old volumes (optional - preserves data by default)..."
read -p "Remove old volumes? This will DELETE all data! (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    docker compose down -v
    echo "   ✅ Volumes removed"
else
    echo "   ℹ️  Keeping existing volumes"
fi

echo ""
echo "Step 5: Starting services in order..."
echo "   Starting vector (log collector)..."
docker compose up -d vector
sleep 5

echo "   Starting database..."
docker compose up -d db
echo "   Waiting for database to be healthy..."
until [ "$(docker inspect --format='{{.State.Health.Status}}' supabase-db)" = "healthy" ]; do
    echo "   Waiting for db..."
    sleep 2
done
echo "   ✅ Database is healthy"

echo "   Starting analytics..."
docker compose up -d analytics
echo "   Waiting for analytics to be healthy..."
COUNT=0
until [ "$(docker inspect --format='{{.State.Health.Status}}' supabase-analytics)" = "healthy" ]; do
    echo "   Waiting for analytics... ($COUNT/30)"
    sleep 2
    COUNT=$((COUNT+1))
    if [ $COUNT -gt 30 ]; then
        echo "   ❌ Analytics failed to become healthy after 60 seconds"
        echo "   Checking logs:"
        docker compose logs analytics
        exit 1
    fi
done
echo "   ✅ Analytics is healthy"

echo ""
echo "Step 6: Starting remaining services..."
docker compose up -d

echo ""
echo "Step 7: Verifying analytics connectivity..."
sleep 5
curl -f http://localhost:4000/health
if [ $? -eq 0 ]; then
    echo "   ✅ Analytics responding on port 4000"
else
    echo "   ❌ Analytics not responding"
    exit 1
fi

echo ""
echo "=== Fix Complete ==="
echo "All Supabase services should now be running. Check status with:"
echo "  cd $SUPABASE_DIR && docker compose ps"
echo ""
echo "Access Supabase Studio at: http://localhost:54323"
echo "Kong API Gateway at: http://localhost:8000"
echo ""
echo "Now verify Archon can connect to Supabase:"
echo "  cd a:/Experiment/archon && ./scripts/verify-supabase-connection.sh"
