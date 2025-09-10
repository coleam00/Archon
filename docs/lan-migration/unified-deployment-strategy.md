# Unified Deployment Strategy: Environment Variable Control

## Overview

Use a single `DEPLOYMENT_MODE` environment variable to control whether Archon runs in local or LAN mode, eliminating the need for separate configurations.

## Implementation Design

### 1. Core Environment Variables

```bash
# .env file controls everything
DEPLOYMENT_MODE=local  # Options: local | lan

# These adapt based on DEPLOYMENT_MODE
HOST=${HOST:-localhost}
ENABLE_TRAEFIK=${ENABLE_TRAEFIK:-false}
USE_PROXY_NETWORK=${USE_PROXY_NETWORK:-false}
```

### 2. Unified Docker Compose (docker-compose.unified.yml)

```yaml
version: '3.8'

services:
  archon-server:
    build:
      context: ./python
      dockerfile: Dockerfile.server
      args:
        ARCHON_SERVER_PORT: ${ARCHON_SERVER_PORT:-8181}
    container_name: archon-server
    ports:
      # Conditional port binding based on deployment mode
      - "${DEPLOYMENT_MODE:-local}:${DEPLOYMENT_MODE:-local}" == "local:local" && "127.0.0.1:${ARCHON_SERVER_PORT:-8181}:${ARCHON_SERVER_PORT:-8181}" || "0.0.0.0:${ARCHON_SERVER_PORT:-8181}:${ARCHON_SERVER_PORT:-8181}"
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - SERVICE_DISCOVERY_MODE=docker_compose
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
      - DEPLOYMENT_MODE=${DEPLOYMENT_MODE:-local}
      # Dynamic CORS based on deployment mode
      - CORS_ORIGINS=${CORS_ORIGINS:-http://localhost:3737}
    networks:
      - app-network
      # Conditionally add proxy network for LAN mode
      - proxy
    labels:
      # Traefik labels only active when ENABLE_TRAEFIK=true
      - "traefik.enable=${ENABLE_TRAEFIK:-false}"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.archon-api.rule=Host(`${DOMAIN:-archon.mcdonaldhomelab.com}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.archon-api.entrypoints=https"
      - "traefik.http.routers.archon-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.archon-api.loadbalancer.server.port=8181"

  archon-frontend:
    build: 
      context: ./archon-ui-main
      args:
        # Dynamic API URL based on deployment mode
        VITE_API_URL: ${VITE_API_URL:-http://localhost:8181}
    container_name: archon-ui
    ports:
      - "${DEPLOYMENT_MODE:-local}:${DEPLOYMENT_MODE:-local}" == "local:local" && "127.0.0.1:${ARCHON_UI_PORT:-3737}:3737" || "0.0.0.0:${ARCHON_UI_PORT:-3737}:3737"
    environment:
      - VITE_API_URL=${VITE_API_URL:-http://localhost:8181}
      - HOST=${HOST:-localhost}
      - DEPLOYMENT_MODE=${DEPLOYMENT_MODE:-local}
      - VITE_ALLOWED_HOSTS=${VITE_ALLOWED_HOSTS:-}
    networks:
      - app-network
      - proxy
    labels:
      - "traefik.enable=${ENABLE_TRAEFIK:-false}"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.archon.rule=Host(`${DOMAIN:-archon.mcdonaldhomelab.com}`)"
      - "traefik.http.routers.archon.entrypoints=https"
      - "traefik.http.routers.archon.tls.certresolver=letsencrypt"
      - "traefik.http.services.archon.loadbalancer.server.port=3737"

networks:
  app-network:
    driver: bridge
  proxy:
    external: ${USE_PROXY_NETWORK:-false}
```

### 3. Environment File Templates

#### .env.local (Local Development)
```bash
# Deployment Configuration
DEPLOYMENT_MODE=local
ENABLE_TRAEFIK=false
USE_PROXY_NETWORK=false

# Service Configuration
HOST=localhost
VITE_API_URL=http://localhost:8181
CORS_ORIGINS=http://localhost:3737

# Ports (localhost only)
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_UI_PORT=3737

# Database
SUPABASE_URL=https://supabase.mcdonaldhomelab.com
SUPABASE_SERVICE_KEY=your-key-here

# Optional
OPENAI_API_KEY=your-key
LOG_LEVEL=INFO
```

#### .env.lan (LAN Deployment)
```bash
# Deployment Configuration
DEPLOYMENT_MODE=lan
ENABLE_TRAEFIK=true
USE_PROXY_NETWORK=true
DOMAIN=archon.mcdonaldhomelab.com

# Service Configuration  
HOST=archon.mcdonaldhomelab.com
VITE_API_URL=https://archon.mcdonaldhomelab.com/api
CORS_ORIGINS=https://archon.mcdonaldhomelab.com

# Ports (all interfaces)
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_UI_PORT=3737

# Database (internal)
SUPABASE_URL=https://supabase.mcdonaldhomelab.com
SUPABASE_SERVICE_KEY=your-key-here

# Network
VITE_ALLOWED_HOSTS=192.168.0.0/16,10.0.0.0/8

# Optional
OPENAI_API_KEY=your-key
LOG_LEVEL=INFO
```

### 4. Smart Switching Script (deploy.sh)

```bash
#!/bin/bash

# Deployment mode switcher for Archon
set -e

MODE=${1:-local}
COMPOSE_FILE="docker-compose.unified.yml"

case $MODE in
  local)
    echo "🏠 Switching to LOCAL mode..."
    cp .env.local .env
    docker-compose -f $COMPOSE_FILE down
    docker-compose -f $COMPOSE_FILE up -d
    echo "✅ Archon running locally at http://localhost:3737"
    ;;
    
  lan)
    echo "🌐 Switching to LAN mode..."
    
    # Verify Traefik is running
    if ! docker ps | grep -q traefik; then
      echo "❌ Error: Traefik not running. Please start Traefik first."
      exit 1
    fi
    
    # Verify proxy network exists
    if ! docker network ls | grep -q proxy; then
      echo "❌ Error: 'proxy' network not found."
      exit 1
    fi
    
    cp .env.lan .env
    docker-compose -f $COMPOSE_FILE down
    docker-compose -f $COMPOSE_FILE up -d
    echo "✅ Archon running on LAN at https://archon.mcdonaldhomelab.com"
    ;;
    
  status)
    echo "📊 Current deployment status:"
    if [ -f .env ]; then
      MODE=$(grep DEPLOYMENT_MODE .env | cut -d= -f2)
      echo "Mode: $MODE"
    fi
    docker-compose -f $COMPOSE_FILE ps
    ;;
    
  *)
    echo "Usage: $0 {local|lan|status}"
    exit 1
    ;;
esac
```

### 5. Alternative: Docker Compose Override Approach

If conditional syntax in compose files proves complex, use override files:

```bash
# Base configuration
docker-compose.yml

# Local overrides
docker-compose.local.yml

# LAN overrides  
docker-compose.lan.yml

# Usage
docker-compose -f docker-compose.yml -f docker-compose.local.yml up -d
# or
docker-compose -f docker-compose.yml -f docker-compose.lan.yml up -d
```

## Benefits of This Approach

### ✅ Advantages
1. **Single Codebase** - No divergent configurations
2. **Instant Switching** - Change mode in seconds
3. **Easy Testing** - Test LAN config locally first
4. **Git Friendly** - .env files in .gitignore
5. **Rollback Speed** - Switch back immediately if issues
6. **Progressive Migration** - Test one service at a time
7. **Minimal Code Changes** - One-time updates to support env variables, then configuration-driven

### ⚠️ Considerations
1. **Compose Limitations** - Complex conditionals may need wrapper script
2. **Network Modes** - External network must exist for LAN mode
3. **Build Args** - Some values baked in at build time (requires rebuild)

## Implementation Path

### Phase 1: Create Unified Configuration
```bash
# Create environment templates
cp .env.example .env.local
cp .env.example .env.lan

# Test local mode
./deploy.sh local
```

### Phase 2: Test LAN Mode Locally
```bash
# Temporarily use local IPs in .env.lan
HOST=192.168.1.100
./deploy.sh lan
# Test from another machine on network
```

### Phase 3: Production LAN Deployment
```bash
# Update .env.lan with real domain
HOST=archon.mcdonaldhomelab.com
./deploy.sh lan
```

## Rollback Strategy

### Instant Rollback
```bash
# Something wrong with LAN deployment?
./deploy.sh local
# Back to local in <30 seconds
```

### Progressive Rollback
```bash
# Keep some services local, some on LAN
DEPLOYMENT_MODE=hybrid
# Frontend local, backend LAN (custom configuration)
```

## Recommendation

**✅ STRONGLY RECOMMENDED**: This environment variable approach is superior because:

1. **Maintains single source of truth** - One docker-compose file
2. **Reduces complexity** - No parallel configurations
3. **Enables rapid iteration** - Test changes quickly
4. **Simplifies maintenance** - Update one file, affects both modes
5. **Supports gradual migration** - Can run hybrid temporarily

The only scenario where separate files might be better:
- If local and LAN architectures fundamentally differ (different services, volumes, etc.)
- If you need version control separation between environments

For your use case, the unified approach with environment variables is the clear winner!

## Sample .env Structure

```bash
# Master control
DEPLOYMENT_MODE=local|lan

# Computed values (set by deploy script)
if [ "$DEPLOYMENT_MODE" = "lan" ]; then
  export HOST=archon.mcdonaldhomelab.com
  export ENABLE_TRAEFIK=true
  export USE_PROXY_NETWORK=true
  export BIND_ADDRESS=0.0.0.0
else
  export HOST=localhost
  export ENABLE_TRAEFIK=false
  export USE_PROXY_NETWORK=false
  export BIND_ADDRESS=127.0.0.1
fi
```

---

*This approach minimizes code changes and maximizes deployment flexibility!*