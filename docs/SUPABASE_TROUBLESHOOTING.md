# Supabase Analytics Troubleshooting Guide

## Problem: Kong Returns 502 Errors for Analytics

**Symptoms:**
- Kong logs show: `connect() failed (111: Connection refused) while connecting to upstream`
- Target: `http://172.20.0.10:4000/api/logs`
- Multiple services stuck in "starting" state
- Supabase Studio may not load properly
- Archon cannot connect to Supabase (404 or connection errors)

## Quick Fix

Run the automated fix script from the Archon directory:

```bash
cd a:/Experiment/archon
./scripts/fix-supabase-analytics.sh
```

Then verify the connection:

```bash
./scripts/verify-supabase-connection.sh
```

## Root Causes & Solutions

### 1. Missing .env File

**Check:**
```bash
cd A:/Experiment/supabase/supabase-project
ls -la .env
```

**Fix:**
```bash
cd A:/Experiment/supabase/supabase-project
cp .env.example .env
# Edit .env and set all required values (see below)
```

**Required .env Values:**
- `POSTGRES_PASSWORD`: Secure password (32+ characters)
- `JWT_SECRET`: Secure JWT secret (32+ characters)
- `SECRET_KEY_BASE`: Secure base key (32+ characters)
- `VAULT_ENC_KEY`: Encryption key (32+ characters)
- `LOGFLARE_PUBLIC_ACCESS_TOKEN`: Unique token (must differ from private)
- `LOGFLARE_PRIVATE_ACCESS_TOKEN`: Different unique token
- `DASHBOARD_USERNAME`: Admin username
- `DASHBOARD_PASSWORD`: Secure password

⚠️ **CRITICAL**: `LOGFLARE_PUBLIC_ACCESS_TOKEN` and `LOGFLARE_PRIVATE_ACCESS_TOKEN` **MUST** be different values!

### 2. Analytics Container Not Running

**Check:**
```bash
cd A:/Experiment/supabase/supabase-project
docker compose ps analytics
```

**Fix:**
```bash
docker compose up -d analytics
docker compose logs -f analytics
```

### 3. Analytics Container Unhealthy

**Check:**
```bash
docker inspect --format='{{.State.Health.Status}}' supabase-analytics
```

**Common Causes:**

#### a) Database Not Ready
Analytics depends on Postgres being healthy.

```bash
# Check DB health
docker inspect --format='{{.State.Health.Status}}' supabase-db

# If unhealthy, restart DB first
cd A:/Experiment/supabase/supabase-project
docker compose restart db
# Wait for healthy status
until [ "$(docker inspect --format='{{.State.Health.Status}}' supabase-db)" = "healthy" ]; do sleep 2; done

# Then restart analytics
docker compose restart analytics
```

#### b) Invalid LOGFLARE Tokens

```bash
cd A:/Experiment/supabase/supabase-project
source .env
echo "Public: $LOGFLARE_PUBLIC_ACCESS_TOKEN"
echo "Private: $LOGFLARE_PRIVATE_ACCESS_TOKEN"

# They must be:
# 1. Not empty
# 2. Not default values from .env.example
# 3. Different from each other
```

#### c) Port 4000 Already in Use

```bash
# Check what's using port 4000
netstat -ano | findstr :4000  # Windows
lsof -i :4000                  # Linux/Mac

# If another service is using it, either:
# 1. Stop that service, OR
# 2. Change analytics port in docker-compose.yml:
#    ports:
#      - "4001:4000"  # Map to different host port
```

### 4. Network Connectivity Issues

**Check:**
```bash
# Test from host
curl http://localhost:4000/health

# Test from Kong container
docker exec supabase-kong curl http://analytics:4000/health
```

**Fix:**
```bash
cd A:/Experiment/supabase/supabase-project
# Recreate network
docker compose down
docker network prune -f
docker compose up -d
```

### 5. Vector Service Issues

Vector collects logs and sends them to analytics. If Vector fails, analytics may not initialize properly.

**Check:**
```bash
cd A:/Experiment/supabase/supabase-project
docker compose ps vector
docker compose logs vector
```

**Fix:**
```bash
docker compose restart vector
```

## Complete Reset Procedure

If all else fails, perform a complete reset:

```bash
cd A:/Experiment/supabase/supabase-project

# 1. Stop all services
docker compose down

# 2. Remove volumes (⚠️ DELETES ALL DATA)
docker compose down -v

# 3. Ensure .env is properly configured
cat .env | grep LOGFLARE

# 4. Start services in order
docker compose up -d vector
sleep 5
docker compose up -d db
# Wait for DB healthy
until [ "$(docker inspect --format='{{.State.Health.Status}}' supabase-db)" = "healthy" ]; do sleep 2; done

docker compose up -d analytics
# Wait for analytics healthy
until [ "$(docker inspect --format='{{.State.Health.Status}}' supabase-analytics)" = "healthy" ]; do sleep 2; done

# 5. Start remaining services
docker compose up -d
```

## Verification Steps

After applying fixes:

```bash
# 1. Check all Supabase services are running
cd A:/Experiment/supabase/supabase-project
docker compose ps

# 2. Check analytics health
curl http://localhost:4000/health
# Expected: {"status":"ok"} or similar

# 3. Check Kong can reach analytics
docker exec supabase-kong curl http://analytics:4000/health

# 4. Check Kong logs for errors
docker compose logs kong | grep -i error
# Should see no more "Connection refused" errors

# 5. Access Supabase Studio
# Open: http://localhost:54323
# Should load without errors

# 6. Verify Archon can connect
cd a:/Experiment/archon
./scripts/verify-supabase-connection.sh
```

## Integration with Archon

Archon connects to Supabase via Kong gateway on port 8000.

**Verify Archon Configuration:**
```bash
cd a:/Experiment/archon
cat .env | grep SUPABASE_URL
# Should show: SUPABASE_URL=http://localhost:8000
```

**Test Archon → Supabase Connectivity:**
```bash
# From Archon directory
curl http://localhost:8000/rest/v1/
# Should return API info, not 404
```

## Useful Commands

```bash
# Diagnose Supabase issues (from Archon directory)
cd a:/Experiment/archon
./scripts/diagnose-supabase.sh

# Fix Supabase analytics (from Archon directory)
./scripts/fix-supabase-analytics.sh

# Verify Archon → Supabase connection
./scripts/verify-supabase-connection.sh

# View all Supabase container health statuses
cd A:/Experiment/supabase/supabase-project
docker compose ps

# Follow analytics logs in real-time
docker compose logs -f analytics

# Check analytics container details
docker inspect supabase-analytics

# Restart specific service
docker compose restart analytics

# View network configuration
docker network inspect supabase_default

# Check environment variables in container
docker exec supabase-analytics env | grep LOGFLARE
```

## Getting Help

If issues persist:

1. Run diagnostic script: `cd a:/Experiment/archon && ./scripts/diagnose-supabase.sh`
2. Collect logs: `cd A:/Experiment/supabase/supabase-project && docker compose logs > supabase-logs.txt`
3. Check Supabase GitHub issues: https://github.com/supabase/supabase/issues
4. Review Supabase self-hosting docs: https://supabase.com/docs/guides/self-hosting