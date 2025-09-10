# Archon LAN Deployment Guide

## Overview
This guide covers deploying Archon on a LAN server with Traefik proxy integration for domain-based access at `archon.mcdonaldhomelab.com`.

## Prerequisites

### LAN Server Requirements
- Docker and Docker Compose installed
- Traefik proxy already running with external network named `proxy`
- DNS resolution for `archon.mcdonaldhomelab.com` pointing to your LAN server
- Let's Encrypt configured in Traefik for SSL certificates

### Traefik Network Setup
Ensure your Traefik proxy network exists:
```bash
docker network ls | grep proxy
# If missing, create it:
docker network create proxy
```

## Deployment Steps

### 1. Clone and Configure
```bash
# On your LAN server
git clone <archon-repo>
cd Archon

# Copy LAN environment template
cp .env.lan.example .env
```

### 2. Configure Environment
Edit `.env` with your Supabase credentials:
```bash
# Required - replace with your actual values
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-here

# Optional - can be set via UI later
OPENAI_API_KEY=your-openai-key-optional
LOGFIRE_TOKEN=your-logfire-token-optional
```

**Note**: Domain configuration is hardcoded in `docker-compose-lan.yml` - no environment variables needed.

### 3. Deploy with LAN Configuration
```bash
# Deploy with standalone LAN configuration
docker-compose -f docker-compose-lan.yml up -d

# Verify services are running
docker-compose ps

# Check logs if needed
docker-compose logs -f
```

### 4. Verify Deployment
```bash
# Test API health endpoint
curl -k https://archon.mcdonaldhomelab.com/api/health

# Test frontend access
curl -k https://archon.mcdonaldhomelab.com

# Access Archon at: https://archon.mcdonaldhomelab.com
```

## Architecture Details

### Network Configuration
- **External Access**: Traefik proxy handles all external routing and SSL termination
- **Internal Communication**: Services communicate via `app-network` Docker network
- **Security**: No direct port mappings, all access controlled by Traefik

### Service Routing
| Service | External URL | Internal Port | Traefik Labels |
|---------|--------------|---------------|----------------|
| Frontend | `archon.mcdonaldhomelab.com` | 3737 | ✅ Enabled |
| API | `archon.mcdonaldhomelab.com/api/*` | 8181 | ✅ Enabled (strips `/api`) |
| MCP | N/A (internal only) | 8051 | ❌ Internal only |
| Agents | N/A (internal only) | 8052 | ❌ Internal only |

### SSL/TLS Configuration
- **Automatic**: Traefik handles Let's Encrypt certificate generation
- **Domain**: `archon.mcdonaldhomelab.com` 
- **Renewal**: Automatic via Traefik configuration

## Configuration Files

### docker-compose-lan.yml Key Features
```yaml
services:
  archon-server:
    # No port mapping - Traefik handles external access
    expose: ["8181"]
    networks:
      - app-network
      - proxy  # Connect to Traefik
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.archon-api.rule=Host(`archon.mcdonaldhomelab.com`) && PathPrefix(`/api`)"
      # ... SSL and routing labels
```

### Environment Variables (Hardcoded in docker-compose-lan.yml)
```yaml
environment:
  - HOST=archon.mcdonaldhomelab.com
  - BIND_IP=0.0.0.0
  - CORS_ORIGINS=https://archon.mcdonaldhomelab.com
  - API_BASE_URL=https://archon.mcdonaldhomelab.com/api
```

## Maintenance

### Viewing Logs
```bash
# All services
docker-compose -f docker-compose-lan.yml logs -f

# Specific service
docker-compose -f docker-compose-lan.yml logs -f archon-server
```

### Updating Deployment
```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose -f docker-compose-lan.yml up -d --build
```

### Stopping Services
```bash
# Stop all services
docker-compose -f docker-compose-lan.yml down

# Stop and remove volumes (careful - this removes data)
docker-compose -f docker-compose-lan.yml down -v
```

## Troubleshooting

### Common Issues

**SSL Certificate Not Generated**
- Check Traefik logs: `docker logs <traefik-container>`
- Verify DNS resolution: `nslookup archon.mcdonaldhomelab.com`
- Ensure port 80/443 accessible for Let's Encrypt challenge

**API Requests Failing**
- Check API health: `curl -k https://archon.mcdonaldhomelab.com/api/health`
- Verify Traefik routing: Check Traefik dashboard
- Review server logs: `docker-compose logs archon-server`

**Frontend Not Loading**
- Check frontend health: `docker-compose logs archon-frontend`
- Verify build process completed successfully
- Test direct container access: `docker exec archon-ui curl http://localhost:3737`

**Service Communication Issues**
- Verify internal network: `docker network inspect archon_app-network`
- Check service discovery: Review environment variables in containers
- Test internal connectivity: `docker exec archon-server ping archon-mcp`

### Health Checks
All services include health checks accessible via:
```bash
# Check container health status
docker-compose ps

# View health check details
docker inspect archon-server --format='{{.State.Health}}'
```

## Security Considerations

### Network Isolation
- MCP and Agents services are internal-only (no Traefik labels)
- All external access controlled through Traefik proxy
- No direct port mappings expose services to host network

### SSL/TLS
- All external communication encrypted via HTTPS
- Let's Encrypt certificates automatically managed
- Internal service communication over Docker networks

### Environment Variables
- Sensitive data (Supabase keys) in `.env` file only
- No secrets hardcoded in Docker Compose files
- API keys can be managed via Archon UI after deployment

## Comparison: Developer vs LAN Deployment

| Aspect | Developer (`docker-compose up`) | LAN Server (`docker-compose -f docker-compose-lan.yml up -d`) |
|--------|--------------------------------|----------------------------------------------------------------------|
| **Access** | `http://localhost:3737` | `https://archon.mcdonaldhomelab.com` |
| **Ports** | Direct port mappings (3737, 8181, 8051) | No port mappings (Traefik only) |
| **SSL** | None (HTTP only) | Let's Encrypt via Traefik |
| **Network** | `app-network` only | `app-network` + external `proxy` |
| **Configuration** | Defaults + minimal `.env` | Hardcoded domain values |
| **Security** | Local development only | Production-ready with Traefik |