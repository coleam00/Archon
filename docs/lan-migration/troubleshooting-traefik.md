# Traefik Routing Troubleshooting Guide

## Common Issues and Solutions

### 404 Not Found Errors

If you're getting 404 errors when accessing `archon.mcdonaldhomelab.com`, check these items:

#### 1. Verify Container Networks
```bash
# Check if containers are on the proxy network
docker inspect archon-ui | grep -A 5 Networks
docker inspect archon-server | grep -A 5 Networks

# Should show both "app-network" and "proxy"
```

#### 2. Check Traefik Discovery
```bash
# View Traefik logs to see if it discovered the services
docker logs traefik | grep archon

# Check Traefik dashboard (if enabled)
# Look for archon-frontend and archon-api routers
```

#### 3. Verify DNS Resolution
```bash
# From your local machine
nslookup archon.mcdonaldhomelab.com

# Should resolve to your LAN server IP
```

#### 4. Test Direct Container Access
```bash
# Test if frontend is running
docker exec archon-ui curl http://localhost:3737

# Test if backend is running
docker exec archon-server curl http://localhost:8181/health
```

#### 5. Check Traefik Labels
```bash
# Verify labels are applied
docker inspect archon-ui | grep -A 20 Labels

# Should show all traefik.* labels
```

## Required Traefik Configuration

Your Traefik instance needs:

1. **Entrypoints defined:**
   - `web` (port 80)
   - `websecure` (port 443)

2. **Let's Encrypt resolver:**
   - Named `letsencrypt` in Traefik config

3. **Docker provider enabled:**
   ```yaml
   providers:
     docker:
       endpoint: unix:///var/run/docker.sock
       exposedByDefault: false
       network: proxy
   ```

## Redeploy After Changes

After updating docker-compose-lan.yml:

```bash
# Stop and remove containers
docker-compose -f docker-compose-lan.yml down

# Rebuild and start
docker-compose -f docker-compose-lan.yml up -d --build

# Watch logs
docker-compose -f docker-compose-lan.yml logs -f
```

## Verify Traefik Routing

Check if Traefik sees your services:

```bash
# Using Traefik API (if enabled)
curl http://traefik.yourdomain.com:8080/api/http/routers | jq '.[] | select(.name | contains("archon"))'

# Check service discovery
curl http://traefik.yourdomain.com:8080/api/http/services | jq '.[] | select(.name | contains("archon"))'
```

## Network Debugging

```bash
# List all Docker networks
docker network ls

# Inspect proxy network
docker network inspect proxy

# Check which containers are on proxy network
docker network inspect proxy | jq '.[0].Containers'

# Test connectivity between containers
docker exec archon-ui ping archon-server
docker exec traefik ping archon-ui
```

## Common Fixes

### Fix 1: Recreate Proxy Network Connection
```bash
# Disconnect and reconnect to proxy network
docker network disconnect proxy archon-ui
docker network connect proxy archon-ui

docker network disconnect proxy archon-server  
docker network connect proxy archon-server
```

### Fix 2: Restart Traefik
```bash
# Restart Traefik to force rediscovery
docker restart traefik
```

### Fix 3: Check Docker Compose Project Name
```bash
# The project name affects network names
# Deploy with explicit project name
docker-compose -p archon -f docker-compose-lan.yml up -d
```

### Fix 4: Validate SSL Certificate
```bash
# Check if Let's Encrypt certificate was issued
openssl s_client -connect archon.mcdonaldhomelab.com:443 -servername archon.mcdonaldhomelab.com
```

## Expected Log Output

### Successful Frontend Access
```
archon-ui logs:
INFO  Accepting connections at http://localhost:3737
HTTP  GET / 
HTTP  Returned 200 in X ms
```

### Successful Traefik Routing
```
traefik logs:
level=debug msg="Router archon-frontend@docker matched"
level=debug msg="Service archon-frontend@docker selected"
```

## Still Having Issues?

1. **Check Traefik version compatibility** - Ensure using Traefik v2.x or v3.x
2. **Verify firewall rules** - Ports 80/443 must be open
3. **Check Docker daemon** - Ensure Docker socket is accessible to Traefik
4. **Review Traefik configuration** - Ensure Docker provider is configured correctly
5. **Test with HTTP first** - Try accessing via HTTP to isolate SSL issues