# Archon LAN Deployment

Quick setup guide for deploying Archon on your LAN with Traefik proxy integration.

## Quick Start

### Prerequisites
- Docker & Docker Compose installed on LAN server
- Traefik proxy running with `proxy` network
- DNS: `archon.yourDomain.com` → LAN server IP

### Deploy
```bash
# Clone repository
git clone <repo-url>
cd Archon

# Configure environment
cp .env.unified.lan .env
# Edit .env with your Supabase credentials

# Deploy with unified configuration
docker-compose -f docker-compose.unified.yml up -d

# Access at: https://archon.yourDomain.com
```

## What This Gives You

### 🌐 Production-Ready LAN Access
- **HTTPS with SSL**: Automatic Let's Encrypt certificates via Traefik
- **Domain Access**: `https://archon.yourDomain.com`
- **Path Routing**: 
  - Frontend at `/`
  - API at `/api/*`
  - MCP server at port 8051 (for AI IDE connections)
- **Flexible Security**: Services exposed through configurable bind IPs

### 🔒 Modern Architecture  
- **Service Exposure**: All core services accessible:
  - Frontend (3737)
  - API Server (8181)
  - MCP Server (8051) - For Claude, Cursor, Windsurf connections
  - Agents Service (8052) - Optional, when enabled
- **SSL Termination**: All external traffic encrypted via Traefik
- **Service Discovery**: Containers communicate via internal Docker network
- **Access Control**: Traefik handles routing and SSL certificates

### 🚀 Unified Configuration
- **Shared Environment Variables**: Both dev and LAN use same `.env` variables
- **Default Localhost**: Development defaults to `BIND_IP=127.0.0.1` (localhost only)
- **Easy LAN Access**: Set `BIND_IP=0.0.0.0` to expose services on LAN
- **Same Configuration**: Unified approach across development and production

## Architecture

```
Internet → Traefik Proxy → Docker Networks
                        ├── archon-frontend:3737 (/)
                        ├── archon-server:8181 (/api/*)  
                        ├── archon-mcp:8051 (exposed for AI IDEs)
                        └── archon-agents:8052 (optional, when enabled)
```

**Key Changes from Legacy Architecture:**
- **MCP Server (8051) now exposed** for direct AI IDE connections (Claude, Cursor, Windsurf)
- **All services accessible** through configurable `BIND_IP` setting
- **Flexible deployment** supports both localhost-only and LAN-wide access

## Files Overview

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Developer localhost deployment |
| `docker-compose.unified.yml` | Unified deployment for LAN/production |  
| `.env.unified.lan` | LAN environment configuration |
| `.env.unified.local` | Local development configuration |
| `traefik/` | Traefik reverse proxy configuration |

## Key Differences: Dev vs LAN

| Aspect | Developer | LAN Server |
|--------|-----------|------------|
| **Access** | `http://localhost:3737` | `https://archon.yourDomain.com` |
| **Security** | HTTP, localhost only | HTTPS, LAN-wide access |  
| **Network** | Local ports (127.0.0.1) | LAN-accessible ports (0.0.0.0) |
| **SSL** | None | Let's Encrypt via Traefik |
| **MCP Access** | `localhost:8051` | `yourDomain.com:8051` (for AI IDEs) |
| **Command** | `docker-compose up` | `docker-compose -f docker-compose.unified.yml up -d` |

## Configuration Notes

### Environment Variables
- **BIND_IP**: Controls service exposure
  - `127.0.0.1` = localhost only (default)
  - `0.0.0.0` = LAN-wide access
  - Empty = all interfaces
- **HOST**: Domain name for your deployment
- **CORS_ORIGINS**: Frontend access permissions

### MCP Server Access
The MCP server (port 8051) is now exposed for AI IDE connections:
- **Local**: `http://localhost:8051/mcp`
- **LAN**: `http://your-server-ip:8051/mcp`
- **Domain**: `https://archon.yourDomain.com:8051/mcp` (if SSL configured)

## Next Steps

1. **Environment Setup**: Copy and configure `.env.unified.lan`
2. **Traefik Setup**: Configure reverse proxy using `traefik/` directory
3. **DNS Configuration**: Point your domain to the server IP
4. **Deploy**: Run `docker-compose -f docker-compose.unified.yml up -d`

## Support

For issues or questions:
- Review Docker Compose logs: `docker-compose -f docker-compose.unified.yml logs -f`
- Check service health: `docker-compose -f docker-compose.unified.yml ps`
- Verify port accessibility and DNS resolution
- Ensure Traefik proxy network exists