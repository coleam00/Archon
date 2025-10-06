# Docker Networking Guide: Connecting Archon to Supabase

## Overview

Archon needs to connect to Supabase during startup to load credentials and configuration from the database. When both services run in Docker containers, proper network configuration is critical.

## Problem: Connection Refused Errors

**Symptoms:**
- `archon-server` container fails health check
- Logs show: `httpx.ConnectError: [Errno 111] Connection refused`
- Error occurs during startup when loading credentials
- Container status shows "unhealthy"

**Root Cause:**
The archon-server container cannot reach the Supabase Kong gateway because:
1. Wrong network configuration in docker-compose.yml
2. Incorrect SUPABASE_URL in .env file
3. Supabase containers not running

## Solution: Automatic Configuration

### Quick Fix (Recommended)

Run the automatic configuration script:

```bash
cd a:/Experiment/archon

# Ensure Supabase is running first
cd A:/Experiment/supabase/supabase-project
docker compose up -d
cd -

# Auto-configure Archon
bash scripts/auto-configure-supabase.sh

# Verify configuration
bash scripts/preflight-check.sh

# Start Archon
docker compose up -d
```

This script will:
1. Detect your Supabase Docker network name
2. Identify the Kong service name
3. Update your .env file with the correct SUPABASE_URL
4. Update docker-compose.yml with the correct network configuration
5. Create backups of modified files

### Manual Configuration

If you prefer to configure manually:

#### Step 1: Detect Supabase Network

```bash
# Find the Kong container
docker ps | grep kong

# Get the network name (replace <kong-container-name> with actual name)
docker inspect <kong-container-name> --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}}{{end}}'
```

Example output: `supabase-project_default` or `supabase_default`

#### Step 2: Detect Kong Service Name

```bash
cd A:/Experiment/supabase/supabase-project
docker compose ps --format json | grep -i kong
```

Look for the "Service" field. Common names: `kong`, `supabase-kong`, `api`

#### Step 3: Update .env File

Edit `a:/Experiment/archon/.env`:

```bash
# Replace <kong-service-name> with the actual service name from Step 2
SUPABASE_URL=http://<kong-service-name>:8000
```

**Examples:**
```bash
# If service name is "kong"
SUPABASE_URL=http://kong:8000

# If service name is "supabase-kong"
SUPABASE_URL=http://supabase-kong:8000
```

#### Step 4: Update docker-compose.yml

Edit `a:/Experiment/archon/docker-compose.yml`:

1. Find the `networks` section at the bottom:

```yaml
networks:
  app-network:
    driver: bridge
  supabase_default:  # ← Replace this name
    external: true
```

2. Replace `supabase_default` with your actual network name from Step 1:

```yaml
networks:
  app-network:
    driver: bridge
  supabase-project_default:  # ← Your actual network name
    external: true
```

3. Ensure `archon-server` service includes both networks:

```yaml
services:
  archon-server:
    # ... other config ...
    networks:
      - app-network
      - supabase-project_default  # ← Must match network name above
```

#### Step 5: Verify Configuration

```bash
cd a:/Experiment/archon

# Test connectivity from the Supabase network
docker run --rm --network <your-supabase-network> curlimages/curl:latest \
  curl -s -o /dev/null -w "%{http_code}" http://<kong-service-name>:8000/rest/v1/
```

Expected result: `200` or `401` (both indicate successful connection)

#### Step 6: Start Archon

```bash
# Stop any existing containers
docker compose down

# Start with fresh configuration
docker compose up -d

# Monitor logs
docker compose logs -f archon-server
```

## Common Mistakes

### ❌ Using localhost or 127.0.0.1

```bash
# WRONG - doesn't work from Docker containers
SUPABASE_URL=http://localhost:8000
SUPABASE_URL=http://127.0.0.1:8000
```

**Why it fails:** `localhost` inside a Docker container refers to the container itself, not the host machine.

### ❌ Using host.docker.internal

```bash
# WORKS but not recommended
SUPABASE_URL=http://host.docker.internal:8000
```

**Why it's not ideal:**
- Adds extra network hop (container → host → container)
- Slower than direct container-to-container communication
- May not work on all Docker configurations (Linux)
- Requires extra_hosts configuration

### ❌ Wrong Network Name

```yaml
# WRONG - guessing the network name
networks:
  supabase_default:  # May not exist
    external: true
```

**Why it fails:** Docker Compose creates network names based on the project directory name. If your Supabase project is in a directory called `supabase-project`, the network will be `supabase-project_default`, not `supabase_default`.

### ❌ Wrong Port Number

```bash
# WRONG - Studio port, not API gateway
SUPABASE_URL=http://kong:54323

# WRONG - Direct PostgREST port
SUPABASE_URL=http://kong:3000
```

**Correct:** Kong gateway runs on port `8000` (default Supabase configuration)

## Troubleshooting

### Check if Supabase is Running

```bash
docker ps | grep -E "kong|supabase"
```

You should see multiple containers including:
- Kong (API gateway)
- PostgreSQL (database)
- GoTrue (auth)
- PostgREST (API)
- Storage
- Realtime

### Check Network Connectivity

```bash
# Get Supabase network name
SUPABASE_NETWORK=$(docker inspect supabase-kong --format '{{range $key, $value := .NetworkSettings.Networks}}{{$key}}{{end}}')

# Test from that network
docker run --rm --network "$SUPABASE_NETWORK" curlimages/curl:latest \
  curl -v http://kong:8000/rest/v1/
```

### Check archon-server Logs

```bash
# View startup logs
docker compose logs archon-server

# Follow logs in real-time
docker compose logs -f archon-server

# Check last 50 lines
docker compose logs --tail=50 archon-server
```

**Look for:**
- `Connection refused` → Network configuration issue
- `Name or service not known` → Wrong service name in SUPABASE_URL
- `401 Unauthorized` → Connection works, but wrong API key (check SUPABASE_SERVICE_KEY)
- `404 Not Found` → Wrong port or path in SUPABASE_URL

### Verify Environment Variables

```bash
# Check what archon-server sees
docker exec archon-server env | grep SUPABASE
```

### Test from Inside archon-server Container

```bash
# Get a shell inside the container
docker exec -it archon-server bash

# Test DNS resolution
ping -c 1 kong

# Test HTTP connectivity
curl -v http://kong:8000/rest/v1/

# Exit container
exit
```

## Advanced: Multiple Supabase Instances

If you have multiple Supabase instances (local + cloud), you can switch between them:

### Local Supabase

```bash
# .env
SUPABASE_URL=http://kong:8000
SUPABASE_SERVICE_KEY=<local-service-role-key>
```

```yaml
# docker-compose.yml
networks:
  app-network:
    driver: bridge
  supabase-project_default:
    external: true
```

### Cloud Supabase

```bash
# .env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=<cloud-service-role-key>
```

```yaml
# docker-compose.yml
networks:
  app-network:
    driver: bridge
  # No external network needed for cloud
```

## Diagnostic Scripts

Archon provides several scripts to help diagnose and fix networking issues:

### detect-supabase-network.sh

Detects your Supabase network configuration:

```bash
bash scripts/detect-supabase-network.sh
```

Outputs:
- Supabase network name
- Kong service name
- Recommended configuration

### auto-configure-supabase.sh

Automatically configures Archon to connect to Supabase:

```bash
bash scripts/auto-configure-supabase.sh
```

Actions:
- Detects Supabase configuration
- Updates .env file
- Updates docker-compose.yml
- Creates backups
- Tests connectivity

### preflight-check.sh

Validates your setup before starting Archon:

```bash
bash scripts/preflight-check.sh
```

Checks:
- .env file exists and has required variables
- Docker is running
- Supabase containers are running
- Network configuration is correct
- Ports are available
- Connectivity works

### verify-supabase-connection.sh

Tests Supabase connectivity from the host:

```bash
bash scripts/verify-supabase-connection.sh
```

Tests:
- REST API endpoint
- Auth API endpoint
- Authenticated requests
- Kong gateway status
- Analytics service status

## Getting Help

If you're still experiencing issues:

1. **Run all diagnostic scripts:**
   ```bash
   bash scripts/detect-supabase-network.sh
   bash scripts/preflight-check.sh
   bash scripts/verify-supabase-connection.sh
   ```

2. **Collect logs:**
   ```bash
   docker compose logs > archon-logs.txt
   cd A:/Experiment/supabase/supabase-project
   docker compose logs > supabase-logs.txt
   ```

3. **Check network details:**
   ```bash
   docker network ls
   docker network inspect <your-supabase-network>
   ```

4. **Verify Docker version:**
   ```bash
   docker --version
   docker compose version
   ```

5. **Open an issue** with:
   - Output from diagnostic scripts
   - Relevant log files
   - Docker version
   - Operating system
   - Network configuration
