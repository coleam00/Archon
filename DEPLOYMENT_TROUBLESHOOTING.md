# Archon Deployment Troubleshooting Guide

## Common Issues and Solutions

### 1. Container Can't Connect to Supabase (Connection Timeout)

**Symptoms:**
```
httpx.ConnectTimeout: timed out
ERROR: Application startup failed. Exiting.
```

**Causes & Solutions:**

#### A. Network Isolation (Most Common on Linux)
**Problem:** Docker containers can't reach host services through `localhost` or `host.docker.internal`

**Solution 1 - Use Docker Bridge Gateway:**
```yaml
# docker-compose.yml
environment:
  - SUPABASE_URL=http://172.17.0.1:54321  # Docker bridge gateway IP
```

**Solution 2 - Share Supabase Network:**
```yaml
# docker-compose.yml
networks:
  app-network:
    external: true
    name: supabase_network_name  # Find with: docker network ls

environment:
  - SUPABASE_URL=http://supabase_kong:8000  # Use container name
```

#### B. Incorrect Host Resolution
**Problem:** `host.docker.internal` doesn't work on Linux

**Solution:**
```yaml
# docker-compose.yml
extra_hosts:
  - "host.docker.internal:host-gateway"  # Let Docker resolve it
```

### 2. Port Conflicts

**Symptoms:**
```
Error response from daemon: driver failed programming external connectivity
Bind for 0.0.0.0:8181 failed: port is already allocated
```

**Solution:**
```bash
# .env - Use different external ports
ARCHON_SERVER_PORT=9282  # Instead of 8181
ARCHON_MCP_PORT=9151     # Instead of 8051
ARCHON_AGENTS_PORT=9152  # Instead of 8052
ARCHON_UI_PORT=4838      # Instead of 3737
```

### 3. DOCKER_HOST Environment Conflicts

**Symptoms:**
```
Cannot connect to the Docker daemon at unix:///run/user/1000/podman/podman.sock
```

**Cause:** System has Podman or custom Docker configuration

**Solution:**
```bash
# Always unset DOCKER_HOST before Docker commands
unset DOCKER_HOST && docker compose up -d

# Or add to ~/.bashrc for permanent fix:
alias docker-compose='unset DOCKER_HOST && docker compose'
```

### 4. Container Health Check Failures

**Symptoms:**
- Container shows as `(unhealthy)` in docker ps
- Services don't respond on expected ports

**Debugging Steps:**
```bash
# Check detailed logs
docker logs Archon-Server --tail=50

# Test internal connectivity
docker exec Archon-Server python -c "import urllib.request; print(urllib.request.urlopen('http://localhost:8181/health').read())"

# Check network connectivity
docker exec Archon-Server ping -c 1 supabase_kong
```

### 5. Supabase Not Accessible

**Symptoms:**
- Can't connect to Supabase from Archon
- API calls timeout

**Debugging:**
```bash
# Find Supabase container name and network
docker ps | grep supabase
docker inspect [supabase_container] | grep NetworkMode

# Test connectivity from host
curl http://localhost:54321/rest/v1/

# Test from Archon container
docker exec Archon-Server curl http://host.docker.internal:54321/rest/v1/
```

### 6. Frontend Can't Connect to Backend

**Symptoms:**
- UI loads but API calls fail
- CORS errors in browser console

**Solution:**
```yaml
# docker-compose.yml - Ensure frontend knows external port
environment:
  - VITE_API_URL=http://localhost:${ARCHON_SERVER_PORT:-8181}
```

### 7. Database Migration Issues

**Symptoms:**
- Tables don't exist errors
- Missing functions or procedures

**Solution:**
```sql
-- Run in Supabase SQL Editor
-- 1. First check if tables exist
SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'archon_%';

-- 2. If missing, run migration
-- Execute contents of migration/complete_setup.sql

-- 3. If partial, reset and retry
-- Execute contents of migration/RESET_DB.sql
-- Then migration/complete_setup.sql
```

## Platform-Specific Issues

### Linux (Ubuntu/Debian)
- `host.docker.internal` doesn't work by default
- Use `host-gateway` or Docker bridge IP (172.17.0.1)
- May need to configure firewall for Docker

### macOS
- `host.docker.internal` works out of the box
- Resource limits may need adjustment in Docker Desktop
- File sharing permissions in Docker Desktop settings

### Windows (WSL2)
- Ensure WSL2 backend is enabled in Docker Desktop
- `host.docker.internal` works but may have firewall issues
- Check Windows Defender firewall rules

## Quick Diagnostic Commands

```bash
# Check all Archon services
docker compose ps

# Check port availability
netstat -tuln | grep -E "8181|8051|8052|3737"

# Test service health
curl http://localhost:${ARCHON_SERVER_PORT:-8181}/health
curl http://localhost:${ARCHON_AGENTS_PORT:-8052}/health

# View real-time logs
docker compose logs -f

# Restart everything
docker compose down && docker compose up -d

# Full reset
docker compose down -v  # Warning: removes volumes
docker compose up --build -d
```

## Environment Variable Reference

```bash
# Required
SUPABASE_URL=           # Your Supabase instance URL
SUPABASE_SERVICE_KEY=   # Service role key (not anon key)

# Optional - Ports (defaults shown)
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737

# Optional - Services
OPENAI_API_KEY=         # For OpenAI models
OLLAMA_HOST=            # For local Ollama
LOG_LEVEL=INFO          # DEBUG for more details
```

## Getting Help

1. Check logs first: `docker compose logs [service-name]`
2. Verify network: `docker network ls` and `docker network inspect`
3. Test connectivity: Use curl or docker exec to test endpoints
4. Check resource usage: `docker stats`
5. Search existing issues on GitHub
6. Create new issue with:
   - Docker version: `docker --version`
   - OS and version
   - Full error logs
   - docker-compose.yml (sanitized)
   - .env (without secrets)

## Common Fixes Summary

| Problem | Quick Fix |
|---------|-----------|
| Connection timeout | Use shared network or bridge IP |
| Port conflict | Change external ports in .env |
| DOCKER_HOST error | Run: `unset DOCKER_HOST` |
| Unhealthy container | Check logs, verify network |
| Frontend API errors | Update VITE_API_URL |
| Database errors | Run migrations |

---

*Remember: Most issues are network-related. When in doubt, check network configuration first!*