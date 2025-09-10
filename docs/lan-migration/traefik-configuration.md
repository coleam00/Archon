# Traefik Configuration for Archon

> **Note:** These configuration files were previously built and tested. Use them as examples for your deployment.

## Directory Structure

Your Traefik setup should follow this structure:
```
traefik/
├── docker-compose.yml        # Main Traefik container
└── data/
    ├── config.yml            # Dynamic configuration
    └── traefik.yml           # Static configuration
```

## Configuration Files

### 1. Traefik Docker Compose (`traefik/docker-compose.yml`)

This is your main Traefik container configuration:

```yaml
version: '3.8'

services:
  traefik:
    image: traefik:v3.0
    container_name: traefik
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    networks:
      - proxy
    ports:
      - "80:80"
      - "443:443"
      - "8080:8080"  # Traefik dashboard (optional)
    environment:
      - CF_API_EMAIL=${CF_API_EMAIL}  # If using Cloudflare
      - CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN}  # If using Cloudflare
    volumes:
      - /etc/localtime:/etc/localtime:ro
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./data/traefik.yml:/traefik.yml:ro
      - ./data/config.yml:/config.yml:ro
      - ./data/acme.json:/acme.json
      - ./data/logs:/logs
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.traefik.entrypoints=http"
      - "traefik.http.routers.traefik.rule=Host(`traefik.mcdonaldhomelab.com`)"
      - "traefik.http.middlewares.traefik-auth.basicauth.users=${TRAEFIK_USER}:${TRAEFIK_PASSWORD}"
      - "traefik.http.middlewares.traefik-https-redirect.redirectscheme.scheme=https"
      - "traefik.http.middlewares.sslheader.headers.customrequestheaders.X-Forwarded-Proto=https"
      - "traefik.http.routers.traefik.middlewares=traefik-https-redirect"
      - "traefik.http.routers.traefik-secure.entrypoints=https"
      - "traefik.http.routers.traefik-secure.rule=Host(`traefik.mcdonaldhomelab.com`)"
      - "traefik.http.routers.traefik-secure.middlewares=traefik-auth"
      - "traefik.http.routers.traefik-secure.tls=true"
      - "traefik.http.routers.traefik-secure.tls.certresolver=letsencrypt"
      - "traefik.http.routers.traefik-secure.service=api@internal"

networks:
  proxy:
    external: true
```

### 2. Traefik Static Configuration (`traefik/data/traefik.yml`)

Core Traefik settings:

```yaml
api:
  dashboard: true
  debug: true

entryPoints:
  http:
    address: ":80"
    http:
      redirections:
        entryPoint:
          to: https
          scheme: https
  https:
    address: ":443"

serversTransport:
  insecureSkipVerify: true

providers:
  docker:
    endpoint: "unix:///var/run/docker.sock"
    exposedByDefault: false
    network: proxy
  file:
    filename: /config.yml
    watch: true

certificatesResolvers:
  letsencrypt:
    acme:
      email: your-email@example.com  # Change this!
      storage: acme.json
      keyType: EC256
      httpChallenge:
        entryPoint: http
      # For wildcard certs with DNS challenge (optional):
      # dnsChallenge:
      #   provider: cloudflare
      #   resolvers:
      #     - "1.1.1.1:53"
      #     - "1.0.0.1:53"

log:
  level: INFO
  filePath: /logs/traefik.log

accessLog:
  filePath: /logs/access.log
  bufferingSize: 100
```

### 3. Traefik Dynamic Configuration (`traefik/data/config.yml`)

Additional routing rules and middlewares:

```yaml
http:
  middlewares:
    default-headers:
      headers:
        frameDeny: true
        browserXssFilter: true
        contentTypeNosniff: true
        forceSTSHeader: true
        stsIncludeSubdomains: true
        stsPreload: true
        stsSeconds: 15552000
        customFrameOptionsValue: SAMEORIGIN
        customRequestHeaders:
          X-Forwarded-Proto: https

    secured:
      chain:
        middlewares:
          - default-headers
          - rate-limit

    rate-limit:
      rateLimit:
        average: 100
        burst: 50

    archon-strip-prefix:
      stripPrefix:
        prefixes:
          - "/api"
          - "/mcp"

  routers:
    # Optional: Add any static routes here
    
  services:
    # Optional: Add any external services here

tls:
  options:
    default:
      minVersion: VersionTLS12
      cipherSuites:
        - TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256
        - TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384
        - TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305
        - TLS_AES_128_GCM_SHA256
        - TLS_AES_256_GCM_SHA384
        - TLS_CHACHA20_POLY1305_SHA256
```

## Archon Docker Compose with Environment-Based Deployment

### Unified Deployment Approach

Instead of maintaining separate docker-compose files, use a single configuration with environment variables to control deployment mode:

```yaml
version: '3.8'

services:
  # Backend API Server
  archon-server:
    build:
      context: ./python
      dockerfile: Dockerfile.server
      args:
        ARCHON_SERVER_PORT: ${ARCHON_SERVER_PORT:-8181}
    container_name: archon-server
    restart: unless-stopped
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - LOGFIRE_TOKEN=${LOGFIRE_TOKEN:-}
      - SERVICE_DISCOVERY_MODE=docker_compose
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
      - ARCHON_SERVER_PORT=${ARCHON_SERVER_PORT:-8181}
      - ARCHON_MCP_PORT=${ARCHON_MCP_PORT:-8051}
      - ARCHON_AGENTS_PORT=${ARCHON_AGENTS_PORT:-8052}
      - AGENTS_ENABLED=${AGENTS_ENABLED:-false}
      # CORS configuration - single origin via Traefik
      - CORS_ORIGINS=https://archon.mcdonaldhomelab.com
    networks:
      - proxy
      - archon-internal
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      # API routing
      - "traefik.http.routers.archon-api.rule=Host(`archon.mcdonaldhomelab.com`) && PathPrefix(`/api`)"
      - "traefik.http.routers.archon-api.entrypoints=https"
      - "traefik.http.routers.archon-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.archon-api.loadbalancer.server.port=8181"
      # Strip /api prefix before forwarding to backend
      - "traefik.http.routers.archon-api.middlewares=archon-strip-api"
      - "traefik.http.middlewares.archon-strip-api.stripprefix.prefixes=/api"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${ARCHON_SERVER_PORT:-8181}/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # MCP Server for AI Tool Integration
  archon-mcp:
    build:
      context: ./python
      dockerfile: Dockerfile.mcp
      args:
        ARCHON_MCP_PORT: ${ARCHON_MCP_PORT:-8051}
    container_name: archon-mcp
    restart: unless-stopped
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - LOGFIRE_TOKEN=${LOGFIRE_TOKEN:-}
      - SERVICE_DISCOVERY_MODE=docker_compose
      - TRANSPORT=sse
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
      - API_SERVICE_URL=http://archon-server:${ARCHON_SERVER_PORT:-8181}
      - AGENTS_ENABLED=${AGENTS_ENABLED:-false}
      - AGENTS_SERVICE_URL=http://archon-agents:${ARCHON_AGENTS_PORT:-8052}
      - ARCHON_MCP_PORT=${ARCHON_MCP_PORT:-8051}
    networks:
      - proxy
      - archon-internal
    depends_on:
      - archon-server
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      # MCP routing
      - "traefik.http.routers.archon-mcp.rule=Host(`archon.mcdonaldhomelab.com`) && PathPrefix(`/mcp`)"
      - "traefik.http.routers.archon-mcp.entrypoints=https"
      - "traefik.http.routers.archon-mcp.tls.certresolver=letsencrypt"
      - "traefik.http.services.archon-mcp.loadbalancer.server.port=8051"
      # SSE/WebSocket headers for MCP
      - "traefik.http.routers.archon-mcp.middlewares=mcp-headers"
      - "traefik.http.middlewares.mcp-headers.headers.customresponseheaders.Cache-Control=no-cache"
      - "traefik.http.middlewares.mcp-headers.headers.customresponseheaders.X-Accel-Buffering=no"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${ARCHON_MCP_PORT:-8051}/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Frontend Web UI
  archon-frontend:
    build: 
      context: ./archon-ui-main
      args:
        # Build with production API URL
        VITE_API_URL: https://archon.mcdonaldhomelab.com/api
    container_name: archon-ui
    restart: unless-stopped
    environment:
      - VITE_API_URL=https://archon.mcdonaldhomelab.com/api
      - VITE_ARCHON_SERVER_PORT=${ARCHON_SERVER_PORT:-8181}
      - HOST=archon.mcdonaldhomelab.com
      - VITE_ALLOWED_HOSTS=${VITE_ALLOWED_HOSTS:-}
    networks:
      - proxy
      - archon-internal
    depends_on:
      - archon-server
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      # Frontend routing (root path)
      - "traefik.http.routers.archon.rule=Host(`archon.mcdonaldhomelab.com`)"
      - "traefik.http.routers.archon.entrypoints=https"
      - "traefik.http.routers.archon.tls.certresolver=letsencrypt"
      - "traefik.http.services.archon.loadbalancer.server.port=3737"
      # Security headers
      - "traefik.http.routers.archon.middlewares=secured@file"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3737"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Optional: AI Agents Service
  archon-agents:
    profiles:
      - agents
    build:
      context: ./python
      dockerfile: Dockerfile.agents
      args:
        ARCHON_AGENTS_PORT: ${ARCHON_AGENTS_PORT:-8052}
    container_name: archon-agents
    restart: unless-stopped
    environment:
      - SUPABASE_URL=${SUPABASE_URL}
      - SUPABASE_SERVICE_KEY=${SUPABASE_SERVICE_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY:-}
      - LOGFIRE_TOKEN=${LOGFIRE_TOKEN:-}
      - SERVICE_DISCOVERY_MODE=docker_compose
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
      - ARCHON_AGENTS_PORT=${ARCHON_AGENTS_PORT:-8052}
    networks:
      - archon-internal  # Internal only, no proxy access
    # No Traefik labels - internal service only

networks:
  proxy:
    external: true  # Your existing Traefik network
  archon-internal:
    driver: bridge
    internal: true  # Isolated internal network
```

## Environment Configuration

### Environment-Based Deployment Files

Create two environment templates for easy mode switching:

### `.env.local` - Local Development Mode

```bash
# Deployment Control
DEPLOYMENT_MODE=local
ENABLE_TRAEFIK=false
USE_PROXY_NETWORK=false

# Domain Configuration  
HOST=localhost
SUPABASE_URL=https://supabase.mcdonaldhomelab.com
SUPABASE_SERVICE_KEY=your-service-key-here  # Use service_role key!

# Service Ports (internal)
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737

# Frontend Configuration
VITE_API_URL=http://localhost:8181
CORS_ORIGINS=http://localhost:3737

# Optional
OPENAI_API_KEY=your-openai-key
LOG_LEVEL=INFO
AGENTS_ENABLED=false
```

### `.env.lan` - LAN Deployment Mode with Traefik

```bash
# Deployment Control
DEPLOYMENT_MODE=lan
ENABLE_TRAEFIK=true
USE_PROXY_NETWORK=true

# Domain Configuration
HOST=archon.mcdonaldhomelab.com
DOMAIN=archon.mcdonaldhomelab.com
SUPABASE_URL=https://supabase.mcdonaldhomelab.com
SUPABASE_SERVICE_KEY=your-service-key-here  # Use service_role key!

# Service Ports (internal)
ARCHON_SERVER_PORT=8181
ARCHON_MCP_PORT=8051
ARCHON_AGENTS_PORT=8052
ARCHON_UI_PORT=3737

# Frontend Configuration (HTTPS via Traefik)
VITE_API_URL=https://archon.mcdonaldhomelab.com/api
VITE_ALLOWED_HOSTS=192.168.0.0/16,10.0.0.0/8
CORS_ORIGINS=https://archon.mcdonaldhomelab.com

# Optional
OPENAI_API_KEY=your-openai-key
LOG_LEVEL=INFO
AGENTS_ENABLED=false
```

## Deployment Steps

### Mode Switching Deployment

1. **Create environment templates:**
```bash
cd /path/to/archon
cp .env.example .env.local
cp .env.example .env.lan
# Edit both files with appropriate values
```

2. **Deploy in Local Mode:**
```bash
cp .env.local .env
docker-compose up -d
# Access at http://localhost:3737
```

3. **Switch to LAN Mode with Traefik:**
```bash
# Ensure Traefik is running first
docker network ls | grep proxy  # Verify proxy network exists

cp .env.lan .env
docker-compose down
docker-compose up -d
# Access at https://archon.mcdonaldhomelab.com
```

4. **Instant Rollback to Local:**
```bash
cp .env.local .env
docker-compose down
docker-compose up -d
# Back to localhost in seconds
```

5. **Verify deployment:**
```bash
# Check all containers are running
docker ps

# Test endpoints
curl https://archon.mcdonaldhomelab.com
curl https://archon.mcdonaldhomelab.com/api/health
curl https://archon.mcdonaldhomelab.com/mcp/health
```

## Important Notes

1. **Network Configuration:**
   - The `proxy` network must exist before starting Archon
   - Services on `proxy` network are accessible via Traefik
   - Services on `archon-internal` are isolated from external access

2. **SSL Certificates:**
   - Let's Encrypt will automatically provision certificates
   - First-time provisioning may take a few minutes
   - Check Traefik logs if certificates don't appear: `docker logs traefik`

3. **Path Routing:**
   - Frontend: `https://archon.mcdonaldhomelab.com/`
   - API: `https://archon.mcdonaldhomelab.com/api/*`
   - MCP: `https://archon.mcdonaldhomelab.com/mcp/*`

4. **Troubleshooting:**
   - If services aren't accessible, check: `docker logs traefik`
   - Verify labels with: `docker inspect archon-frontend | grep -A 20 Labels`
   - Test internal connectivity: `docker exec archon-frontend ping archon-server`

5. **Security:**
   - Remove Docker socket mount from Archon if MCP container control not needed
   - Consider adding basic auth to sensitive endpoints
   - Regularly update Traefik and container images

---

*Configuration tested with: Traefik v3.0, Docker 24.0+, Docker Compose v2*  
*Last updated: January 2025*